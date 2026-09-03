/**
 * Watchdog — detect stuck jobs without creating duplicates.
 */

export type WatchdogJobState =
  | 'QUEUED'
  | 'GENERATING'
  | 'QC'
  | 'RETRY_WAIT'
  | 'RUNNING'
  | string;

export interface WatchdogJobSnapshot {
  jobId: string;
  state: WatchdogJobState;
  stateEnteredAt: string | number;
  lastHeartbeatAt?: string | number | null;
  attemptCount: number;
  idempotencyKey?: string;
}

export interface WatchdogPolicy {
  generatingTimeoutMs: number;
  qcTimeoutMs: number;
  queuedTimeoutMs: number;
  retryWaitTimeoutMs: number;
  heartbeatTimeoutMs: number;
}

export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicy = {
  generatingTimeoutMs: 10 * 60 * 1000,
  qcTimeoutMs: 5 * 60 * 1000,
  queuedTimeoutMs: 30 * 60 * 1000,
  retryWaitTimeoutMs: 60 * 60 * 1000,
  heartbeatTimeoutMs: 15 * 60 * 1000,
};

export type WatchdogAction =
  | { action: 'none'; reason: string }
  | { action: 'mark_failed'; reason: string; jobId: string; errorCode: string }
  | { action: 'requeue'; reason: string; jobId: string; idempotencyKey?: string }
  | { action: 'dead_letter'; reason: string; jobId: string };

function toMs(v: string | number | null | undefined, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : fallback;
}

export function evaluateWatchdogJob(
  job: WatchdogJobSnapshot,
  policy: WatchdogPolicy = DEFAULT_WATCHDOG_POLICY,
  now = Date.now()
): WatchdogAction {
  const entered = toMs(job.stateEnteredAt, now);
  const age = Math.max(0, now - entered);
  const state = String(job.state).toUpperCase();

  if (job.lastHeartbeatAt != null) {
    const hb = toMs(job.lastHeartbeatAt, now);
    if (now - hb > policy.heartbeatTimeoutMs) {
      if (state === 'GENERATING' || state === 'QC' || state === 'RUNNING') {
        return {
          action: 'mark_failed',
          reason: 'heartbeat_timeout',
          jobId: job.jobId,
          errorCode: 'WATCHDOG_HEARTBEAT_TIMEOUT',
        };
      }
    }
  }

  if (state === 'GENERATING' && age > policy.generatingTimeoutMs) {
    return {
      action: 'mark_failed',
      reason: 'generating_timeout',
      jobId: job.jobId,
      errorCode: 'WATCHDOG_GENERATING_TIMEOUT',
    };
  }

  if (state === 'QC' && age > policy.qcTimeoutMs) {
    return {
      action: 'mark_failed',
      reason: 'qc_timeout',
      jobId: job.jobId,
      errorCode: 'WATCHDOG_QC_TIMEOUT',
    };
  }

  if (state === 'QUEUED' && age > policy.queuedTimeoutMs) {
    return {
      action: 'requeue',
      reason: 'queued_timeout',
      jobId: job.jobId,
      idempotencyKey: job.idempotencyKey ?? `watchdog:requeue:${job.jobId}`,
    };
  }

  if (state === 'RETRY_WAIT' && age > policy.retryWaitTimeoutMs) {
    return {
      action: 'mark_failed',
      reason: 'retry_wait_timeout',
      jobId: job.jobId,
      errorCode: 'WATCHDOG_RETRY_WAIT_TIMEOUT',
    };
  }

  return { action: 'none', reason: 'healthy' };
}

export function evaluateWatchdogBatch(
  jobs: WatchdogJobSnapshot[],
  policy?: WatchdogPolicy,
  now?: number
): WatchdogAction[] {
  return jobs.map((j) => evaluateWatchdogJob(j, policy, now));
}

export function stopBlocksNewGeneration(factoryStatus: string): boolean {
  return factoryStatus !== 'RUNNING';
}

export function stopBlocksQuotaReserve(factoryStatus: string): boolean {
  return factoryStatus !== 'RUNNING';
}

export function stopAllowsInFlightCompletion(): boolean {
  return true;
}
