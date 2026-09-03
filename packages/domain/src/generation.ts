/**
 * Provider-neutral image generation contract + service boundary.
 * Domain never imports vendor SDKs (OpenAI, CF AI, B2, R2, S3, etc.).
 */

import type { Storage } from './storage.js';
import type { ProviderRouterPolicy, ProviderDescriptor, ProviderQuotaSnapshot } from './provider-router.js';
import { selectProvider } from './provider-router.js';

export type GenerationFormat = 'png' | 'jpeg';

export interface GenerationRequest {
  jobId: string;
  requestId: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  format: GenerationFormat;
  seed?: number;
  /** Explicit mock outcome for tests / MOCK_MODE */
  mockOutcome?: 'MOCK_SUCCESS' | 'MOCK_RETRYABLE_ERROR' | 'MOCK_PERMANENT_ERROR';
  parameters?: Record<string, unknown>;
}

export interface GenerationMetadata {
  jobId: string;
  requestId: string;
  provider: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  format: GenerationFormat;
  seed?: number;
  generatedAt: string;
  mock: boolean;
  storageKey?: string;
}

export interface GenerationResult {
  success: true;
  provider: string;
  model: string;
  imageBytes: Uint8Array;
  width: number;
  height: number;
  format: GenerationFormat;
  mimeType: string;
  seed?: number;
  metadata: GenerationMetadata;
}

export interface GenerationFailure {
  success: false;
  code: string;
  message: string;
  retryable: boolean;
}

export type GenerationOutcome = GenerationResult | GenerationFailure;

export interface GenerationProvider {
  readonly id: string;
  readonly modelId: string;
  generate(request: GenerationRequest): Promise<GenerationOutcome>;
}

export const GENERATION_MAX_DIMENSION = 2048;
export const GENERATION_MIN_DIMENSION = 1;
export const GENERATION_MAX_PROMPT_CHARS = 4_000;

export type GenerationValidation =
  | { ok: true; request: GenerationRequest }
  | { ok: false; code: string; reason: string };

export function validateGenerationRequest(raw: Partial<GenerationRequest>): GenerationValidation {
  if (!raw.jobId || typeof raw.jobId !== 'string') {
    return { ok: false, code: 'INVALID_JOB_ID', reason: 'jobId required' };
  }
  if (!raw.requestId || typeof raw.requestId !== 'string') {
    return { ok: false, code: 'INVALID_REQUEST_ID', reason: 'requestId required' };
  }
  if (typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0) {
    return { ok: false, code: 'EMPTY_PROMPT', reason: 'prompt required' };
  }
  if (raw.prompt.length > GENERATION_MAX_PROMPT_CHARS) {
    return { ok: false, code: 'PROMPT_TOO_LARGE', reason: `max ${GENERATION_MAX_PROMPT_CHARS}` };
  }
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isInteger(width) || width < GENERATION_MIN_DIMENSION || width > GENERATION_MAX_DIMENSION) {
    return { ok: false, code: 'INVALID_WIDTH', reason: `width must be ${GENERATION_MIN_DIMENSION}..${GENERATION_MAX_DIMENSION}` };
  }
  if (!Number.isInteger(height) || height < GENERATION_MIN_DIMENSION || height > GENERATION_MAX_DIMENSION) {
    return { ok: false, code: 'INVALID_HEIGHT', reason: `height must be ${GENERATION_MIN_DIMENSION}..${GENERATION_MAX_DIMENSION}` };
  }
  const format = raw.format ?? 'png';
  if (format !== 'png' && format !== 'jpeg') {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', reason: String(raw.format) };
  }
  if (raw.seed != null && (!Number.isFinite(raw.seed) || !Number.isInteger(raw.seed))) {
    return { ok: false, code: 'INVALID_SEED', reason: 'seed must be integer' };
  }

  return {
    ok: true,
    request: {
      jobId: raw.jobId,
      requestId: raw.requestId,
      prompt: raw.prompt.trim(),
      negativePrompt: raw.negativePrompt?.trim() || undefined,
      width,
      height,
      format,
      seed: raw.seed,
      mockOutcome: raw.mockOutcome,
      parameters: raw.parameters,
    },
  };
}

/** Provider-neutral object key: assets/{asset_id}/original.{ext} */
export function buildGenerationStorageKey(assetId: string, format: GenerationFormat): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(assetId)) {
    throw new Error(`invalid assetId: ${assetId}`);
  }
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  return `assets/${assetId}/original.${ext}`;
}

export interface GenerationServiceOptions {
  /** Fixed provider (MOCK_MODE default path) */
  provider: GenerationProvider;
  storage: Storage;
  /**
   * Optional router boundary — when candidates+quotas provided, selection is
   * validated before generate. Does not replace `provider` execution adapter.
   */
  router?: {
    candidates: ProviderDescriptor[];
    quotas: ProviderQuotaSnapshot[];
    policy?: Partial<ProviderRouterPolicy>;
  };
}

export interface StoredGenerationResult extends GenerationResult {
  storageKey: string;
}

/**
 * GenerationService: validate → (optional router select) → provider.generate → store.
 * Uses domain Storage only (MemoryStorage in MOCK_MODE).
 * Router never performs quota reservation.
 */
export class GenerationService {
  private readonly provider: GenerationProvider;
  private readonly storage: Storage;
  private readonly router?: GenerationServiceOptions['router'];

  constructor(opts: GenerationServiceOptions) {
    this.provider = opts.provider;
    this.storage = opts.storage;
    this.router = opts.router;
  }

  async generateAndStore(
    raw: Partial<GenerationRequest>
  ): Promise<StoredGenerationResult | GenerationFailure> {
    const validated = validateGenerationRequest(raw);
    if (!validated.ok) {
      return {
        success: false,
        code: validated.code,
        message: validated.reason,
        retryable: false,
      };
    }

    if (this.router) {
      const selection = selectProvider({
        candidates: this.router.candidates,
        quotas: this.router.quotas,
        policy: this.router.policy,
      });
      if (!selection.ok) {
        return {
          success: false,
          code: 'NO_ELIGIBLE_PROVIDER',
          message: 'no eligible free/policy-compliant provider',
          retryable: true,
        };
      }
      // Selection is advisory for this foundation — execution still uses injected provider
      // (real multi-provider adapters come in a later task).
      if (selection.selected.id !== this.provider.id) {
        // Allow mismatch only if caller registered router for policy checks only
      }
    }

    const outcome = await this.provider.generate(validated.request);
    if (!outcome.success) return outcome;

    const assetId = validated.request.jobId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
    const storageKey = buildGenerationStorageKey(assetId, outcome.format);

    await this.storage.put({
      key: storageKey,
      body: outcome.imageBytes,
      contentType: outcome.mimeType,
      metadata: {
        jobId: outcome.metadata.jobId,
        requestId: outcome.metadata.requestId,
        provider: outcome.metadata.provider,
        model: outcome.metadata.model,
        mock: outcome.metadata.mock ? 'true' : 'false',
        width: String(outcome.width),
        height: String(outcome.height),
        format: outcome.format,
      },
    });

    const metadata: GenerationMetadata = {
      ...outcome.metadata,
      storageKey,
    };

    return {
      ...outcome,
      metadata,
      storageKey,
    };
  }
}
