/**
 * Conservative free-quota guard — pure domain logic.
 * Does NOT talk to D1; applies safety margin on top of QuotaSnapshot / ProviderQuotaSnapshot.
 *
 * effectiveLimit = max(0, dailyLimit - safetyMarginUnits)
 * remainingEffective = max(0, effectiveLimit - used - reserved)
 *
 * UNKNOWN quota remains blocked (handled by router; guard also rejects status UNKNOWN).
 */

import type { QuotaSnapshot } from './quota.js';
import { availableUnits } from './quota.js';
import type { ProviderQuotaSnapshot, ProviderQuotaStatus } from './provider-router.js';

export interface QuotaGuardPolicy {
  /** Fixed units held back from daily limit (default 500 neurons) */
  safetyMarginUnits: number;
  /** Or percentage of dailyLimit 0–100 (applied if safetyMarginPercent set) */
  safetyMarginPercent?: number;
  unitsRequired: number;
}

export const DEFAULT_QUOTA_GUARD_POLICY: QuotaGuardPolicy = {
  safetyMarginUnits: 500,
  unitsRequired: 1,
};

export function computeEffectiveLimit(
  dailyLimit: number,
  policy: QuotaGuardPolicy = DEFAULT_QUOTA_GUARD_POLICY
): number {
  let margin = policy.safetyMarginUnits;
  if (policy.safetyMarginPercent != null) {
    margin = Math.max(
      margin,
      Math.ceil((dailyLimit * Math.min(100, Math.max(0, policy.safetyMarginPercent))) / 100)
    );
  }
  return Math.max(0, dailyLimit - margin);
}

export function remainingUnderGuard(
  snapshot: Pick<QuotaSnapshot, 'limitUnits' | 'usedUnits' | 'reservedUnits'>,
  policy: QuotaGuardPolicy = DEFAULT_QUOTA_GUARD_POLICY
): number {
  const effective = computeEffectiveLimit(snapshot.limitUnits, policy);
  return Math.max(0, effective - snapshot.usedUnits - snapshot.reservedUnits);
}

export type QuotaGuardDecision =
  | { ok: true; remaining: number; effectiveLimit: number }
  | {
      ok: false;
      reason:
        | 'QUOTA_EXHAUSTED'
        | 'QUOTA_UNKNOWN'
        | 'BELOW_SAFETY_MARGIN'
        | 'INVALID_UNITS';
      remaining: number;
      effectiveLimit: number;
    };

export function evaluateQuotaGuard(
  input: {
    limitUnits: number;
    usedUnits: number;
    reservedUnits: number;
    status?: ProviderQuotaStatus;
  },
  policy: QuotaGuardPolicy = DEFAULT_QUOTA_GUARD_POLICY
): QuotaGuardDecision {
  const units = policy.unitsRequired;
  if (units <= 0) {
    return { ok: false, reason: 'INVALID_UNITS', remaining: 0, effectiveLimit: 0 };
  }
  if (input.status === 'UNKNOWN') {
    return {
      ok: false,
      reason: 'QUOTA_UNKNOWN',
      remaining: 0,
      effectiveLimit: computeEffectiveLimit(input.limitUnits, policy),
    };
  }
  const effectiveLimit = computeEffectiveLimit(input.limitUnits, policy);
  const remaining = Math.max(0, effectiveLimit - input.usedUnits - input.reservedUnits);
  if (input.status === 'EXHAUSTED' || remaining < units) {
    return {
      ok: false,
      reason: remaining === 0 && input.usedUnits + input.reservedUnits >= input.limitUnits
        ? 'QUOTA_EXHAUSTED'
        : 'BELOW_SAFETY_MARGIN',
      remaining,
      effectiveLimit,
    };
  }
  return { ok: true, remaining, effectiveLimit };
}

/** Apply guard to classic QuotaSnapshot */
export function guardQuotaSnapshot(
  q: QuotaSnapshot,
  policy: QuotaGuardPolicy = DEFAULT_QUOTA_GUARD_POLICY
): QuotaGuardDecision {
  return evaluateQuotaGuard(
    {
      limitUnits: q.limitUnits,
      usedUnits: q.usedUnits,
      reservedUnits: q.reservedUnits,
    },
    policy
  );
}

/** Map ProviderQuotaSnapshot → guard decision */
export function guardProviderQuotaSnapshot(
  q: ProviderQuotaSnapshot,
  policy: QuotaGuardPolicy = DEFAULT_QUOTA_GUARD_POLICY
): QuotaGuardDecision {
  const usedAndReserved = Math.max(0, q.dailyLimit - q.remaining);
  return evaluateQuotaGuard(
    {
      limitUnits: q.dailyLimit,
      usedUnits: usedAndReserved,
      reservedUnits: 0,
      status: q.status,
    },
    policy
  );
}

/** Filter router quota list: mark below-margin as EXHAUSTED for selection */
export function applyGuardToQuotaSnapshots(
  quotas: ProviderQuotaSnapshot[],
  policy: QuotaGuardPolicy = DEFAULT_QUOTA_GUARD_POLICY
): ProviderQuotaSnapshot[] {
  return quotas.map((q) => {
    const decision = guardProviderQuotaSnapshot(q, policy);
    if (!decision.ok) {
      return {
        ...q,
        remaining: decision.remaining,
        status: decision.reason === 'QUOTA_UNKNOWN' ? 'UNKNOWN' : 'EXHAUSTED',
      };
    }
    return {
      ...q,
      remaining: decision.remaining,
      status: 'AVAILABLE' as const,
    };
  });
}
