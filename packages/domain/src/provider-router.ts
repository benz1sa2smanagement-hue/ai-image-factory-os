/**
 * ProviderRouter — provider-neutral selection with 0 THB cost policy.
 *
 * Does NOT reserve/commit/release quota (Quota Manager remains SoT).
 * Does NOT call network or hold credentials.
 * Does NOT select paid providers unless policy explicitly allows.
 *
 * Selection order (deterministic):
 * 1. eligible (enabled, image-capable, cost policy, paid gate, quota, health)
 * 2. among eligible: higher priority wins (lower numeric priority = better)
 * 3. higher qualityScore wins
 * 4. stable provider id ascending as final tie-breaker
 */

import { FACTORY_CONSTITUTION } from './policy.js';

export type ProviderCostMode = 'FREE' | 'PAID';

export type ProviderHealthStatus = 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'UNAVAILABLE';

export type ProviderQuotaStatus = 'AVAILABLE' | 'EXHAUSTED' | 'UNKNOWN';

export interface ProviderCostPolicy {
  mode: ProviderCostMode;
  /** Integer cost units; 0 for free */
  costPerGeneration: number;
  currency: string;
  freeOnlyEligible: boolean;
}

export interface ProviderQuotaPolicy {
  quotaKey: string;
  dailyLimit?: number;
  reservationRequired: boolean;
  resetPolicy?: 'daily' | 'monthly' | 'none';
}

export interface ProviderHealthPolicy {
  status: ProviderHealthStatus;
  /** Unix ms; if set and now < cooldownUntil → COOLDOWN */
  cooldownUntil?: number;
}

export interface ProviderDescriptor {
  id: string;
  enabled: boolean;
  supportsImageGeneration: boolean;
  /** Lower = higher precedence */
  priority: number;
  /** Higher = preferred when priority ties */
  qualityScore: number;
  costPolicy: ProviderCostPolicy;
  quotaPolicy: ProviderQuotaPolicy;
  healthPolicy: ProviderHealthPolicy;
}

/** Read-only quota view — router never mutates or talks to D1 */
export interface ProviderQuotaSnapshot {
  providerId: string;
  remaining: number;
  dailyLimit: number;
  resetAt?: string | null;
  status: ProviderQuotaStatus;
}

export interface ProviderRouterPolicy {
  allowPaidProviders: boolean;
  maxAllowedCost: number;
  /** Units required for this selection (default 1) */
  unitsRequired?: number;
  /** Clock for cooldown checks (tests inject fixed now) */
  now?: number;
}

export const DEFAULT_ROUTER_POLICY: ProviderRouterPolicy = {
  allowPaidProviders: FACTORY_CONSTITUTION.ALLOW_PAID_API,
  maxAllowedCost: FACTORY_CONSTITUTION.MAX_ALLOWED_COST,
  unitsRequired: 1,
};

export type IneligibilityReason =
  | 'DISABLED'
  | 'NOT_IMAGE_PROVIDER'
  | 'PAID_BLOCKED'
  | 'COST_EXCEEDED'
  | 'QUOTA_EXHAUSTED'
  | 'QUOTA_UNKNOWN'
  | 'UNHEALTHY'
  | 'COOLDOWN'
  | 'DEGRADED_OPTIONAL'; // reserved — degraded still eligible unless UNAVAILABLE

export interface ProviderEvaluation {
  providerId: string;
  eligible: boolean;
  reasons: IneligibilityReason[];
  priority: number;
  qualityScore: number;
}

export type RouterSelectResult =
  | {
      ok: true;
      selected: ProviderDescriptor;
      evaluations: ProviderEvaluation[];
      candidatesEvaluated: number;
    }
  | {
      ok: false;
      reason: 'NO_ELIGIBLE_PROVIDER';
      evaluations: ProviderEvaluation[];
      candidatesEvaluated: number;
    };

function resolveHealth(
  health: ProviderHealthPolicy,
  now: number
): ProviderHealthStatus {
  if (health.cooldownUntil != null && now < health.cooldownUntil) {
    return 'COOLDOWN';
  }
  return health.status;
}

function evaluateProvider(
  p: ProviderDescriptor,
  quota: ProviderQuotaSnapshot | undefined,
  policy: ProviderRouterPolicy,
  now: number
): ProviderEvaluation {
  const reasons: IneligibilityReason[] = [];

  if (!p.enabled) reasons.push('DISABLED');
  if (!p.supportsImageGeneration) reasons.push('NOT_IMAGE_PROVIDER');

  // Cost / paid gate — never auto-select paid when allowPaidProviders=false
  if (p.costPolicy.mode === 'PAID' && !policy.allowPaidProviders) {
    reasons.push('PAID_BLOCKED');
  }
  if (p.costPolicy.costPerGeneration > policy.maxAllowedCost) {
    reasons.push('COST_EXCEEDED');
  }
  if (
    p.costPolicy.costPerGeneration > 0 &&
    !policy.allowPaidProviders
  ) {
    if (!reasons.includes('PAID_BLOCKED')) reasons.push('PAID_BLOCKED');
  }

  // Quota — UNKNOWN is NOT infinite free
  const units = policy.unitsRequired ?? 1;
  if (!quota) {
    reasons.push('QUOTA_UNKNOWN');
  } else if (quota.status === 'UNKNOWN') {
    reasons.push('QUOTA_UNKNOWN');
  } else if (quota.status === 'EXHAUSTED' || quota.remaining < units) {
    reasons.push('QUOTA_EXHAUSTED');
  }

  const health = resolveHealth(p.healthPolicy, now);
  if (health === 'UNAVAILABLE') reasons.push('UNHEALTHY');
  if (health === 'COOLDOWN') reasons.push('COOLDOWN');

  return {
    providerId: p.id,
    eligible: reasons.length === 0,
    reasons,
    priority: p.priority,
    qualityScore: p.qualityScore,
  };
}

/**
 * Rank eligible providers: priority ASC, qualityScore DESC, id ASC.
 */
export function rankEligible(
  descriptors: ProviderDescriptor[],
  evaluations: ProviderEvaluation[]
): ProviderDescriptor[] {
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  const eligible = evaluations
    .filter((e) => e.eligible)
    .map((e) => byId.get(e.providerId)!)
    .filter(Boolean);

  eligible.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return eligible;
}

export function selectProvider(opts: {
  candidates: ProviderDescriptor[];
  quotas: ProviderQuotaSnapshot[];
  policy?: Partial<ProviderRouterPolicy>;
}): RouterSelectResult {
  const policy: ProviderRouterPolicy = {
    ...DEFAULT_ROUTER_POLICY,
    ...opts.policy,
  };
  const now = policy.now ?? Date.now();
  const quotaByProvider = new Map(opts.quotas.map((q) => [q.providerId, q]));

  const evaluations = opts.candidates.map((p) =>
    evaluateProvider(p, quotaByProvider.get(p.id), policy, now)
  );

  const ranked = rankEligible(opts.candidates, evaluations);
  if (ranked.length === 0) {
    return {
      ok: false,
      reason: 'NO_ELIGIBLE_PROVIDER',
      evaluations,
      candidatesEvaluated: opts.candidates.length,
    };
  }

  return {
    ok: true,
    selected: ranked[0]!,
    evaluations,
    candidatesEvaluated: opts.candidates.length,
  };
}

/**
 * List all currently eligible providers in rank order (for caller fallback).
 * Router still does not reserve quota or execute generation.
 */
export function listEligibleProviders(opts: {
  candidates: ProviderDescriptor[];
  quotas: ProviderQuotaSnapshot[];
  policy?: Partial<ProviderRouterPolicy>;
}): ProviderDescriptor[] {
  const result = selectProvider(opts);
  return rankEligible(opts.candidates, result.evaluations);
}

/** Helper: FREE descriptor template for tests / MOCK registration */
export function freeProviderDescriptor(
  over: Partial<ProviderDescriptor> & Pick<ProviderDescriptor, 'id'>
): ProviderDescriptor {
  return {
    id: over.id,
    enabled: over.enabled ?? true,
    supportsImageGeneration: over.supportsImageGeneration ?? true,
    priority: over.priority ?? 100,
    qualityScore: over.qualityScore ?? 50,
    costPolicy: over.costPolicy ?? {
      mode: 'FREE',
      costPerGeneration: 0,
      currency: 'THB',
      freeOnlyEligible: true,
    },
    quotaPolicy: over.quotaPolicy ?? {
      quotaKey: `quota:${over.id}`,
      reservationRequired: true,
      resetPolicy: 'daily',
    },
    healthPolicy: over.healthPolicy ?? { status: 'HEALTHY' },
  };
}

export function paidProviderDescriptor(
  over: Partial<ProviderDescriptor> & Pick<ProviderDescriptor, 'id'>
): ProviderDescriptor {
  return freeProviderDescriptor({
    ...over,
    costPolicy: over.costPolicy ?? {
      mode: 'PAID',
      costPerGeneration: 1,
      currency: 'THB',
      freeOnlyEligible: false,
    },
  });
}
