/**
 * Queue Consumer Worker — processes factory jobs.
 * MOCK_MODE: no real AI, no real R2 writes required for pipeline tests.
 *
 * Flow per message type:
 * IMAGE_GENERATION → (quota) → generate → GENERATED → enqueue QC
 * QC → level1 → PASSED/REJECTED → enqueue DUPLICATE_CHECK or archive
 * DUPLICATE_CHECK → exact + pHash → METADATA or REJECTED
 * METADATA → READY_TO_UPLOAD (manual marketplace — no auto upload)
 * CLEANUP / WATCHDOG — safety jobs
 */

import {
  canStartNewWork,
  assertZeroCost,
  assertTransition,
  canTransition,
  applyReserve,
  applyCommit,
  applyRelease,
  estimateFluxSchnellNeurons,
  routeProvider,
  level1Checks,
  summarizeQc,
  mayUpload,
  checkDuplicates,
  decideRetry,
  decideCleanup,
  FACTORY_CONSTITUTION,
  PRIMARY_IMAGE_MODEL_ID,
  type AssetState,
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

/**
 * Process a single queue message. Pure control flow — side effects behind env.
 * Returns outcome for tests when DB/Queue unbound (mock path).
 */
export async function processMessage(
  env: Env,
  msg: FactoryMessage
): Promise<{ ok: boolean; code: string; detail?: string }> {
  const mock = isMock(env);
  const factory = await getFactoryStatus(env);

  // Kill switch: block new generation when STOPPED
  // MOCK: payload.mockAssumeRunning=true allows testing generate path without D1
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

      let snap = {
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
      snap = reserved.snapshot;

      try {
        if (mock) {
          const provider = new MockImageProvider();
          const result = await provider.generate({
            prompt: String(msg.payload?.prompt ?? 'stock product photo'),
            width,
            height,
            steps,
          });
          snap = applyCommit(snap, neurons);
          return {
            ok: true,
            code: 'MOCK_GENERATED',
            detail: `bytes=${result.imageBytes.byteLength};model=${PRIMARY_IMAGE_MODEL_ID};neurons=${neurons}`,
          };
        }
        if (!env.AI) {
          snap = applyRelease(snap, neurons);
          return { ok: false, code: 'AI_NOT_BOUND' };
        }
        return { ok: false, code: 'LIVE_PATH_REQUIRES_BINDINGS' };
      } catch (e) {
        snap = applyRelease(snap, neurons);
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
      const meta = {
        exists: Boolean(msg.payload?.exists ?? true),
        byteSize: Number(msg.payload?.byteSize ?? 50_000),
        width: Number(msg.payload?.width ?? 1024),
        height: Number(msg.payload?.height ?? 1024),
        mimeType: String(msg.payload?.mimeType ?? 'image/jpeg'),
        sha256: String(msg.payload?.sha256 ?? 'a'.repeat(64)),
      };
      const summary = summarizeQc(level1Checks(meta));
      if (!summary.passed) {
        return { ok: true, code: 'QC_REJECTED', detail: summary.checks.map((c) => c.name).join(',') };
      }
      return { ok: true, code: 'QC_PASSED' };
    }

    case 'DUPLICATE_CHECK': {
      const existing = (msg.payload?.existing as { hashType: 'sha256' | 'phash'; hashValue: string; assetId: string }[]) ?? [];
      const result = checkDuplicates({
        sha256: msg.payload?.sha256 as string | undefined,
        phash: msg.payload?.phash as string | undefined,
        existing,
      });
      if (result.isDuplicate) {
        return { ok: true, code: 'DUPLICATE_REJECTED', detail: result.matches[0]?.layer };
      }
      return { ok: true, code: 'DUPLICATE_CLEAR' };
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
      return { ok: true, code: decision.action === 'delete' ? 'CLEANUP_DELETE' : 'CLEANUP_SKIP', detail: decision.reason };
    }

    case 'WATCHDOG': {
      const status = await getFactoryStatus(env);
      return {
        ok: true,
        code: 'WATCHDOG_OK',
        detail: `factory=${status};mock=${mock};constitution_cost=${FACTORY_CONSTITUTION.MAX_ALLOWED_COST}`,
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
        } else if (result.code === 'RETRY' || result.code === 'WAITING_FOR_QUOTA') {
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
