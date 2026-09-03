/**
 * Production-oriented generation pipeline (MOCK-safe):
 * QUEUED → GENERATING → generate(+fallback) → Storage → QC → PASSED | REJECTED
 *
 * Does not enable real network by itself — callers inject providers/registry.
 */

import type { Storage } from './storage.js';
import type { ProviderDescriptor, ProviderQuotaSnapshot, ProviderRouterPolicy } from './provider-router.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { QuotaGuardPolicy } from './quota-guard.js';
import { DEFAULT_QUOTA_GUARD_POLICY } from './quota-guard.js';
import { runProviderFallback, type FallbackAttemptRecord } from './provider-fallback.js';
import { validateStoredAsset, type AssetQcResult } from './asset-qc.js';
import {
  validateGenerationRequest,
  buildGenerationStorageKey,
  type GenerationRequest,
  type GenerationFailure,
} from './generation.js';

export type PipelinePhase =
  | 'QUEUED'
  | 'GENERATING'
  | 'GENERATED'
  | 'QC'
  | 'PASSED'
  | 'REJECTED'
  | 'FAILED';

export interface PipelineTrace {
  jobId: string;
  attempt: number;
  phase: PipelinePhase;
  providerId?: string;
  modelId?: string;
  storageKey?: string;
  qcVerdict?: string;
  failureCategory?: string;
  attempts?: FallbackAttemptRecord[];
}

export type PipelineResult =
  | {
      ok: true;
      phase: 'PASSED';
      storageKey: string;
      providerId: string;
      modelId: string;
      qc: AssetQcResult;
      trace: PipelineTrace;
    }
  | {
      ok: false;
      phase: PipelinePhase;
      code: string;
      message: string;
      retryable: boolean;
      failureCategory: string;
      trace: PipelineTrace;
    };

export function classifyFailure(code: string): {
  category: string;
  retryable: boolean;
} {
  const c = code.toUpperCase();
  if (c.includes('AUTH') || c.includes('PERMISSION')) {
    return { category: 'AUTH', retryable: false };
  }
  if (c.includes('INVALID') || c.includes('UNSUPPORTED') || c.includes('EMPTY_PROMPT')) {
    return { category: 'INVALID_REQUEST', retryable: false };
  }
  if (c.includes('RATE_LIMIT') || c.includes('429')) {
    return { category: 'RATE_LIMIT', retryable: true };
  }
  if (c.includes('TIMEOUT')) {
    return { category: 'TIMEOUT', retryable: true };
  }
  if (c.includes('QUOTA') || c.includes('NO_ELIGIBLE')) {
    return { category: 'QUOTA_EXHAUSTED', retryable: true };
  }
  if (c.includes('STORAGE')) {
    return { category: 'STORAGE_ERROR', retryable: true };
  }
  if (c.includes('QC') || c.includes('REJECT')) {
    return { category: 'QC_REJECTED', retryable: false };
  }
  if (c.includes('UNAVAILABLE') || c.includes('MALFORMED')) {
    return { category: 'UNAVAILABLE', retryable: true };
  }
  return { category: 'UNKNOWN', retryable: true };
}

export async function runGenerationPipeline(opts: {
  request: Partial<GenerationRequest>;
  attempt?: number;
  storage: Storage;
  registry: ProviderRegistry;
  candidates: ProviderDescriptor[];
  quotas: ProviderQuotaSnapshot[];
  routerPolicy?: Partial<ProviderRouterPolicy>;
  quotaGuard?: QuotaGuardPolicy;
  relaxQcDimensions?: boolean;
  /** Per-provider reserve; return false to skip */
  reserve?: (providerId: string) => Promise<boolean>;
  commit?: (providerId: string) => Promise<void>;
  release?: (providerId: string) => Promise<void>;
}): Promise<PipelineResult> {
  const attempt = opts.attempt ?? 0;
  const validated = validateGenerationRequest(opts.request);
  if (!validated.ok) {
    const trace: PipelineTrace = {
      jobId: String(opts.request.jobId ?? ''),
      attempt,
      phase: 'FAILED',
      failureCategory: 'INVALID_REQUEST',
    };
    return {
      ok: false,
      phase: 'FAILED',
      code: validated.code,
      message: validated.reason,
      retryable: false,
      failureCategory: 'INVALID_REQUEST',
      trace,
    };
  }

  const req = validated.request;
  const trace: PipelineTrace = {
    jobId: req.jobId,
    attempt,
    phase: 'GENERATING',
  };

  const reservedFor: string[] = [];

  const fallback = await runProviderFallback({
    request: req,
    candidates: opts.candidates,
    quotas: opts.quotas,
    registry: opts.registry,
    routerPolicy: opts.routerPolicy,
    quotaGuard: opts.quotaGuard ?? DEFAULT_QUOTA_GUARD_POLICY,
    beforeAttempt: async (providerId) => {
      if (!opts.reserve) return true;
      const ok = await opts.reserve(providerId);
      if (ok) reservedFor.push(providerId);
      return ok;
    },
    afterAttempt: async (providerId, outcome) => {
      if (outcome.success) {
        if (opts.commit) await opts.commit(providerId);
      } else if (opts.release && reservedFor.includes(providerId)) {
        await opts.release(providerId);
      }
    },
  });

  trace.attempts = fallback.attempts;

  if (!fallback.ok) {
    const cls = classifyFailure(fallback.code);
    trace.phase = 'FAILED';
    trace.failureCategory = cls.category;
    return {
      ok: false,
      phase: 'FAILED',
      code: fallback.code,
      message: fallback.message,
      retryable: fallback.retryable,
      failureCategory: cls.category,
      trace,
    };
  }

  const gen = fallback.generation;
  trace.providerId = gen.provider;
  trace.modelId = gen.model;
  trace.phase = 'GENERATED';

  const assetId = req.jobId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const storageKey = buildGenerationStorageKey(assetId, gen.format);

  try {
    await opts.storage.put({
      key: storageKey,
      body: gen.imageBytes,
      contentType: gen.mimeType,
      metadata: {
        jobId: req.jobId,
        requestId: req.requestId,
        provider: gen.provider,
        model: gen.model,
        mock: gen.metadata.mock ? 'true' : 'false',
        width: String(gen.width),
        height: String(gen.height),
        format: gen.format,
      },
    });
  } catch (e) {
    if (opts.release) await opts.release(gen.provider);
    trace.phase = 'FAILED';
    trace.failureCategory = 'STORAGE_ERROR';
    return {
      ok: false,
      phase: 'FAILED',
      code: 'STORAGE_ERROR',
      message: e instanceof Error ? e.message : 'storage put failed',
      retryable: true,
      failureCategory: 'STORAGE_ERROR',
      trace,
    };
  }

  trace.storageKey = storageKey;
  trace.phase = 'QC';

  const qc = await validateStoredAsset(opts.storage, {
    storageKey,
    jobId: req.jobId,
    expectedWidth: gen.width,
    expectedHeight: gen.height,
    relaxDimensions: opts.relaxQcDimensions !== false,
  });

  if (qc.verdict !== 'PASSED') {
    trace.phase = 'REJECTED';
    trace.qcVerdict = 'REJECTED';
    trace.failureCategory = 'QC_REJECTED';
    return {
      ok: false,
      phase: 'REJECTED',
      code: 'QC_REJECTED',
      message: qc.summary.reasonCodes.join(',') || 'qc_failed',
      retryable: false,
      failureCategory: 'QC_REJECTED',
      trace,
    };
  }

  trace.phase = 'PASSED';
  trace.qcVerdict = 'PASSED';
  return {
    ok: true,
    phase: 'PASSED',
    storageKey,
    providerId: gen.provider,
    modelId: gen.model,
    qc,
    trace,
  };
}
