import { describe, it, expect } from 'vitest';
import { MemoryJobsD1 } from './memory-jobs-d1.js';
import {
  d1TransitionJobStatus, d1InsertDeadLetter, d1MoveJobToDeadLetter,
  d1ApplyWatchdogAction, d1RunWatchdogForJobs, d1IncrementAttemptAndScheduleRetry, d1GetJob,
} from './jobs-d1.js';
import { evaluateWatchdogJob, DEFAULT_WATCHDOG_POLICY } from './watchdog.js';
import { FACTORY_CONSTITUTION } from './policy.js';

describe('D1 job transition atomicity', () => {
  it('conditional update wins once', async () => {
    const db = new MemoryJobsD1();
    db.seedJob({ id: 'j1', status: 'running', attempt_count: 0 });
    expect((await d1TransitionJobStatus(db, { jobId: 'j1', fromStatus: 'running', toStatus: 'failed' })).ok).toBe(true);
    expect((await d1TransitionJobStatus(db, { jobId: 'j1', fromStatus: 'running', toStatus: 'failed' })).ok).toBe(false);
  });
});

describe('DLQ', () => {
  it('inserts once', async () => {
    const db = new MemoryJobsD1();
    expect((await d1InsertDeadLetter(db, { jobId: 'j3', reason: 'max', attemptCount: 3 })).inserted).toBe(true);
    expect((await d1InsertDeadLetter(db, { jobId: 'j3', reason: 'max', attemptCount: 3 })).inserted).toBe(false);
  });
  it('move once', async () => {
    const db = new MemoryJobsD1();
    db.seedJob({ id: 'j4', status: 'failed', attempt_count: 3 });
    const m1 = await d1MoveJobToDeadLetter(db, { jobId: 'j4', fromStatus: 'failed', reason: 'max', expectedAttemptCount: 3 });
    const m2 = await d1MoveJobToDeadLetter(db, { jobId: 'j4', fromStatus: 'failed', reason: 'max', expectedAttemptCount: 3 });
    expect(m1.ok && m1.dlqInserted).toBe(true);
    expect(m2.ok).toBe(false);
  });
});

describe('Watchdog D1', () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z');
  it('timeout once', async () => {
    const db = new MemoryJobsD1();
    db.seedJob({ id: 'jg', status: 'generating', attempt_count: 1,
      state_entered_at: new Date(now - DEFAULT_WATCHDOG_POLICY.generatingTimeoutMs - 5).toISOString() });
    const job = (await d1GetJob(db, 'jg'))!;
    const decision = evaluateWatchdogJob({
      jobId: job.id, state: job.status, stateEnteredAt: job.state_entered_at!, attemptCount: job.attempt_count,
    }, DEFAULT_WATCHDOG_POLICY, now);
    expect(decision.action).toBe('mark_failed');
    expect((await d1ApplyWatchdogAction(db, job, decision, { factoryStatus: 'RUNNING', now })).ok).toBe(true);
    expect((await d1ApplyWatchdogAction(db, job, decision, { factoryStatus: 'RUNNING', now })).ok).toBe(false);
  });
  it('STOP blocks requeue', async () => {
    const db = new MemoryJobsD1();
    db.setFactoryStatus('STOPPED');
    db.seedJob({ id: 'js', status: 'queued', attempt_count: 0,
      state_entered_at: new Date(now - DEFAULT_WATCHDOG_POLICY.queuedTimeoutMs - 5).toISOString() });
    await d1RunWatchdogForJobs(db, [(await d1GetJob(db, 'js'))!], DEFAULT_WATCHDOG_POLICY, now);
    expect((await d1GetJob(db, 'js'))?.error_code).toBe('FACTORY_STOPPED');
  });
});

describe('Retry + max DLQ', () => {
  it('attempt atomic', async () => {
    const db = new MemoryJobsD1();
    db.seedJob({ id: 'jr', status: 'running', attempt_count: 0 });
    expect((await d1IncrementAttemptAndScheduleRetry(db, { jobId: 'jr', fromStatus: 'running', expectedAttemptCount: 0, errorCode: 'GENERATION_FAILED' })).ok).toBe(true);
    expect((await d1IncrementAttemptAndScheduleRetry(db, { jobId: 'jr', fromStatus: 'running', expectedAttemptCount: 0, errorCode: 'GENERATION_FAILED' })).ok).toBe(false);
  });
  it('max to DLQ', async () => {
    const db = new MemoryJobsD1();
    db.seedJob({ id: 'jm', status: 'running', attempt_count: 3 });
    await d1IncrementAttemptAndScheduleRetry(db, { jobId: 'jm', fromStatus: 'running', expectedAttemptCount: 3, errorCode: 'GENERATION_FAILED' });
    expect((await d1GetJob(db, 'jm'))?.status).toBe('dead_letter');
    expect(db.dead_letter_jobs).toHaveLength(1);
  });
});

describe('policy', () => {
  it('zero-cost', () => {
    expect(FACTORY_CONSTITUTION.MAX_ALLOWED_COST).toBe(0);
    expect(FACTORY_CONSTITUTION.ALLOW_PAID_API).toBe(false);
  });
});
