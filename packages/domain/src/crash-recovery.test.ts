import { describe, it, expect } from 'vitest';
import { MemoryD1 } from './memory-d1.js';
import { MemoryJobsD1 } from './memory-jobs-d1.js';
import { d1Reserve, d1Commit } from './quota-d1.js';
import { releaseReservedQuotaForJob } from './quota-release-by-job.js';
import {
  d1ApplyWatchdogAction,
  d1GetJob,
  d1RunWatchdogForJobs,
  d1IncrementAttemptAndScheduleRetry,
} from './jobs-d1.js';
import { evaluateWatchdogJob, DEFAULT_WATCHDOG_POLICY } from './watchdog.js';
import { FACTORY_CONSTITUTION } from './policy.js';

describe('Scenario A: reserve → crash → watchdog', () => {
  it('releases reserved quota once', async () => {
    const qdb = new MemoryD1();
    qdb.seedQuota({ id: 'q1', provider_id: 'cf_workers_ai', window: 'daily', limit_units: 1000 });
    const reserved = await d1Reserve({
      db: qdb, providerId: 'cf_workers_ai', window: 'daily', units: 50,
      jobId: 'job-crash-a', idempotencyKey: 'quota:job-crash-a:0',
    });
    expect(reserved.ok).toBe(true);
    const rel = await releaseReservedQuotaForJob(qdb, 'job-crash-a');
    expect(rel.ok).toBe(true);
    expect(qdb.provider_quotas[0]?.reserved_units).toBe(0);
    const rel2 = await releaseReservedQuotaForJob(qdb, 'job-crash-a');
    expect(rel2.ok === false || (rel2.ok && rel2.alreadyDone)).toBe(true);
  });
});

describe('Scenario B: watchdog twice', () => {
  it('one transition', async () => {
    const jdb = new MemoryJobsD1();
    const now = Date.parse('2026-09-03T12:00:00.000Z');
    jdb.seedJob({
      id: 'job-b', status: 'generating', attempt_count: 1,
      state_entered_at: new Date(now - DEFAULT_WATCHDOG_POLICY.generatingTimeoutMs - 10).toISOString(),
    });
    const job = (await d1GetJob(jdb, 'job-b'))!;
    const decision = evaluateWatchdogJob({
      jobId: job.id, state: job.status, stateEnteredAt: job.state_entered_at!, attemptCount: job.attempt_count,
    }, DEFAULT_WATCHDOG_POLICY, now);
    expect((await d1ApplyWatchdogAction(jdb, job, decision, { factoryStatus: 'RUNNING', now })).ok).toBe(true);
    expect((await d1ApplyWatchdogAction(jdb, job, decision, { factoryStatus: 'RUNNING', now })).ok).toBe(false);
  });
});

describe('Scenario C: commit blocks release', () => {
  it('INVALID_STATE', async () => {
    const qdb = new MemoryD1();
    qdb.seedQuota({ id: 'q1', provider_id: 'cf_workers_ai', window: 'daily', limit_units: 1000 });
    const reserved = await d1Reserve({
      db: qdb, providerId: 'cf_workers_ai', window: 'daily', units: 10,
      jobId: 'job-c', idempotencyKey: 'quota:job-c:0',
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    await d1Commit({ db: qdb, reservationId: reserved.reservationId, quotaId: reserved.quotaId });
    const rel = await releaseReservedQuotaForJob(qdb, 'job-c');
    expect(rel.ok).toBe(false);
  });
});

describe('Scenario D: max → DLQ', () => {
  it('one row', async () => {
    const jdb = new MemoryJobsD1();
    jdb.seedJob({ id: 'job-d', status: 'running', attempt_count: 3 });
    await d1IncrementAttemptAndScheduleRetry(jdb, {
      jobId: 'job-d', fromStatus: 'running', expectedAttemptCount: 3, errorCode: 'GENERATION_FAILED',
    });
    expect((await d1GetJob(jdb, 'job-d'))?.status).toBe('dead_letter');
    expect(jdb.dead_letter_jobs).toHaveLength(1);
  });
});

describe('Scenario E: STOP', () => {
  it('blocks requeue', async () => {
    const jdb = new MemoryJobsD1();
    jdb.setFactoryStatus('STOPPED');
    const now = Date.parse('2026-09-03T12:00:00.000Z');
    jdb.seedJob({
      id: 'job-e', status: 'queued', attempt_count: 0,
      state_entered_at: new Date(now - DEFAULT_WATCHDOG_POLICY.queuedTimeoutMs - 10).toISOString(),
    });
    await d1RunWatchdogForJobs(jdb, [(await d1GetJob(jdb, 'job-e'))!], DEFAULT_WATCHDOG_POLICY, now);
    expect((await d1GetJob(jdb, 'job-e'))?.error_code).toBe('FACTORY_STOPPED');
    expect(FACTORY_CONSTITUTION.MAX_ALLOWED_COST).toBe(0);
  });
});
