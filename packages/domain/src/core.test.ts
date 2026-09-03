import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition, isTerminal } from './state-machine.js';
import { assertZeroCost, canStartNewWork, FACTORY_CONSTITUTION } from './policy.js';
import {
  availableUnits,
  canReserve,
  applyReserve,
  applyCommit,
  applyRelease,
  estimateFluxSchnellNeurons,
  DEFAULT_WORKERS_AI_DAILY_NEURONS,
} from './quota.js';
import { scoreProvider, pickBestProvider, routeProvider } from './providers.js';
import { level1Checks, summarizeQc, mayUpload } from './qc.js';
import { decideCleanup } from './cleanup.js';
import {
  findExactDuplicate,
  hammingDistanceHex,
  findPhashDuplicates,
  checkDuplicates,
  averageHashFromBlock,
} from './duplicate.js';
import { decideRetry, computeBackoffMs, DEFAULT_RETRY_POLICY } from './retry.js';
import { maxAttemptsFor, isRetryableJobStatus } from './jobs.js';

describe('state machine', () => {
  it('happy path', () => {
    expect(canTransition('PLANNED', 'QUEUED')).toBe(true);
    expect(canTransition('GENERATED', 'QC')).toBe(true);
    expect(canTransition('QC', 'PASSED')).toBe(true);
    expect(canTransition('METADATA', 'READY_TO_UPLOAD')).toBe(true);
  });
  it('blocks illegal', () => {
    expect(canTransition('PLANNED', 'UPLOADED')).toBe(false);
    expect(() => assertTransition('QC', 'UPLOADED')).toThrow(/Illegal/);
  });
  it('terminal', () => {
    expect(isTerminal('DEAD_LETTER')).toBe(true);
    expect(isTerminal('QUEUED')).toBe(false);
  });
});

describe('zero-cost + kill switch', () => {
  it('constitution constants', () => {
    expect(FACTORY_CONSTITUTION.MAX_ALLOWED_COST).toBe(0);
    expect(FACTORY_CONSTITUTION.ALLOW_PAID_API).toBe(false);
  });
  it('blocks paid', () => {
    expect(
      assertZeroCost({ allowPaidApi: false, estimatedCost: 0.01, freeAvailable: true }).allowed
    ).toBe(false);
  });
  it('allows free zero', () => {
    expect(
      assertZeroCost({ allowPaidApi: false, estimatedCost: 0, freeAvailable: true }).allowed
    ).toBe(true);
  });
  it('STOP blocks new work', () => {
    expect(canStartNewWork('STOPPED')).toBe(false);
    expect(canStartNewWork('RUNNING')).toBe(true);
  });
});

describe('quota manager', () => {
  const base = {
    providerId: 'cf',
    window: 'daily' as const,
    limitUnits: 100,
    usedUnits: 40,
    reservedUnits: 10,
  };
  it('available / canReserve', () => {
    expect(availableUnits(base)).toBe(50);
    expect(canReserve(base, 50)).toBe(true);
    expect(canReserve(base, 51)).toBe(false);
  });
  it('reserve commit release', () => {
    const r = applyReserve(base, 20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.reservedUnits).toBe(30);
    const c = applyCommit(r.snapshot, 20);
    expect(c.usedUnits).toBe(60);
    expect(c.reservedUnits).toBe(10);
    const rel = applyRelease(r.snapshot, 20);
    expect(rel.reservedUnits).toBe(10);
  });
  it('insufficient quota', () => {
    const r = applyReserve(base, 999);
    expect(r.ok).toBe(false);
  });
  it('flux neuron estimate stays under free budget for 512x4steps', () => {
    const n = estimateFluxSchnellNeurons({ width: 512, height: 512, steps: 4 });
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(DEFAULT_WORKERS_AI_DAILY_NEURONS);
    expect(n).toBe(44);
  });
});

describe('provider router', () => {
  it('rejects paid cost candidates', () => {
    expect(
      scoreProvider({
        enabled: true,
        freeAvailable: true,
        healthOk: true,
        quotaRemaining: 100,
        failureRate: 0,
        priority: 1,
        estimatedCost: 0.01,
      })
    ).toBeNull();
  });
  it('picks best', () => {
    const a = {
      id: 'a',
      enabled: true,
      freeAvailable: true,
      healthOk: true,
      quotaRemaining: 10,
      failureRate: 0.2,
      priority: 5,
      estimatedCost: 0,
    };
    const b = {
      id: 'b',
      enabled: true,
      freeAvailable: true,
      healthOk: true,
      quotaRemaining: 100,
      failureRate: 0,
      priority: 1,
      estimatedCost: 0,
    };
    expect(routeProvider([a, b]).selected?.id).toBe('b');
  });
  it('no eligible', () => {
    expect(
      routeProvider([
        {
          enabled: false,
          freeAvailable: true,
          healthOk: true,
          quotaRemaining: 1,
          failureRate: 0,
          priority: 1,
        },
      ]).reason
    ).toBe('NO_ELIGIBLE_PROVIDER');
  });
});

describe('QC pipeline', () => {
  it('level1 fails bad files', () => {
    expect(
      summarizeQc(level1Checks({ exists: false, byteSize: 10, width: 64, height: 64 })).passed
    ).toBe(false);
  });
  it('level1 passes healthy', () => {
    expect(
      summarizeQc(
        level1Checks({
          exists: true,
          byteSize: 50_000,
          width: 1024,
          height: 1024,
          mimeType: 'image/jpeg',
          sha256: 'a'.repeat(64),
        })
      ).passed
    ).toBe(true);
  });
  it('mayUpload constitution', () => {
    expect(mayUpload(false, true)).toBe(false);
    expect(mayUpload(true, true)).toBe(true);
  });
});

describe('duplicate detection', () => {
  it('exact hash', () => {
    const existing = [{ hashType: 'sha256' as const, hashValue: 'abc123', assetId: 'a1' }];
    expect(findExactDuplicate('ABC123', existing)?.isDuplicate).toBe(true);
    expect(findExactDuplicate('zzz', existing)).toBeNull();
  });
  it('hamming + phash threshold', () => {
    expect(hammingDistanceHex('00', '00')).toBe(0);
    expect(hammingDistanceHex('0f', '00')).toBe(4);
    const existing = [{ hashType: 'phash' as const, hashValue: '0000', assetId: 'p1' }];
    expect(findPhashDuplicates('0000', existing, 0).length).toBe(1);
    expect(findPhashDuplicates('ffff', existing, 0).length).toBe(0);
  });
  it('pipeline exact short-circuits', () => {
    const r = checkDuplicates({
      sha256: 'deadbeef',
      phash: '1111',
      existing: [
        { hashType: 'sha256', hashValue: 'deadbeef', assetId: 'x' },
        { hashType: 'phash', hashValue: '1111', assetId: 'y' },
      ],
    });
    expect(r.isDuplicate).toBe(true);
    expect(r.matches[0].layer).toBe('exact');
  });
  it('averageHashFromBlock', () => {
    const block = Array(64).fill(100);
    block[0] = 200;
    const h = averageHashFromBlock(block);
    expect(h).toHaveLength(16);
  });
});

describe('retry / backoff / DLQ', () => {
  it('retries under max', () => {
    const d = decideRetry({ attemptCount: 1, now: 1_000_000 });
    expect(d.action).toBe('retry');
    if (d.action === 'retry') {
      expect(d.attempt).toBe(2);
      expect(d.delayMs).toBeGreaterThan(0);
    }
  });
  it('DLQ after max', () => {
    const d = decideRetry({ attemptCount: 3, maxAttempts: 3 });
    expect(d.action).toBe('dead_letter');
  });
  it('quota wait', () => {
    const d = decideRetry({ attemptCount: 0, errorCode: 'QUOTA' });
    expect(d.action).toBe('waiting_for_quota');
  });
  it('paid blocked → DLQ', () => {
    expect(decideRetry({ attemptCount: 0, errorCode: 'PAID_BLOCKED' }).action).toBe('dead_letter');
    expect(decideRetry({ attemptCount: 0, errorCode: 'FACTORY_STOPPED' }).action).toBe(
      'dead_letter'
    );
  });
  it('backoff grows', () => {
    const a = computeBackoffMs(1, { ...DEFAULT_RETRY_POLICY, jitterRatio: 0 });
    const b = computeBackoffMs(3, { ...DEFAULT_RETRY_POLICY, jitterRatio: 0 });
    expect(b).toBeGreaterThan(a);
  });
});

describe('cleanup + jobs', () => {
  it('never deletes uploaded/keep/pending', () => {
    expect(
      decideCleanup({
        id: '1',
        status: 'REJECTED',
        uploaded: true,
        keep: false,
        hasPendingJob: false,
        r2Key: 'k',
        createdAt: '2020-01-01',
        retentionDays: 7,
      }).action
    ).toBe('skip');
  });
  it('job retry helpers', () => {
    expect(maxAttemptsFor('IMAGE_GENERATION')).toBe(3);
    expect(isRetryableJobStatus('failed')).toBe(true);
  });
});
