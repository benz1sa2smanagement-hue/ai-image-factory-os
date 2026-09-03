/** Provider abstraction + router */

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
}

export interface ImageGenerationResult {
  imageBytes: Uint8Array;
  mimeType: string;
  providerId: string;
  modelId: string;
  meta?: Record<string, unknown>;
}

export interface ImageGenerationProvider {
  readonly id: string;
  readonly modelId: string;
  generate(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

export interface ProviderScoreInput {
  id?: string;
  enabled: boolean;
  freeAvailable: boolean;
  healthOk: boolean;
  quotaRemaining: number;
  failureRate: number;
  priority: number;
  cooldownUntil?: number;
  estimatedCost?: number;
}

export function scoreProvider(p: ProviderScoreInput): number | null {
  if (!p.enabled || !p.freeAvailable || !p.healthOk) return null;
  if (p.cooldownUntil && Date.now() < p.cooldownUntil) return null;
  if (p.quotaRemaining <= 0) return null;
  if (p.estimatedCost !== undefined && p.estimatedCost > 0) return null;
  return p.priority + p.failureRate * 100 - Math.min(p.quotaRemaining, 1000) * 0.01;
}

export function pickBestProvider(candidates: ProviderScoreInput[]): ProviderScoreInput | null {
  let best: ProviderScoreInput | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const s = scoreProvider(c);
    if (s === null) continue;
    if (s < bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

export interface RouterDecision {
  selected: ProviderScoreInput | null;
  reason: string;
  candidatesEvaluated: number;
}

export function routeProvider(candidates: ProviderScoreInput[]): RouterDecision {
  const selected = pickBestProvider(candidates);
  if (!selected) {
    return { selected: null, reason: 'NO_ELIGIBLE_PROVIDER', candidatesEvaluated: candidates.length };
  }
  return { selected, reason: 'SELECTED', candidatesEvaluated: candidates.length };
}

/** Verified listed on CF catalog 2026-09-03; not in Paid-only list */
export const PRIMARY_IMAGE_MODEL_ID = '@cf/black-forest-labs/flux-1-schnell' as const;
export const PRIMARY_PROVIDER_ID = 'cf_workers_ai' as const;
