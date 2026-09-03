/**
 * Queue Consumer Worker — MOCK_MODE safe lifecycle.
 * Marketplace remains READY_TO_UPLOAD → MANUAL
 */

import {
  canStartNewWork,
  assertZeroCost,
  applyReserve,
  estimateFluxSchnellNeurons,
  routeProvider,
  runQcPipeline,
  checkDuplicates,
  decideRetry,
  decideCleanup,
  evaluateWatchdogJob,
  FACTORY_CONSTITUTION,
  PRIMARY_IMAGE_MODEL_ID,
  d1Reserve,
  d1Commit,
  d1Release,
  computePhashFromImageBytes,
  computePhashFromRgba,
  type JobType,
} from '../../../packages/domain/src/index.js';
import { MockImageProvider } from '../../../packages/providers/src/mock-image.js';

export interface Env {
  DB?: D1Database;
  ASSETS?: R2Bucket;
  FACTORY_QUEUE?: Queue;
  AI?: Ai;
  MOCK_MODE?: string;
}

export interface FactoryMessage {
  jobId: string;
  type: JobType;
  attempt?: number;
  payload?: Record<string, unknown>;
}

async function getFactoryStatus(env: Env): Promise<string> {
  if (!env.DB) return 'STOPPED';
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM settings WHERE key = 'factory_status' LIMIT 1`
    ).first<{ value: string }>();
    return row?.value ?? 'STOPPED';
  } catch {
    return 'STOPPED';
  }
}

function isMock(env: Env): boolean {
  return env.MOCK_MODE !== 'false';
}

export async function processMessage(
  env: Env,
  msg: FactoryMessage
): Promise<{ ok: boolean; code: string; detail?: string }> {
  const mock = isMock(env);
  const factory = await getFactoryStatus(env);

  const assumeRunning = mock && msg.payload?.mockAssumeRunning === true;
  if (
    !assumeRunning &&
    !canStartNewWork(factory) &&
    (msg.type === 'IMAGE_GENERATION' || msg.type === 'PRODUCTION_PLAN')
  ) {
    return { ok: false, code: 'FACTORY_STOPPED', detail: 'kill switch active' };
  }

  switch (msg.type) {
    case 'IMAGE_GENERATION': {
      const width = Number(msg.payload?.width ?? 512);
      const height = Number(msg.payload?.height ?? 512);
      const steps = Math.min(8, Number(msg.payload?.steps ?? 4));
      const neurons = estimateFluxSchnellNeurons({ width, height, steps });
      const costGate = assertZeroCost({
        allowPaidApi: false,
        estimatedCost: 0,
        freeAvailable: true,
      });
      if (!costGate.allowed) {
        return { ok: false, code: costGate.code, detail: costGate.reason };
      }

      const route = routeProvider([
        {
          id: 'cf_workers_ai',
          enabled: true,
          freeAvailable: true,
          healthOk: true,
          quotaRemaining: mock ? 10_000 : 0,
          failureRate: 0,
          priority: 1,
          estimatedCost: 0,
        },
      ]);
      if (!route.selected && !mock) {
        return { ok: false, code: 'NO_ELIGIBLE_PROVIDER' };
      }

      let reservationId: string | undefined;
      let quotaId: string | undefined;

      if (env.DB) {
        const reserved = await d1Reserve({
          db: env.DB,
          providerId: 'cf_workers_ai',
          modelId: PRIMARY_IMAGE_MODEL_ID,
          window: 'daily',
          units: neurons,
          jobId: msg.jobId,
          idempotencyKey: `quota:${msg.jobId}:${msg.attempt ?? 0}`,
        });
        if (!reserved.ok) {
          return {
            ok: false,
            code: reserved.reason === 'INSUFFICIENT_QUOTA' ? 'WAITING_FOR_QUOTA' : reserved.reason,
            detail: reserved.reason,
          };
        }
        reservationId = reserved.reservationId;
        quotaId = reserved.quotaId;
      } else if (!mock) {
        return { ok: false, code: 'DB_NOT_BOUND' };
      } else {
        const snap = {
          providerId: 'cf_workers_ai',
          window: 'daily' as const,
          limitUnits: 10_000,
          usedUnits: 0,
          reservedUnits: 0,
        };
        const reserved = applyReserve(snap, neurons);
        if (!reserved.ok) {
          return { ok: false, code: 'WAITING_FOR_QUOTA', detail: reserved.reason };
        }
      }

      try {
        if (mock) {
          const provider = new MockImageProvider();
          const result = await provider.generate({
            prompt: String(msg.payload?.prompt ?? 'stock product photo'),
            width,
            height,
            steps,
          });
          if (env.DB && reservationId) {
            await d1Commit({ db: env.DB, reservationId, quotaId });
          }
          return {
            ok: true,
            code: 'MOCK_GENERATED',
            detail: `bytes=${result.imageBytes.byteLength};model=${PRIMARY_IMAGE_MODEL_ID};neurons=${neurons};reservation=${reservationId ?? 'none'}`,
          };
        }
        if (!env.AI) {
          if (env.DB && reservationId) {
            await d1Release({ db: env.DB, reservationId, quotaId });
          }
          return { ok: false, code: 'AI_NOT_BOUND' };
        }
        return { ok: false, code: 'LIVE_PATH_REQUIRES_BINDINGS' };
      } catch (e) {
        if (env.DB && reservationId) {
          await d1Release({ db: env.DB, reservationId, quotaId });
        }
        const attempt = msg.attempt ?? 0;
        const decision = decideRetry({
          attemptCount: attempt,
          errorCode: 'GENERATION_FAILED',
        });
        return {
          ok: false,
          code: decision.action === 'dead_letter' ? 'DEAD_LETTER' : 'RETRY',
          detail: decision.action,
        };
      }
    }

    case 'QC': {
      const summary = runQcPipeline({
        level1: {
          exists: Boolean(msg.payload?.exists ?? true),
          byteSize: Number(msg.payload?.byteSize ?? 50_000),
          width: Number(msg.payload?.width ?? 1024),
          height: Number(msg.payload?.height ?? 1024),
          mimeType: String(msg.payload?.mimeType ?? 'image/jpeg'),
          sha256: msg.payload?.sha256 != null ? String(msg.payload.sha256) : 'a'.repeat(64),
          decodeOk: msg.payload?.decodeOk === undefined ? true : Boolean(msg.payload.decodeOk),
          decodeErrorCode: msg.payload?.decodeErrorCode as string | undefined,
          format: (msg.payload?.format as 'jpeg' | 'png' | 'rgba' | 'unknown') ?? 'jpeg',
        },
        level2: {
          meanLuma: msg.payload?.meanLuma != null ? Number(msg.payload.meanLuma) : undefined,
          nearBlankRatio:
            msg.payload?.nearBlankRatio != null ? Number(msg.payload.nearBlankRatio) : undefined,
          width: Number(msg.payload?.width ?? 1024),
          height: Number(msg.payload?.height ?? 1024),
          corrupt: Boolean(msg.payload?.corrupt ?? false),
        },
        level3: { skip: true },
      });
      if (summary.outcome === 'PASS') {
        return { ok: true, code: 'QC_PASSED', detail: summary.reasonCodes.join(',') || 'ok' };
      }
      if (summary.outcome === 'RETRY') {
        return { ok: false, code: 'QC_RETRY', detail: summary.reasonCodes.join(',') };
      }
      if (summary.outcome === 'ERROR') {
        return { ok: false, code: 'QC_ERROR', detail: summary.reasonCodes.join(',') };
      }
      return { ok: true, code: 'QC_REJECTED', detail: summary.reasonCodes.join(',') };
    }

    case 'DUPLICATE_CHECK': {
      const existing =
        (msg.payload?.existing as {
          hashType: 'sha256' | 'phash';
          hashValue: string;
          assetId: string;
        }[]) ?? [];
      let phash = msg.payload?.phash as string | undefined;
      if (!phash && msg.payload?.imageBytesBase64) {
        try {
          const bin = Uint8Array.from(atob(String(msg.payload.imageBytesBase64)), (ch) =>
            ch.charCodeAt(0)
          );
          const computed = await computePhashFromImageBytes(bin);
          if (!computed.ok) {
            return { ok: false, code: computed.code, detail: computed.message };
          }
          phash = computed.phash;
        } catch (e) {
          return {
            ok: false,
            code: 'PHASH_COMPUTE_ERROR',
            detail: e instanceof Error ? e.message : 'phash error',
          };
        }
      }
      if (!phash && msg.payload?.rgbaBase64 && msg.payload?.width && msg.payload?.height) {
        try {
          const bin = Uint8Array.from(atob(String(msg.payload.rgbaBase64)), (ch) =>
            ch.charCodeAt(0)
          );
          const computed = computePhashFromRgba({
            rgba: bin,
            width: Number(msg.payload.width),
            height: Number(msg.payload.height),
          });
          if (!computed.ok) {
            return { ok: false, code: computed.code, detail: computed.message };
          }
          phash = computed.phash;
        } catch (e) {
          return {
            ok: false,
            code: 'PHASH_COMPUTE_ERROR',
            detail: e instanceof Error ? e.message : 'phash error',
          };
        }
      }
      const result = checkDuplicates({
        sha256: msg.payload?.sha256 as string | undefined,
        phash,
        existing,
        phashThreshold: msg.payload?.phashThreshold as number | undefined,
      });
      if (result.isDuplicate) {
        return { ok: true, code: 'DUPLICATE_REJECTED', detail: result.matches[0]?.layer };
      }
      return { ok: true, code: 'DUPLICATE_CLEAR', detail: phash ? `phash=${phash}` : undefined };
    }

    case 'METADATA': {
      return { ok: true, code: 'READY_TO_UPLOAD', detail: 'manual_marketplace_mode' };
    }

    case 'CLEANUP': {
      const decision = decideCleanup({
        id: String(msg.payload?.id ?? 'x'),
        status: String(msg.payload?.status ?? 'REJECTED'),
        uploaded: Boolean(msg.payload?.uploaded),
        keep: Boolean(msg.payload?.keep),
        hasPendingJob: Boolean(msg.payload?.hasPendingJob),
        r2Key: (msg.payload?.r2Key as string) ?? null,
        createdAt: String(msg.payload?.createdAt ?? '2020-01-01'),
        retentionDays: Number(msg.payload?.retentionDays ?? 7),
      });
      return {
        ok: true,
        code: decision.action === 'delete' ? 'CLEANUP_DELETE' : 'CLEANUP_SKIP',
        detail: decision.reason,
      };
    }

    case 'WATCHDOG': {
      const status = await getFactoryStatus(env);
      const jobs =
        (msg.payload?.jobs as {
          jobId: string;
          state: string;
          stateEnteredAt: string | number;
          lastHeartbeatAt?: string | number | null;
          attemptCount?: number;
          idempotencyKey?: string;
        }[]) ?? [];
      const actions = jobs.map((j) =>
        evaluateWatchdogJob({
          jobId: j.jobId,
          state: j.state,
          stateEnteredAt: j.stateEnteredAt,
          lastHeartbeatAt: j.lastHeartbeatAt,
          attemptCount: j.attemptCount ?? 0,
          idempotencyKey: j.idempotencyKey,
        })
      );
      const actionable = actions.filter((a) => a.action !== 'none');
      return {
        ok: true,
        code: 'WATCHDOG_OK',
        detail: `factory=${status};mock=${mock};actions=${actionable.length};constitution_cost=${FACTORY_CONSTITUTION.MAX_ALLOWED_COST}`,
      };
    }

    default:
      return { ok: false, code: 'UNKNOWN_JOB_TYPE', detail: msg.type };
  }
}

export default {
  async queue(batch: MessageBatch<FactoryMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const body = message.body;
        const result = await processMessage(env, body);
        if (result.ok) {
          message.ack();
        } else if (
          result.code === 'RETRY' ||
          result.code === 'WAITING_FOR_QUOTA' ||
          result.code === 'QC_RETRY'
        ) {
          message.retry();
        } else {
          message.ack();
        }
      } catch {
        message.retry();
      }
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'aif-consumer', mock: isMock(env) });
    }
    if (url.pathname === '/v1/process' && request.method === 'POST') {
      const msg = (await request.json()) as FactoryMessage;
      const result = await processMessage(env, msg);
      return Response.json(result, { status: result.ok ? 200 : 422 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
};
