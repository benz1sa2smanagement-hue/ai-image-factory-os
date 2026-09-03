import { describe, it, expect } from 'vitest';
import {
  level1Checks,
  level2Checks,
  level3ContentChecks,
  summarizeQc,
  runQcPipeline,
  mayUpload,
} from './qc.js';
import {
  decideRetry,
  computeBackoffMs,
  buildDeadLetterRecord,
  DEFAULT_RETRY_POLICY,
  isRetryableErrorCode,
} from './retry.js';
import {
  evaluateWatchdogJob,
  evaluateWatchdogBatch,
  stopBlocksNewGeneration,
  stopBlocksQuotaReserve,
  DEFAULT_WATCHDOG_POLICY,
} from './watchdog.js';
import { canTransition, assertTransition, ASSET_STATES } from './state-machine.js';
import { decideCleanup } from './cleanup.js';
import { assertZeroCost, canStartNewWork, FACTORY_CONSTITUTION } from './policy.js';

describe('QC pipeline', () => {
  it('QC PASS', () => {
    const s = runQcPipeline({
      level1: {
        exists: true, byteSize: 50_000, width: 1024, height: 1024,
        mimeType: 'image/jpeg', sha256: 'a'.repeat(64), decodeOk: true, format: 'jpeg',
      },
      level2: { meanLuma: 120, nearBlankRatio: 0.1 },
    });
    expect(s.outcome).toBe('PASS');
    expect(mayUpload(s.passed, true)).toBe(true);
  });

  it('QC REJECT missing file', () => {
    const s = runQcPipeline({ level1: { exists: false, byteSize: 0 } });
    expect(s.outcome).toBe('REJECT');
  });

  it('QC REJECT decode fail', () => {
    const s = runQcPipeline({
      level1: {
        exists: true, byteSize: 5000, width: 1024, height: 1024,
        sha256: 'b'.repeat(64), decodeOk: false, decodeErrorCode: 'JPEG_INVALID',
      },
    });
    expect(s.outcome).toBe('REJECT');
  });

  it('blank image reject', () => {
    expect(summarizeQc(level2Checks({ meanLuma: 2, nearBlankRatio: 0.99 })).outcome).toBe('REJECT');
  });

  it('L3 skipped zero-cost', () => {
    expect(level3ContentChecks({ skip: true })[0]?.name).toBe('content_qc_skipped');
  });

  it('hash missing → RETRY', () => {
    const s = summarizeQc(level1Checks({
      exists: true, byteSize: 10_000, width: 1024, height: 1024, mimeType: 'image/jpeg',
    }));
    expect(s.outcome).toBe('RETRY');
  });
});

describe('Retry + DLQ', () => {
  it('backoff increases', () => {
    expect(computeBackoffMs(3, DEFAULT_RETRY_POLICY, () => 0.5))
      .toBeGreaterThan(computeBackoffMs(1, DEFAULT_RETRY_POLICY, () => 0.5));
  });

  it('retries then DLQ', () => {
    expect(decideRetry({ attemptCount: 0, errorCode: 'GENERATION_FAILED', rng: () => 0.5 }).action).toBe('retry');
    expect(decideRetry({ attemptCount: 3, errorCode: 'GENERATION_FAILED' }).action).toBe('dead_letter');
  });

  it('non-retryable → DLQ', () => {
    for (const code of ['PAID_BLOCKED', 'COST_EXCEEDED', 'FACTORY_STOPPED', 'QC_REJECTED']) {
      expect(decideRetry({ attemptCount: 0, errorCode: code }).action).toBe('dead_letter');
      expect(isRetryableErrorCode(code)).toBe(false);
    }
  });

  it('quota limited then DLQ', () => {
    expect(decideRetry({ attemptCount: 0, errorCode: 'WAITING_FOR_QUOTA' }).action).toBe('waiting_for_quota');
    expect(decideRetry({ attemptCount: DEFAULT_RETRY_POLICY.quotaMaxAttempts, errorCode: 'QUOTA' }).action).toBe('dead_letter');
  });

  it('DLQ record fields', () => {
    const rec = buildDeadLetterRecord({ jobId: 'job_1', reason: 'max_attempts_3', attemptCount: 3 });
    expect(rec.jobId).toBe('job_1');
    expect(rec.timestamp).toBeTruthy();
  });
});

describe('Watchdog', () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z');
  it('GENERATING timeout', () => {
    const a = evaluateWatchdogJob({
      jobId: 'j1', state: 'GENERATING',
      stateEnteredAt: now - DEFAULT_WATCHDOG_POLICY.generatingTimeoutMs - 1, attemptCount: 1,
    }, DEFAULT_WATCHDOG_POLICY, now);
    expect(a.action).toBe('mark_failed');
  });
  it('QUEUED requeue same id', () => {
    const a = evaluateWatchdogJob({
      jobId: 'j3', state: 'QUEUED',
      stateEnteredAt: now - DEFAULT_WATCHDOG_POLICY.queuedTimeoutMs - 1,
      attemptCount: 0, idempotencyKey: 'idem-j3',
    }, DEFAULT_WATCHDOG_POLICY, now);
    expect(a.action).toBe('requeue');
    if (a.action === 'requeue') expect(a.jobId).toBe('j3');
  });
  it('healthy none', () => {
    expect(evaluateWatchdogJob({
      jobId: 'j4', state: 'GENERATING', stateEnteredAt: now - 1000,
      lastHeartbeatAt: now - 1000, attemptCount: 0,
    }, DEFAULT_WATCHDOG_POLICY, now).action).toBe('none');
  });
  it('batch keeps ids', () => {
    const acts = evaluateWatchdogBatch([{
      jobId: 'a', state: 'GENERATING', stateEnteredAt: now - 99999999, attemptCount: 1,
    }], DEFAULT_WATCHDOG_POLICY, now);
    expect(acts[0]?.action === 'mark_failed' && acts[0].jobId === 'a').toBe(true);
  });
});

describe('STOP + zero-cost', () => {
  it('STOP blocks gen/quota', () => {
    expect(stopBlocksNewGeneration('STOPPED')).toBe(true);
    expect(stopBlocksQuotaReserve('STOPPED')).toBe(true);
    expect(canStartNewWork('RUNNING')).toBe(true);
  });
  it('cannot bypass zero-cost', () => {
    expect(assertZeroCost({ allowPaidApi: true, estimatedCost: 1, freeAvailable: true }).allowed).toBe(false);
    expect(FACTORY_CONSTITUTION.MAX_ALLOWED_COST).toBe(0);
  });
});

describe('Cleanup + state machine', () => {
  it('no delete active/pending', () => {
    expect(decideCleanup({
      id: '1', status: 'GENERATING', uploaded: false, keep: false,
      hasPendingJob: false, r2Key: 'k', createdAt: '2020-01-01', retentionDays: 1,
    }).action).toBe('skip');
  });
  it('happy path legal', () => {
    expect(canTransition('QUEUED', 'GENERATING')).toBe(true);
    expect(canTransition('FAILED', 'RETRY_WAIT')).toBe(true);
    expect(canTransition('DEAD_LETTER', 'QUEUED')).toBe(false);
  });
  it('illegal throws', () => {
    expect(() => assertTransition('READY_TO_UPLOAD', 'GENERATING')).toThrow();
  });
  it('states include DLQ', () => {
    expect(ASSET_STATES).toContain('DEAD_LETTER');
  });
});
