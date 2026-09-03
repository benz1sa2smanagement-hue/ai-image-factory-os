import { describe, it, expect } from 'vitest';
import { MemoryD1 } from './memory-d1.js';
import { d1Reserve, d1Commit, d1Release, loadQuotaById } from './quota-d1.js';
import { assertZeroCost, FACTORY_CONSTITUTION } from './policy.js';
import { availableUnits } from './quota.js';

function seed(limit = 100) {
  const db = new MemoryD1();
  db.seedQuota({
    id: 'cf_workers_ai_daily',
    provider_id: 'cf_workers_ai',
    model_id: '@cf/black-forest-labs/flux-1-schnell',
    window: 'daily',
    limit_units: limit,
    used_units: 0,
    reserved_units: 0,
  });
  return db;
}

describe('D1 quota reserve/commit/release', () => {
  it('reserves when capacity exists', async () => {
    const db = seed(100);
    const r = await d1Reserve({
      db,
      providerId: 'cf_workers_ai',
      modelId: '@cf/black-forest-labs/flux-1-schnell',
      units: 44,
      jobId: 'job_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.idempotent).toBe(false);
    expect(r.snapshot.reservedUnits).toBe(44);
    expect(availableUnits(r.snapshot)).toBe(56);
  });

  it('rejects when insufficient (no negative)', async () => {
    const db = seed(50);
    const a = await d1Reserve({ db, providerId: 'cf_workers_ai', units: 40, jobId: 'j_a' });
    expect(a.ok).toBe(true);
    const b = await d1Reserve({ db, providerId: 'cf_workers_ai', units: 20, jobId: 'j_b' });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toBe('INSUFFICIENT_QUOTA');
    const row = await loadQuotaById(db, 'cf_workers_ai_daily');
    expect(Number(row?.reserved_units)).toBe(40);
    expect(Number(row?.used_units)).toBe(0);
  });

  it('idempotent reserve by jobId (no double reservation)', async () => {
    const db = seed(100);
    const a = await d1Reserve({ db, providerId: 'cf_workers_ai', units: 10, jobId: 'same_job' });
    const b = await d1Reserve({ db, providerId: 'cf_workers_ai', units: 10, jobId: 'same_job' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.idempotent).toBe(true);
    expect(a.reservationId).toBe(b.reservationId);
    const row = await loadQuotaById(db, 'cf_workers_ai_daily');
    expect(Number(row?.reserved_units)).toBe(10);
  });

  it('idempotent reserve by idempotency_key', async () => {
    const db = seed(100);
    const a = await d1Reserve({
      db,
      providerId: 'cf_workers_ai',
      units: 5,
      idempotencyKey: 'idem-1',
      jobId: 'j1',
    });
    const b = await d1Reserve({
      db,
      providerId: 'cf_workers_ai',
      units: 5,
      idempotencyKey: 'idem-1',
      jobId: 'j1-retry',
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.idempotent).toBe(true);
    const row = await loadQuotaById(db, 'cf_workers_ai_daily');
    expect(Number(row?.reserved_units)).toBe(5);
  });

  it('commit moves reserved → used once', async () => {
    const db = seed(100);
    const r = await d1Reserve({ db, providerId: 'cf_workers_ai', units: 20, jobId: 'jc' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c1 = await d1Commit({ db, reservationId: r.reservationId, quotaId: r.quotaId });
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    expect(c1.alreadyDone).toBe(false);
    const c2 = await d1Commit({ db, reservationId: r.reservationId, quotaId: r.quotaId });
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(c2.alreadyDone).toBe(true);
    const row = await loadQuotaById(db, 'cf_workers_ai_daily');
    expect(Number(row?.used_units)).toBe(20);
    expect(Number(row?.reserved_units)).toBe(0);
  });

  it('release frees reserved without used', async () => {
    const db = seed(100);
    const r = await d1Reserve({ db, providerId: 'cf_workers_ai', units: 15, jobId: 'jr' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rel = await d1Release({ db, reservationId: r.reservationId, quotaId: r.quotaId });
    expect(rel.ok).toBe(true);
    const row = await loadQuotaById(db, 'cf_workers_ai_daily');
    expect(Number(row?.used_units)).toBe(0);
    expect(Number(row?.reserved_units)).toBe(0);
    const rel2 = await d1Release({ db, reservationId: r.reservationId, quotaId: r.quotaId });
    expect(rel2.ok).toBe(true);
    if (!rel2.ok) return;
    expect(rel2.alreadyDone).toBe(true);
  });

  it('cannot release after commit', async () => {
    const db = seed(100);
    const r = await d1Reserve({ db, providerId: 'cf_workers_ai', units: 8, jobId: 'j_cr' });
    if (!r.ok) throw new Error('reserve failed');
    await d1Commit({ db, reservationId: r.reservationId, quotaId: r.quotaId });
    const rel = await d1Release({ db, reservationId: r.reservationId, quotaId: r.quotaId });
    expect(rel.ok).toBe(false);
    const row = await loadQuotaById(db, 'cf_workers_ai_daily');
    expect(Number(row?.used_units)).toBe(8);
  });

  it('concurrent-style race: only one wins last units', async () => {
    const db = seed(30);
    const results = await Promise.all([
      d1Reserve({ db, providerId: 'cf_workers_ai', units: 20, jobId: 'race1' }),
      d1Reserve({ db, providerId: 'cf_workers_ai', units: 20, jobId: 'race2' }),
    ]);
    const okCount = results.filter((x) => x.ok).length;
    const failCount = results.filter((x) => !x.ok).length;
    expect(okCount).toBe(1);
    expect(failCount).toBe(1);
    const row = await loadQuotaById(db, 'cf_workers_ai_daily');
    expect(Number(row?.reserved_units)).toBe(20);
    expect(Number(row?.used_units)).toBe(0);
  });

  it('zero-cost policy still enforced outside quota layer', () => {
    expect(FACTORY_CONSTITUTION.MAX_ALLOWED_COST).toBe(0);
    expect(FACTORY_CONSTITUTION.ALLOW_PAID_API).toBe(false);
    expect(
      assertZeroCost({ allowPaidApi: false, estimatedCost: 0.01, freeAvailable: true }).allowed
    ).toBe(false);
    expect(
      assertZeroCost({ allowPaidApi: false, estimatedCost: 0, freeAvailable: true }).allowed
    ).toBe(true);
  });
});
