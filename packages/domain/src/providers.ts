/** Provider abstraction — never bind factory to a single vendor */

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
  enabled: boolean;
  freeAvailable: boolean;
  healthOk: boolean;
  quotaRemaining: number;
  failureRate: number;
  priority: number;
  cooldownUntil?: number;
}

/** Lower score = better candidate */
export function scoreProvider(p: ProviderScoreInput): number | null {
  if (!p.enabled || !p.freeAvailable || !p.healthOk) return null;
  if (p.cooldownUntil && Date.now() < p.cooldownUntil) return null;
  if (p.quotaRemaining <= 0) return null;
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
