/**
 * API Worker — health, factory STOP/RESUME, status.
 * Production must bind D1/R2/Queue/AI via wrangler.toml.
 * MOCK_MODE skips real provider calls.
 */

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

    if (path === '/v1/generate' && request.method === 'POST') {
      const status = await getSetting(env, 'factory_status', 'STOPPED');
      if (status !== 'RUNNING') {
        return json({ error: 'FACTORY_STOPPED', message: 'Resume factory before generating' }, 409);
      }
      if (env.MOCK_MODE === 'false' && !env.AI) {
        return json({ error: 'AI_NOT_BOUND', message: 'Workers AI binding missing' }, 503);
      }
      // Zero-cost: mock path only unless bindings + quota implemented end-to-end
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
