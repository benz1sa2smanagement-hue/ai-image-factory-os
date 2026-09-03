/**
 * Deterministic multi-provider fallback — one provider at a time.
 * Does NOT reserve quota (caller does reserve per selected provider).
 * Does NOT retry infinitely; at most one attempt per eligible provider per cycle.
 */

import {
  listEligibleProviders,
  type ProviderDescriptor,
  type ProviderQuotaSnapshot,
  type ProviderRouterPolicy,
} from './provider-router.js';
import { applyGuardToQuotaSnapshots as guardQuotas } from './quota-guard.js';
import type { QuotaGuardPolicy } from './quota-guard.js';
import { DEFAULT_QUOTA_GUARD_POLICY } from './quota-guard.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { GenerationRequest, GenerationOutcome } from './generation.js';

export interface FallbackAttemptRecord {
  providerId: string;
  outcome: 'success' | 'retryable_failure' | 'permanent_failure' | 'unavailable' | 'skipped';
  code?: string;
}

export type FallbackResult =
  | {
      ok: true;
      providerId: string;
      generation: Extract<GenerationOutcome, { success: true }>;
      attempts: FallbackAttemptRecord[];
    }
  | {
      ok: false;
      code: string;
      message: string;
      retryable: boolean;
      attempts: FallbackAttemptRecord[];
    };

function isPermanentFailure(outcome: GenerationOutcome): boolean {
  if (outcome.success) return false;
  return outcome.retryable === false;
}

/**
 * Rank eligible providers under quota guard, then try each once via registry.
 * Permanent failure stops fallback. Retryable/unavailable continues to next.
 */
export async function runProviderFallback(opts: {
  request: GenerationRequest;
  candidates: ProviderDescriptor[];
  quotas: ProviderQuotaSnapshot[];
  registry: ProviderRegistry;
  routerPolicy?: Partial<ProviderRouterPolicy>;
  quotaGuard?: QuotaGuardPolicy;
  beforeAttempt?: (providerId: string) => Promise<boolean>;
  afterAttempt?: (providerId: string, outcome: GenerationOutcome) => Promise<void>;
}): Promise<FallbackResult> {
  const guardPolicy = opts.quotaGuard ?? DEFAULT_QUOTA_GUARD_POLICY;
  const guardedQuotas = guardQuotas(opts.quotas, guardPolicy);
  const ranked = listEligibleProviders({
    candidates: opts.candidates,
    quotas: guardedQuotas,
    policy: opts.routerPolicy,
  });

  const attempts: FallbackAttemptRecord[] = [];

  if (ranked.length === 0) {
    return {
      ok: false,
      code: 'NO_ELIGIBLE_PROVIDER',
      message: 'no eligible providers after quota guard',
      retryable: true,
      attempts,
    };
  }

  for (const descriptor of ranked) {
    const resolved = opts.registry.resolve(descriptor.id);
    if (!resolved.ok) {
      attempts.push({
        providerId: descriptor.id,
        outcome: 'unavailable',
        code: 'PROVIDER_NOT_REGISTERED',
      });
      continue;
    }

    if (opts.beforeAttempt) {
      const allowed = await opts.beforeAttempt(descriptor.id);
      if (!allowed) {
        attempts.push({
          providerId: descriptor.id,
          outcome: 'skipped',
          code: 'QUOTA_RESERVE_FAILED',
        });
        continue;
      }
    }

    const outcome = await resolved.provider.generate(opts.request);
    if (opts.afterAttempt) await opts.afterAttempt(descriptor.id, outcome);

    if (outcome.success) {
      attempts.push({ providerId: descriptor.id, outcome: 'success', code: 'OK' });
      return {
        ok: true,
        providerId: descriptor.id,
        generation: outcome,
        attempts,
      };
    }

    if (isPermanentFailure(outcome)) {
      attempts.push({
        providerId: descriptor.id,
        outcome: 'permanent_failure',
        code: outcome.code,
      });
      return {
        ok: false,
        code: outcome.code,
        message: outcome.message,
        retryable: false,
        attempts,
      };
    }

    attempts.push({
      providerId: descriptor.id,
      outcome: 'retryable_failure',
      code: outcome.code,
    });
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    code: last?.code ?? 'ALL_PROVIDERS_FAILED',
    message: 'all eligible providers failed or unavailable',
    retryable: true,
    attempts,
  };
}
