/**
 * Queue consumer orchestration — IMAGE_GENERATION uses runGenerationPipeline.
 *
 * Ack semantics:
 * - SUCCESS / permanent handled (incl. DLQ written) → ack()
 * - TRANSIENT (retryable / quota wait) → retry()
 * - FACTORY_STOPPED → retry() (no process, no quota)
 *
 * Dependency injection: storage, registry, candidates, quotas (provider-neutral).
 * MOCK_MODE: MemoryStorage + mock providers; no network.
 */

import { decideRetry, type RetryDecision } from './retry.js';
import { canStartNewWork } from './policy.js';
import { runMockProcessor, type MockOutcome } from './mock-processor.js';
import {
  d1GetJob,
  d1TransitionJobStatus,
  d1MoveJobToDeadLetter,
  d1IncrementAttemptAndScheduleRetry,
  type JobRow,
} from './jobs-d1.js';
import type { D1Like } from './quota-d1.js';
import { d1Reserve, d1Commit, d1Release } from './quota-d1.js';
import { PRIMARY_IMAGE_MODEL_ID } from './providers.js';
import type { FactoryQueueMessageV1 } from './queue-message.js';
import type { Storage } from './storage.js';
import { ProviderRegistry } from './provider-registry.js';
import { createMockProvider } from './mock-generation.js';
import {
  freeProviderDescriptor,
  type ProviderDescriptor,
  type ProviderQuotaSnapshot,
} from './provider-router.js';
import { runGenerationPipeline, classifyFailure } from './generation-pipeline.js';
import { DEFAULT_QUOTA_GUARD_POLICY, type QuotaGuardPolicy } from './quota-guard.js';

export type ConsumerDisposition = 'ack' | 'retry';

export interface OrchestrationResult {
  disposition: ConsumerDisposition;
  code: string;
  detail?: string;
  jobId: string;
  idempotencyKey?: string;
  storageKey?: string;
  phase?: string;
  providerId?: string;
  failureCategory?: string;
}

const TERMINAL = new Set(['succeeded', 'dead_letter', 'cancelled']);

/** Default MOCK registry: single mock-free-a provider */
export function defaultMockRegistry(): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.register(createMockProvider('mock-free-a'));
  return reg;
}

export function defaultMockCandidates(): ProviderDescriptor[] {
  return [freeProviderDescriptor({ id: 'mock-free-a', priority: 1, qualityScore: 80 })];
}

export function defaultMockQuotas(): ProviderQuotaSnapshot[] {
  return [
    {
      providerId: 'mock-free-a',
      remaining: 9_000,
      dailyLimit: 10_000,
      status: 'AVAILABLE',
    },
  ];
}

export async function orchestrateFactoryMessage(opts: {
  msg: FactoryQueueMessageV1;
  factoryStatus: string;
  db?: D1Like | null;
  storage?: Storage | null;
  allowWithoutDb?: boolean;
  registry?: ProviderRegistry;
  candidates?: ProviderDescriptor[];
  quotas?: ProviderQuotaSnapshot[];
  quotaGuard?: QuotaGuardPolicy;
}): Promise<OrchestrationResult> {
  const { msg, factoryStatus, db } = opts;
  const jobId = msg.jobId;
  const idempotencyKey = msg.idempotencyKey;

  if (!canStartNewWork(factoryStatus) && msg.jobType === 'IMAGE_GENERATION') {
    return {
      disposition: 'retry',
      code: 'FACTORY_STOPPED',
      detail: 'kill switch active — message not acked so it remains recoverable',
      jobId,
      idempotencyKey,
    };
  }

  let job: JobRow | null = null;
  if (db) {
    job = await d1GetJob(db, jobId);
    if (!job) {
      return {
        disposition: 'ack',
        code: 'UNKNOWN_JOB',
        detail: 'no D1 job row — acked to avoid poison redelivery',
        jobId,
        idempotencyKey,
      };
    }
    if (job.idempotency_key && job.idempotency_key !== msg.idempotencyKey) {
      return {
        disposition: 'ack',
        code: 'IDEMPOTENCY_MISMATCH',
        detail: 'message idempotency_key does not match job',
        jobId,
        idempotencyKey,
      };
    }
    if (TERMINAL.has(String(job.status).toLowerCase()) || job.status === 'succeeded') {
      return {
        disposition: 'ack',
        code: 'ALREADY_TERMINAL',
        detail: `status=${job.status}`,
        jobId,
        idempotencyKey,
      };
    }
  } else if (!opts.allowWithoutDb) {
    return {
      disposition: 'ack',
      code: 'DB_NOT_BOUND',
      detail: 'consumer requires DB for durable orchestration',
      jobId,
      idempotencyKey,
    };
  }

  const attempt = msg.attempt;
  const mockOutcome = (msg.payload?.mockOutcome as MockOutcome | undefined) ?? 'MOCK_SUCCESS';

  if (msg.jobType === 'IMAGE_GENERATION' && opts.storage) {
    if (db && job) {
      const from = job.status;
      if (
        from === 'queued' ||
        from === 'pending' ||
        from === 'failed' ||
        from === 'waiting_for_quota'
      ) {
        await d1TransitionJobStatus(db, {
          jobId,
          fromStatus: from,
          toStatus: 'running',
          actor: 'consumer',
        });
      }
    }

    const registry = opts.registry ?? defaultMockRegistry();
    const candidates = opts.candidates ?? defaultMockCandidates();
    const quotas = opts.quotas ?? defaultMockQuotas();

    const activeReservations = new Map<string, { reservationId: string; quotaId?: string }>();

    const pipeline = await runGenerationPipeline({
      request: {
        jobId,
        requestId: msg.requestId,
        prompt: String(msg.payload?.prompt ?? 'stock product photo'),
        negativePrompt:
          msg.payload?.negativePrompt != null ? String(msg.payload.negativePrompt) : undefined,
        width: Number(msg.payload?.width ?? 512),
        height: Number(msg.payload?.height ?? 512),
        format: 'png',
        seed: msg.payload?.seed != null ? Number(msg.payload.seed) : undefined,
        mockOutcome,
      },
      attempt,
      storage: opts.storage,
      registry,
      candidates,
      quotas,
      quotaGuard: opts.quotaGuard ?? DEFAULT_QUOTA_GUARD_POLICY,
      relaxQcDimensions: true,
      reserve: async (providerId) => {
        if (!db) return true;
        try {
          const reserved = await d1Reserve({
            db,
            providerId,
            modelId: PRIMARY_IMAGE_MODEL_ID,
            window: 'daily',
            units: 1,
            jobId,
            idempotencyKey: `quota:${jobId}:${attempt}:${providerId}`,
          });
          if (!reserved.ok) {
            if (reserved.reason === 'INSUFFICIENT_QUOTA') return false;
            return true;
          }
          activeReservations.set(providerId, {
            reservationId: reserved.reservationId,
            quotaId: reserved.quotaId,
          });
          return true;
        } catch {
          return true;
        }
      },
      commit: async (providerId) => {
        if (!db) return;
        const r = activeReservations.get(providerId);
        if (r) await d1Commit({ db, reservationId: r.reservationId, quotaId: r.quotaId });
      },
      release: async (providerId) => {
        if (!db) return;
        const r = activeReservations.get(providerId);
        if (r) {
          await d1Release({ db, reservationId: r.reservationId, quotaId: r.quotaId });
          activeReservations.delete(providerId);
        }
      },
    });

    if (pipeline.ok) {
      if (db) {
        const fresh = await d1GetJob(db, jobId);
        await d1TransitionJobStatus(db, {
          jobId,
          fromStatus: fresh?.status ?? 'running',
          toStatus: 'succeeded',
          actor: 'consumer',
        });
      }
      return {
        disposition: 'ack',
        code: 'PIPELINE_PASSED',
        detail: `storageKey=${pipeline.storageKey};provider=${pipeline.providerId}`,
        jobId,
        idempotencyKey,
        storageKey: pipeline.storageKey,
        phase: pipeline.phase,
        providerId: pipeline.providerId,
      };
    }

    const errorCode = pipeline.code;
    const cls = classifyFailure(errorCode);
    const decision: RetryDecision = decideRetry({
      attemptCount: attempt,
      errorCode,
      rng: () => 0.5,
    });

    if (pipeline.failureCategory === 'QC_REJECTED' || !pipeline.retryable) {
      if (db) {
        const fresh = await d1GetJob(db, jobId);
        await d1MoveJobToDeadLetter(db, {
          jobId,
          fromStatus: fresh?.status ?? 'running',
          reason: pipeline.message,
          expectedAttemptCount: attempt,
          errorCode,
          errorMessage: pipeline.message,
          requestId: msg.requestId,
          idempotencyKey: msg.idempotencyKey,
          jobType: msg.jobType,
          payloadJson: JSON.stringify(msg.payload ?? {}),
        });
      }
      return {
        disposition: 'ack',
        code: 'DEAD_LETTER',
        detail: pipeline.message,
        jobId,
        idempotencyKey,
        phase: pipeline.phase,
        failureCategory: pipeline.failureCategory,
      };
    }

    if (db) {
      if (decision.action === 'dead_letter') {
        const fresh = await d1GetJob(db, jobId);
        await d1MoveJobToDeadLetter(db, {
          jobId,
          fromStatus: fresh?.status ?? 'running',
          reason: decision.reason,
          expectedAttemptCount: attempt,
          errorCode,
          errorMessage: pipeline.message,
          requestId: msg.requestId,
          idempotencyKey: msg.idempotencyKey,
          jobType: msg.jobType,
          payloadJson: JSON.stringify(msg.payload ?? {}),
        });
        return {
          disposition: 'ack',
          code: 'DEAD_LETTER',
          detail: decision.reason,
          jobId,
          idempotencyKey,
          failureCategory: cls.category,
        };
      }
      await d1IncrementAttemptAndScheduleRetry(db, {
        jobId,
        fromStatus: (await d1GetJob(db, jobId))?.status ?? 'running',
        expectedAttemptCount: attempt,
        errorCode,
      });
    }

    return {
      disposition: 'retry',
      code: pipeline.retryable ? 'RETRY' : errorCode,
      detail: pipeline.message,
      jobId,
      idempotencyKey,
      phase: pipeline.phase,
      failureCategory: pipeline.failureCategory,
    };
  }

  let reservationId: string | undefined;
  let quotaId: string | undefined;
  if (db && msg.jobType === 'IMAGE_GENERATION') {
    const reserved = await d1Reserve({
      db,
      providerId: 'cf_workers_ai',
      modelId: PRIMARY_IMAGE_MODEL_ID,
      window: 'daily',
      units: 1,
      jobId,
      idempotencyKey: `quota:${jobId}:${attempt}`,
    });
    if (!reserved.ok) {
      const code =
        reserved.reason === 'INSUFFICIENT_QUOTA' ? 'WAITING_FOR_QUOTA' : reserved.reason;
      return {
        disposition: 'retry',
        code,
        detail: reserved.reason,
        jobId,
        idempotencyKey,
      };
    }
    reservationId = reserved.reservationId;
    quotaId = reserved.quotaId;
  }

  if (db && job) {
    const from = job.status;
    if (from === 'queued' || from === 'pending' || from === 'failed' || from === 'waiting_for_quota') {
      await d1TransitionJobStatus(db, {
        jobId,
        fromStatus: from,
        toStatus: 'running',
        actor: 'consumer',
      });
    }
  }

  const processed = runMockProcessor({
    jobId,
    jobType: msg.jobType,
    attempt,
    mockOutcome,
  });

  if (processed.ok) {
    if (db && reservationId) await d1Commit({ db, reservationId, quotaId });
    if (db) {
      const fresh = await d1GetJob(db, jobId);
      await d1TransitionJobStatus(db, {
        jobId,
        fromStatus: fresh?.status ?? 'running',
        toStatus: 'succeeded',
        actor: 'consumer',
      });
    }
    return {
      disposition: 'ack',
      code: processed.code,
      detail: processed.detail,
      jobId,
      idempotencyKey,
    };
  }

  if (db && reservationId) await d1Release({ db, reservationId, quotaId });

  const errorCode = processed.code;
  const decision: RetryDecision = decideRetry({
    attemptCount: attempt,
    errorCode,
    rng: () => 0.5,
  });

  if (db) {
    if (decision.action === 'dead_letter') {
      const fresh = await d1GetJob(db, jobId);
      await d1MoveJobToDeadLetter(db, {
        jobId,
        fromStatus: fresh?.status ?? 'running',
        reason: decision.reason,
        expectedAttemptCount: attempt,
        errorCode,
        errorMessage: processed.detail,
        requestId: msg.requestId,
        idempotencyKey: msg.idempotencyKey,
        jobType: msg.jobType,
        payloadJson: JSON.stringify(msg.payload ?? {}),
      });
      return {
        disposition: 'ack',
        code: 'DEAD_LETTER',
        detail: decision.reason,
        jobId,
        idempotencyKey,
      };
    }
    await d1IncrementAttemptAndScheduleRetry(db, {
      jobId,
      fromStatus: (await d1GetJob(db, jobId))?.status ?? 'running',
      expectedAttemptCount: attempt,
      errorCode,
    });
  }

  if (decision.action === 'dead_letter') {
    return {
      disposition: 'ack',
      code: 'DEAD_LETTER',
      detail: decision.reason,
      jobId,
      idempotencyKey,
    };
  }

  return {
    disposition: 'retry',
    code: processed.retryable ? 'RETRY' : errorCode,
    detail: processed.detail,
    jobId,
    idempotencyKey,
  };
}
