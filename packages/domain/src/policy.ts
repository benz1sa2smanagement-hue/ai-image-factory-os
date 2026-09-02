/** Factory Constitution — zero-cost and safety gates */

export const FACTORY_CONSTITUTION = {
  MAX_ALLOWED_COST: 0,
  ALLOW_PAID_API: false,
  NEVER_GUESS: true,
  NEVER_UPLOAD_QC_FAIL: true,
  NEVER_DELETE_PENDING: true,
  AI_CANNOT_DEPLOY: true,
} as const;

export type CostDecision =
  | { allowed: true }
  | { allowed: false; reason: string; code: 'PAID_BLOCKED' | 'COST_EXCEEDED' | 'QUOTA' | 'POLICY' };

export function assertZeroCost(opts: {
  allowPaidApi: boolean;
  estimatedCost: number;
  freeAvailable: boolean;
}): CostDecision {
  if (opts.estimatedCost > FACTORY_CONSTITUTION.MAX_ALLOWED_COST) {
    return { allowed: false, reason: 'Estimated cost exceeds MAX_ALLOWED_COST (0)', code: 'COST_EXCEEDED' };
  }
  if (!opts.freeAvailable) {
    return { allowed: false, reason: 'Provider has no free capacity', code: 'QUOTA' };
  }
  if (opts.estimatedCost > 0 && !opts.allowPaidApi) {
    return { allowed: false, reason: 'Paid API blocked by policy', code: 'PAID_BLOCKED' };
  }
  if (opts.estimatedCost > 0 && !FACTORY_CONSTITUTION.ALLOW_PAID_API) {
    return { allowed: false, reason: 'Global ALLOW_PAID_API is false', code: 'PAID_BLOCKED' };
  }
  return { allowed: true };
}

export function canStartNewWork(factoryStatus: string): boolean {
  return factoryStatus === 'RUNNING';
}
