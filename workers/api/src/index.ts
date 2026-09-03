/**
 * API Worker — health, factory STOP/RESUME, status, job enqueue.
 * Production must bind D1/Queue via wrangler.toml.
 * MOCK_MODE default. API never calls consumer directly.
 */

import {
  buildQueueMessage,
  validateQueueMessage,
  JOB_TYPES,
  type JobType,
} from '../../../packages/domain/src/index.js';

export interface Env {
  DB?: D1Database;
  ASSETS?: R2Bucket;
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

const MAX_BODY_BYTES = 16_384;

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
  )
    .bind(key, value)
    .run();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function enqueueJob(
  env: Env,
  body: {
    jobType?: string;
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
  }
): Promise<{ ok: true; jobId: string; requestId: string; message: unknown } | { ok: false; status: number; error: string; message: string }> {
  const jobType = body.jobType ?? 'IMAGE_GENERATION';
  if (!(JOB_TYPES as readonly string[]).includes(jobType)) {
    return { ok: false, status: 400, error: 'UNSUPPORTED_JOB_TYPE', message: jobType };
  }

  const jobId = newId('job');
  const requestId = newId('req');
  const idempotencyKey = body.idempotencyKey?.trim() || `idem_${jobId}`;

  let queueMessage;
  try {
    queueMessage = buildQueueMessage({
      jobId,
      requestId,
      idempotencyKey,
      jobType: jobType as JobType,
      attempt: 0,
      payload: body.payload,
    });
  } catch (e) {
    return {
      ok: false,
      status: 400,
      error: 'INVALID_MESSAGE',
      message: e instanceof Error ? e.message : 'invalid',
    };
  }

  // Persist job when DB available
  if (env.DB) {
    const ts = new Date().toISOString();
    try {
      // Idempotent insert by idempotency_key if unique
      const existing = await env.DB.prepare(
        `SELECT id, status FROM jobs WHERE idempotency_key = ?1 LIMIT 1`
      )
        .bind(idempotencyKey)
        .first<{ id: string; status: string }>();
      if (existing) {
        return {
          ok: true,
          jobId: existing.id,
          requestId,
          message: { deduped: true, status: existing.status },
        };
      }
      await env.DB.prepare(
        `INSERT INTO jobs (id, type, status, idempotency_key, request_id, payload_json, attempt_count, created_at, updated_at)
         VALUES (?1, ?2, 'queued', ?3, ?4, ?5, 0, ?6, ?6)`
      )
        .bind(jobId, jobType, idempotencyKey, requestId, JSON.stringify(body.payload ?? {}), ts)
        .run();
    } catch (e) {
      return {
        ok: false,
        status: 500,
        error: 'JOB_PERSIST_FAILED',
        message: e instanceof Error ? e.message : 'db error',
      };
    }
  }

  if (env.FACTORY_QUEUE) {
    await env.FACTORY_QUEUE.send(queueMessage);
  }

  return {
    ok: true,
    jobId,
    requestId,
    message: {
      status: 'queued',
      queueBound: Boolean(env.FACTORY_QUEUE),
      mock: env.MOCK_MODE !== 'false',
      envelope: queueMessage,
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return json({
        ok: true,
        service: 'aif-api',
        mock: env.MOCK_MODE !== 'false',
        time: new Date().toISOString(),
      });
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

    if (path === '/v1/jobs/enqueue' && request.method === 'POST') {
      const cl = Number(request.headers.get('content-length') ?? '0');
      if (cl > MAX_BODY_BYTES) {
        return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
      }
      let body: { jobType?: string; idempotencyKey?: string; payload?: Record<string, unknown> };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: 'INVALID_JSON' }, 400);
      }
      const result = await enqueueJob(env, body ?? {});
      if (!result.ok) {
        return json({ error: result.error, message: result.message }, result.status);
      }
      return json({
        ok: true,
        jobId: result.jobId,
        requestId: result.requestId,
        ...((result.message as object) ?? {}),
      }, 202);
    }

    if (path === '/v1/generate' && request.method === 'POST') {
      const status = await getSetting(env, 'factory_status', 'STOPPED');
      if (status !== 'RUNNING') {
        return json({ error: 'FACTORY_STOPPED', message: 'Resume factory before generating' }, 409);
      }
      if (env.MOCK_MODE === 'false' && !env.AI) {
        return json({ error: 'AI_NOT_BOUND', message: 'Workers AI binding missing' }, 503);
      }
      if (env.MOCK_MODE !== 'false') {
        return json({
          status: 'MOCK_GENERATED',
          note: 'MOCK_MODE=true — no real API call, no quota used',
          asset: { mime: 'image/jpeg', bytes: 4, provider: 'mock' },
        });
      }
      return json({
        error: 'NOT_IMPLEMENTED',
        message: 'Live generation requires quota reservation + D1 job row — see roadmap',
      }, 501);
    }

    return json({ error: 'NOT_FOUND', path }, 404);
  },
} satisfies ExportedHandler<Env>;
