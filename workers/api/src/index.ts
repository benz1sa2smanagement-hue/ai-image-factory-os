/**
 * API Worker — health, factory STOP/RESUME, status and ephemeral generation.
 * Image bytes are never persisted. Live generation requires D1 + Workers AI bindings.
 */

import {
  assertZeroCost,
  canStartNewWork,
  checkDuplicates,
  computePhashFromImageBytes,
  d1Commit,
  d1Release,
  d1Reserve,
  estimateFluxSchnellNeurons,
  PRIMARY_IMAGE_MODEL_ID,
  runQcPipeline,
} from '../../../packages/domain/src/index.js';
import { generateWithWorkersAi } from '../../../packages/providers/src/cloudflare-flux.js';

export interface Env {
  DB?: D1Database;
  FACTORY_QUEUE?: Queue;
  AI?: Ai;
  MOCK_MODE?: string;
  FACTORY_DEFAULT_STATUS?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function getSetting(env: Env, key: string, fallback: string): Promise<string> {
  if (!env.DB) return fallback;
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value).run();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function findExistingHashes(env: Env, sha256: string, phash: string): Promise<{ hashType: 'sha256' | 'phash'; hashValue: string; assetId: string }[]> {
  if (!env.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT hash_type AS hashType, hash_value AS hashValue, asset_id AS assetId
     FROM image_hashes
     WHERE (hash_type = 'sha256' AND hash_value = ?)
        OR (hash_type = 'phash' AND hash_value = ?)
     LIMIT 50`
  ).bind(sha256, phash).all<{ hashType: 'sha256' | 'phash'; hashValue: string; assetId: string }>();
  return rows.results ?? [];
}

async function generateEphemeral(request: Request, env: Env): Promise<Response> {
  if (env.MOCK_MODE !== 'false') {
    return json({
      status: 'MOCK_GENERATED',
      note: 'MOCK_MODE=true — no real API call, no image persisted',
      asset: { mime: 'image/jpeg', bytes: 4, provider: 'mock' },
    });
  }

  if (!env.AI) return json({ error: 'AI_NOT_BOUND', message: 'Workers AI binding missing' }, 503);
  if (!env.DB) return json({ error: 'DB_NOT_BOUND', message: 'D1 binding is required for live quota control' }, 503);

  let body: { prompt?: string; width?: number; height?: number; steps?: number; seed?: number; jobId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) return json({ error: 'PROMPT_REQUIRED' }, 400);
  if (prompt.length > 2048) return json({ error: 'PROMPT_TOO_LONG' }, 400);

  const width = Number(body.width ?? 512);
  const height = Number(body.height ?? 512);
  const steps = Math.min(8, Math.max(1, Number(body.steps ?? 4)));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 512 || height < 512 || width > 4096 || height > 4096) {
    return json({ error: 'INVALID_DIMENSIONS' }, 400);
  }

  const gate = assertZeroCost({ allowPaidApi: false, estimatedCost: 0, freeAvailable: true });
  if (!gate.allowed) return json({ error: gate.code, message: gate.reason }, 403);

  const neurons = estimateFluxSchnellNeurons({ width, height, steps });
  const jobId = body.jobId ?? crypto.randomUUID();
  const reservation = await d1Reserve({
    db: env.DB,
    providerId: 'cf_workers_ai',
    modelId: PRIMARY_IMAGE_MODEL_ID,
    window: 'daily',
    units: neurons,
    jobId,
    idempotencyKey: `quota:${jobId}:0`,
  });
  if (!reservation.ok) {
    return json({ error: reservation.reason === 'INSUFFICIENT_QUOTA' ? 'WAITING_FOR_QUOTA' : reservation.reason }, 429);
  }

  try {
    const generated = await generateWithWorkersAi(env.AI, prompt, { steps, seed: body.seed, width, height });
    if (!generated.base64) throw new Error('AI_IMAGE_MISSING');

    const binary = atob(generated.base64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const sha256 = await sha256Hex(bytes);
    const phashResult = await computePhashFromImageBytes(bytes);
    if (!phashResult.ok) throw new Error(phashResult.code);

    const qc = runQcPipeline({
      level1: {
        exists: true,
        byteSize: bytes.byteLength,
        width,
        height,
        mimeType: 'image/jpeg',
        sha256,
        decodeOk: true,
        format: 'jpeg',
      },
      level2: { width, height, corrupt: false },
      level3: { skip: true },
    });
    if (qc.outcome !== 'PASS') throw new Error(`QC_${qc.outcome}`);

    const existing = await findExistingHashes(env, sha256, phashResult.phash);
    const duplicate = checkDuplicates({ sha256, phash: phashResult.phash, existing });
    if (duplicate.isDuplicate) {
      throw new Error('DUPLICATE_REJECTED');
    }

    await d1Commit({ db: env.DB, reservationId: reservation.reservationId, quotaId: reservation.quotaId });

    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'no-store',
        'x-aif-sha256': sha256,
        'x-aif-phash': phashResult.phash,
        'x-aif-width': String(width),
        'x-aif-height': String(height),
        'x-aif-model': PRIMARY_IMAGE_MODEL_ID,
        'x-aif-neurons': String(neurons),
      },
    });
  } catch (error) {
    await d1Release({ db: env.DB, reservationId: reservation.reservationId, quotaId: reservation.quotaId });
    const message = error instanceof Error ? error.message : 'GENERATION_FAILED';
    const status = message === 'DUPLICATE_REJECTED' ? 409 : 422;
    return json({ error: message, image_persisted: false }, status);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return json({ ok: true, service: 'aif-api', mock: env.MOCK_MODE !== 'false', time: new Date().toISOString() });
    }

    if (path === '/factory/status' && request.method === 'GET') {
      const status = await getSetting(env, 'factory_status', env.FACTORY_DEFAULT_STATUS ?? 'STOPPED');
      const allowPaid = await getSetting(env, 'allow_paid_api', 'false');
      const maxCost = await getSetting(env, 'max_allowed_cost', '0');
      return json({
        factory_status: status,
        allow_paid_api: allowPaid === 'true',
        max_allowed_cost: Number(maxCost),
        upload_mode: await getSetting(env, 'upload_mode', 'manual'),
        persistent_image_storage: false,
        mock_mode: env.MOCK_MODE !== 'false',
      });
    }

    if (path === '/factory/stop' && request.method === 'POST') {
      await setSetting(env, 'factory_status', 'STOPPED');
      return json({ factory_status: 'STOPPED', message: 'Factory stopped. In-flight safe jobs may finish.' });
    }

    if (path === '/factory/resume' && request.method === 'POST') {
      await setSetting(env, 'factory_status', 'RUNNING');
      return json({ factory_status: 'RUNNING', message: 'Factory resumed.' });
    }

    if (path === '/v1/generate' && request.method === 'POST') {
      const status = await getSetting(env, 'factory_status', 'STOPPED');
      if (!canStartNewWork(status)) return json({ error: 'FACTORY_STOPPED', message: 'Resume factory before generating' }, 409);
      return generateEphemeral(request, env);
    }

    return json({ error: 'NOT_FOUND', path }, 404);
  },
} satisfies ExportedHandler<Env>;
