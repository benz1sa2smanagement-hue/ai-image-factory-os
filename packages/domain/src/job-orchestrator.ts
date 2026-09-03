/**
 * Queue consumer orchestration helpers — pure + D1-aware.
 * Documents ack/retry/STOP behavior for Cloudflare Queues.
 *
 * Ack semantics (Workers Message):
 * - SUCCESS / permanent handled (incl. DLQ written) → ack()
 * - TRANSIENT (retryable / quota wait) → retry()  // CF native redelivery
 * - FACTORY_STOPPED → retry() so message is not lost; do not process or reserve quota
 * - Malformed / unknown job without durable work → ack() to avoid poison loop
 *
 * IMAGE_GENERATION may use GenerationService (MockGenerationProvider + Storage)
 * when storage is injected; otherwise falls back to runMockProcessor.
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
import { GenerationService } from './generation.js';
import { MockGenerationProvider } from './mock-generation.js';

export type ConsumerDisposition = 'ack' | 'retry';

export interface OrchestrationResult {
  disposition: ConsumerDisposition;
  code: string;
  detail?: string;
  jobId: string;
  idempotencyKey?: string;
  storageKey?: string;
}

const TERMINAL = new Set(['succeeded', 'dead_letter', 'cancelled']);

export async function orchestrateFactoryMessage(opts: {
  msg: FactoryQueueMessageV1;
  factoryStatus: string;
  db?: D1Like | null;
  /** Optional domain Storage (MemoryStorage in MOCK_MODE) */
  storage?: Storage | null;
  allowWithoutDb?: boolean;
}): Promise<OrchestrationResult> {
  const { msg, factoryStatus, db, storage } = opts;
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

  // IMAGE_GENERATION + storage → GenerationService (mock provider, no network)
  if (msg.jobType === 'IMAGE_GENERATION' && storage) {
    const service = new GenerationService({
      provider: new MockGenerationProvider(),
      storage,
    });
    const gen = await service.generateAndStore({
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
    });

    if (gen.success) {
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
        code: 'MOCK_SUCCESS',
        detail: `storageKey=${gen.storageKey}`,
        jobId,
        idempotencyKey,
        storageKey: gen.storageKey,
      };
    }

    if (db && reservationId) await d1Release({ db, reservationId, quotaId });

    const errorCode = gen.code;
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
          errorMessage: gen.message,
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
      code: gen.retryable ? 'RETRY' : errorCode,
      detail: gen.message,
      jobId,
      idempotencyKey,
    };
  }

  // Fallback: lightweight mock processor (no storage)
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
