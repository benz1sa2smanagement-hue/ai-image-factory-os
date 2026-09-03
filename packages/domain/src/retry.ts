/** Retry + exponential backoff + DLQ policy */

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 300_000,
  jitterRatio: 0.2,
};

export type RetryDecision =
  | { action: 'retry'; attempt: number; delayMs: number; nextRetryAt: string }
  | { action: 'dead_letter'; attempt: number; reason: string }
  | { action: 'waiting_for_quota'; delayMs: number; nextRetryAt: string };

export function computeBackoffMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = exp * policy.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

export function decideRetry(opts: {
  attemptCount: number;
  maxAttempts?: number;
  errorCode?: string;
  policy?: RetryPolicy;
  now?: number;
}): RetryDecision {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
  const max = opts.maxAttempts ?? policy.maxAttempts;
  const attempt = opts.attemptCount;
  const now = opts.now ?? Date.now();

  if (opts.errorCode === 'QUOTA' || opts.errorCode === 'WAITING_FOR_QUOTA') {
    const delayMs = Math.min(policy.maxDelayMs, 60_000);
    return { action: 'waiting_for_quota', delayMs, nextRetryAt: new Date(now + delayMs).toISOString() };
  }

  if (
    opts.errorCode === 'PAID_BLOCKED' ||
    opts.errorCode === 'COST_EXCEEDED' ||
    opts.errorCode === 'FACTORY_STOPPED'
  ) {
    return { action: 'dead_letter', attempt, reason: opts.errorCode };
  }

  if (attempt >= max) {
    return { action: 'dead_letter', attempt, reason: `max_attempts_${max}` };
  }

  const delayMs = computeBackoffMs(attempt + 1, policy);
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
