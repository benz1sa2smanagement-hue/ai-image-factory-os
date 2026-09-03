/**
 * Cloudflare Workers AI image provider adapter (flux-1-schnell).
 * Lives OUTSIDE domain. Implements domain GenerationProvider.
 *
 * - MOCK_MODE / enabled=false → no network
 * - Credentials only from WorkersAiConfig (runtime secrets)
 * - ONE HTTP attempt per generate(); no internal retry loop
 * - Returns real JPEG bytes when API returns base64 JPEG
 *
 * Official docs used:
 * - https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
 * - https://developers.cloudflare.com/workers-ai/platform/pricing/ (2026-08-28)
 */

import type {
  GenerationProvider,
  GenerationRequest,
  GenerationOutcome,
  GenerationMetadata,
} from '../../domain/src/generation.js';
import {
  WORKERS_AI_PROVIDER_ID,
  WORKERS_AI_MODEL_ID,
  WORKERS_AI_DEFAULT_TIMEOUT_MS,
  WORKERS_AI_DEFAULT_STEPS,
  WORKERS_AI_MAX_STEPS,
  workersAiRunUrl,
  type WorkersAiConfig,
} from './workers-ai-config.js';
import { base64ToBytes, validateImageBytes } from './image-bytes.js';
import { freeProviderDescriptor } from '../../domain/src/provider-router.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WorkersAiProviderOptions {
  config: WorkersAiConfig;
  fetch?: FetchLike;
  mockMode?: boolean;
}

function mapHttpStatus(status: number, bodyText: string): GenerationOutcome {
  const snippet = bodyText.slice(0, 200);
  if (status === 401 || status === 403) {
    return { success: false, code: 'PROVIDER_AUTH', message: 'authentication failed', retryable: false };
  }
  if (status === 429) {
    return { success: false, code: 'PROVIDER_RATE_LIMIT', message: 'rate limited', retryable: true };
  }
  if (status === 400) {
    return {
      success: false,
      code: 'PROVIDER_INVALID_REQUEST',
      message: `invalid request: ${snippet}`,
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      success: false,
      code: 'PROVIDER_UNAVAILABLE',
      message: `upstream ${status}`,
      retryable: true,
    };
  }
  return {
    success: false,
    code: 'PROVIDER_UNKNOWN',
    message: `http ${status}`,
    retryable: true,
  };
}

function redactSecrets(text: string, token?: string): string {
  if (!token) return text;
  return text.split(token).join('[REDACTED]');
}

export class WorkersAiImageProvider implements GenerationProvider {
  readonly id = WORKERS_AI_PROVIDER_ID;
  readonly modelId: string;
  private readonly config: WorkersAiConfig;
  private readonly fetchFn: FetchLike;
  private readonly mockMode: boolean;
  private readonly timeoutMs: number;

  constructor(opts: WorkersAiProviderOptions) {
    this.config = opts.config;
    this.modelId = opts.config.modelId ?? WORKERS_AI_MODEL_ID;
    this.fetchFn = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
    this.mockMode = opts.mockMode === true || opts.config.enabled !== true;
    this.timeoutMs = opts.config.timeoutMs ?? WORKERS_AI_DEFAULT_TIMEOUT_MS;
  }

  async generate(request: GenerationRequest): Promise<GenerationOutcome> {
    if (this.mockMode) {
      return {
        success: false,
        code: 'PROVIDER_DISABLED',
        message: 'Workers AI provider disabled or MOCK_MODE — no network call',
        retryable: false,
      };
    }

    if (!this.config.apiToken || !this.config.accountId) {
      return {
        success: false,
        code: 'PROVIDER_AUTH',
        message: 'missing Workers AI credentials',
        retryable: false,
      };
    }

    if (request.format === 'png') {
      return {
        success: false,
        code: 'UNSUPPORTED_FORMAT',
        message: 'Workers AI flux-1-schnell returns JPEG; request format=jpeg',
        retryable: false,
      };
    }

    const steps = Math.min(
      WORKERS_AI_MAX_STEPS,
      Math.max(1, Number(request.parameters?.steps ?? WORKERS_AI_DEFAULT_STEPS))
    );

    const body: Record<string, unknown> = {
      prompt: request.prompt.slice(0, 2048),
      steps,
    };
    if (request.seed != null) body.seed = request.seed;

    const url = workersAiRunUrl(this.config.accountId, this.modelId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        return mapHttpStatus(res.status, redactSecrets(text, this.config.apiToken));
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          success: false,
          code: 'PROVIDER_MALFORMED_RESPONSE',
          message: 'response is not JSON',
          retryable: true,
        };
      }

      const imageB64 = extractImageBase64(parsed);
      if (!imageB64) {
        return {
          success: false,
          code: 'EMPTY_IMAGE',
          message: 'no image field in provider response',
          retryable: true,
        };
      }

      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(imageB64);
      } catch {
        return {
          success: false,
          code: 'PROVIDER_MALFORMED_RESPONSE',
          message: 'invalid base64 image',
          retryable: true,
        };
      }

      const validated = validateImageBytes(bytes, 'jpeg');
      if (!validated.ok) {
        return {
          success: false,
          code: validated.code,
          message: validated.message,
          retryable: true,
        };
      }

      const generatedAt = new Date().toISOString();
      const metadata: GenerationMetadata = {
        jobId: request.jobId,
        requestId: request.requestId,
        provider: this.id,
        model: this.modelId,
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        width: request.width,
        height: request.height,
        format: 'jpeg',
        seed: request.seed,
        generatedAt,
        mock: false,
      };

      return {
        success: true,
        provider: this.id,
        model: this.modelId,
        imageBytes: bytes,
        width: request.width,
        height: request.height,
        format: 'jpeg',
        mimeType: 'image/jpeg',
        seed: request.seed,
        metadata,
      };
    } catch (e) {
      const name = e && typeof e === 'object' ? (e as { name?: string }).name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        return {
          success: false,
          code: 'PROVIDER_TIMEOUT',
          message: `timeout after ${this.timeoutMs}ms`,
          retryable: true,
        };
      }
      return {
        success: false,
        code: 'PROVIDER_UNAVAILABLE',
        message: e instanceof Error ? redactSecrets(e.message, this.config.apiToken) : 'network error',
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractImageBase64(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.result && typeof o.result === 'object') {
    const r = o.result as Record<string, unknown>;
    if (typeof r.image === 'string') return r.image;
  }
  if (typeof o.image === 'string') return o.image;
  return null;
}

export function workersAiProviderDescriptor(
  over: { enabled?: boolean; priority?: number } = {}
) {
  return freeProviderDescriptor({
    id: WORKERS_AI_PROVIDER_ID,
    enabled: over.enabled === true,
    priority: over.priority ?? 10,
    qualityScore: 80,
    costPolicy: {
      mode: 'FREE',
      costPerGeneration: 0,
      currency: 'THB',
      freeOnlyEligible: true,
    },
    quotaPolicy: {
      quotaKey: `quota:${WORKERS_AI_PROVIDER_ID}`,
      dailyLimit: 10_000,
      reservationRequired: true,
      resetPolicy: 'daily',
    },
    healthPolicy: { status: 'HEALTHY' },
  });
}

export function createWorkersAiImageProvider(opts: WorkersAiProviderOptions): WorkersAiImageProvider {
  return new WorkersAiImageProvider(opts);
}
