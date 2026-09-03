/** Retry + exponential backoff + DLQ policy */

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  quotaMaxWaitMs: number;
  quotaMaxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 300_000,
  jitterRatio: 0.2,
  quotaMaxWaitMs: 60_000,
  quotaMaxAttempts: 10,
};

export const NON_RETRYABLE_CODES = new Set([
  'PAID_BLOCKED',
  'COST_EXCEEDED',
  'FACTORY_STOPPED',
  'POLICY',
  'UNSUPPORTED_FORMAT',
  'QC_REJECTED',
  'DUPLICATE_REJECTED',
  'ILLEGAL_TRANSITION',
]);

export const QUOTA_CODES = new Set([
  'QUOTA',
  'WAITING_FOR_QUOTA',
  'INSUFFICIENT_QUOTA',
]);

export type RetryDecision =
  | { action: 'retry'; attempt: number; delayMs: number; nextRetryAt: string }
  | { action: 'dead_letter'; attempt: number; reason: string }
  | { action: 'waiting_for_quota'; delayMs: number; nextRetryAt: string; attempt: number };

export interface DeadLetterRecord {
  jobId: string;
  reason: string;
  attemptCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  provider?: string;
  requestId?: string;
  timestamp: string;
  payloadSummary?: string;
}

export function buildDeadLetterRecord(input: {
  jobId: string;
  reason: string;
  attemptCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  provider?: string;
  requestId?: string;
  payloadSummary?: string;
  now?: number;
}): DeadLetterRecord {
  return {
    jobId: input.jobId,
    reason: input.reason,
    attemptCount: input.attemptCount,
    lastErrorCode: input.lastErrorCode,
    lastErrorMessage: input.lastErrorMessage,
    provider: input.provider,
    requestId: input.requestId,
    timestamp: new Date(input.now ?? Date.now()).toISOString(),
    payloadSummary: input.payloadSummary,
  };
}

export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  rng: () => number = Math.random
): number {
  const exp = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1))
  );
  const jitter = exp * policy.jitterRatio * (rng() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

export function decideRetry(opts: {
  attemptCount: number;
  maxAttempts?: number;
  errorCode?: string;
  policy?: RetryPolicy;
  now?: number;
  rng?: () => number;
}): RetryDecision {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
  const max = opts.maxAttempts ?? policy.maxAttempts;
  const attempt = opts.attemptCount;
  const now = opts.now ?? Date.now();
  const code = opts.errorCode ?? '';

  if (NON_RETRYABLE_CODES.has(code)) {
    return { action: 'dead_letter', attempt, reason: code };
  }

  if (QUOTA_CODES.has(code)) {
    if (attempt >= policy.quotaMaxAttempts) {
      return {
        action: 'dead_letter',
        attempt,
        reason: `quota_exhausted_attempts_${policy.quotaMaxAttempts}`,
      };
    }
    const delayMs = Math.min(policy.quotaMaxWaitMs, policy.maxDelayMs);
    return {
      action: 'waiting_for_quota',
      delayMs,
      nextRetryAt: new Date(now + delayMs).toISOString(),
      attempt: attempt + 1,
    };
  }

  if (attempt >= max) {
    return { action: 'dead_letter', attempt, reason: `max_attempts_${max}` };
  }

  const delayMs = computeBackoffMs(attempt + 1, policy, opts.rng ?? Math.random);
  return {
    action: 'retry',
    attempt: attempt + 1,
    delayMs,
    nextRetryAt: new Date(now + delayMs).toISOString(),
  };
}

export function isDeadLetterAction(d: RetryDecision): boolean {
  return d.action === 'dead_letter';
}

export function isRetryableErrorCode(code: string): boolean {
  if (NON_RETRYABLE_CODES.has(code)) return false;
  return true;
}
