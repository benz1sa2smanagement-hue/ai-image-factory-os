/**
 * D1 persistence for jobs, watchdog recovery, and dead-letter queue.
 * Atomic conditional UPDATE; DLQ UNIQUE(job_id).
 * Watchdog mark_failed / dead_letter releases reserved quota by job_id (once).
 */

import type { D1Like } from './quota-d1.js';
import { releaseReservedQuotaForJob } from './quota-release-by-job.js';
import {
  evaluateWatchdogJob,
  stopBlocksNewGeneration,
  type WatchdogAction,
  type WatchdogPolicy,
  DEFAULT_WATCHDOG_POLICY,
} from './watchdog.js';
import { decideRetry } from './retry.js';
import { transitionAudit } from './audit.js';
import { canStartNewWork } from './policy.js';
import { canTransition, type AssetState } from './state-machine.js';

export type JobRow = {
  id: string;
  type: string;
  status: string;
  idempotency_key?: string | null;
  request_id?: string | null;
  payload_json: string;
  attempt_count: number;
  error_code?: string | null;
  error_message?: string | null;
  next_retry_at?: string | null;
  provider?: string | null;
  asset_state?: string | null;
  state_entered_at?: string | null;
  last_heartbeat_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type TransitionResult =
  | { ok: true; from: string; to: string; changes: number }
  | { ok: false; reason: string; changes: number };

function nowIso(now?: number): string {
  return new Date(now ?? Date.now()).toISOString();
}

export async function d1TransitionJobStatus(
  db: D1Like,
  opts: {
    jobId: string;
    fromStatus: string;
    toStatus: string;
    errorCode?: string;
    errorMessage?: string;
    nextRetryAt?: string | null;
    expectedAttemptCount?: number;
    setAttemptCount?: number;
    actor?: string;
    now?: number;
  }
): Promise<TransitionResult> {
  const ts = nowIso(opts.now);
  let sql: string;
  let values: unknown[];

  if (opts.expectedAttemptCount != null && opts.setAttemptCount != null) {
    sql = `UPDATE jobs SET status = ?1, error_code = ?2, error_message = ?3,
      next_retry_at = ?4, attempt_count = ?5, state_entered_at = ?6, updated_at = ?6
      WHERE id = ?7 AND status = ?8 AND attempt_count = ?9`;
    values = [
      opts.toStatus, opts.errorCode ?? null, opts.errorMessage ?? null,
      opts.nextRetryAt ?? null, opts.setAttemptCount, ts,
      opts.jobId, opts.fromStatus, opts.expectedAttemptCount,
    ];
  } else {
    sql = `UPDATE jobs SET status = ?1, error_code = ?2, error_message = ?3,
      next_retry_at = ?4, state_entered_at = ?5, updated_at = ?5
      WHERE id = ?6 AND status = ?7`;
    values = [
      opts.toStatus, opts.errorCode ?? null, opts.errorMessage ?? null,
      opts.nextRetryAt ?? null, ts, opts.jobId, opts.fromStatus,
    ];
  }

  const result = await db.prepare(sql).bind(...values).run();
  const changes = result.meta?.changes ?? 0;
  if (changes !== 1) {
    return { ok: false, reason: 'CONDITIONAL_UPDATE_LOST', changes };
  }

  try {
    const aud = transitionAudit('job', opts.jobId, opts.fromStatus, opts.toStatus, opts.actor ?? 'system', {
      errorCode: opts.errorCode,
    });
    await db.prepare(
      `INSERT INTO audit_logs (id, entity_type, entity_id, action, from_state, to_state, actor, details_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(
      aud.id, aud.entity_type, aud.entity_id, aud.action,
      aud.from_state ?? null, aud.to_state ?? null, aud.actor ?? null,
      JSON.stringify(aud.details ?? {}), aud.created_at
    ).run();
  } catch { /* best-effort */ }

  return { ok: true, from: opts.fromStatus, to: opts.toStatus, changes };
}

export async function d1InsertDeadLetter(
  db: D1Like,
  opts: {
    jobId: string; reason: string; attemptCount: number;
    errorCode?: string; errorMessage?: string; provider?: string;
    requestId?: string; idempotencyKey?: string; jobType?: string;
    payloadJson?: string; now?: number;
  }
): Promise<{ ok: true; inserted: boolean } | { ok: false; reason: string }> {
  const ts = nowIso(opts.now);
  const id = `dlq_${opts.jobId}`;
  const result = await db.prepare(
    `INSERT OR IGNORE INTO dead_letter_jobs
      (id, job_id, request_id, idempotency_key, job_type, reason, error_code, error_message,
       attempt_count, provider, payload_json, status, created_at, failed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'open', ?12, ?12)`
  ).bind(
    id, opts.jobId, opts.requestId ?? null, opts.idempotencyKey ?? null,
    opts.jobType ?? null, opts.reason, opts.errorCode ?? null, opts.errorMessage ?? null,
    opts.attemptCount, opts.provider ?? null, opts.payloadJson ?? '{}', ts
  ).run();
  return { ok: true, inserted: (result.meta?.changes ?? 0) === 1 };
}

export async function d1MoveJobToDeadLetter(
  db: D1Like,
  opts: {
    jobId: string; fromStatus: string; reason: string;
    expectedAttemptCount?: number; errorCode?: string; errorMessage?: string;
    provider?: string; requestId?: string; idempotencyKey?: string;
    jobType?: string; payloadJson?: string; now?: number;
  }
): Promise<{ ok: boolean; reason: string; dlqInserted: boolean }> {
  const tr = await d1TransitionJobStatus(db, {
    jobId: opts.jobId, fromStatus: opts.fromStatus, toStatus: 'dead_letter',
    errorCode: opts.errorCode ?? opts.reason, errorMessage: opts.errorMessage,
    expectedAttemptCount: opts.expectedAttemptCount,
    setAttemptCount: opts.expectedAttemptCount, actor: 'dlq', now: opts.now,
  });
  if (!tr.ok) return { ok: false, reason: tr.reason, dlqInserted: false };
  const dlq = await d1InsertDeadLetter(db, {
    jobId: opts.jobId, reason: opts.reason,
    attemptCount: opts.expectedAttemptCount ?? 0,
    errorCode: opts.errorCode, errorMessage: opts.errorMessage,
    provider: opts.provider, requestId: opts.requestId,
    idempotencyKey: opts.idempotencyKey, jobType: opts.jobType,
    payloadJson: opts.payloadJson, now: opts.now,
  });
  return { ok: true, reason: 'MOVED_TO_DLQ', dlqInserted: dlq.ok && dlq.inserted };
}

export async function d1GetJob(db: D1Like, jobId: string): Promise<JobRow | null> {
  return db.prepare(`SELECT * FROM jobs WHERE id = ?1 LIMIT 1`).bind(jobId).first<JobRow>();
}

export async function d1GetFactoryStatus(db: D1Like): Promise<string> {
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE key = 'factory_status' LIMIT 1`).bind().first<{ value: string }>();
    return row?.value ?? 'STOPPED';
  } catch {
    return 'STOPPED';
  }
}

async function recordWatchdogAction(
  db: D1Like,
  opts: { jobId: string; action: string; reason: string; fromStatus: string; toStatus: string; now?: number }
): Promise<void> {
  try {
    const id = `wa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await db.prepare(
      `INSERT INTO watchdog_actions (id, job_id, action, reason, from_status, to_status, actor, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'watchdog', ?7)`
    ).bind(id, opts.jobId, opts.action, opts.reason, opts.fromStatus, opts.toStatus, nowIso(opts.now)).run();
  } catch { /* ignore */ }
}

export async function d1ApplyWatchdogAction(
  db: D1Like,
  job: JobRow,
  action: WatchdogAction,
  opts?: { factoryStatus?: string; now?: number }
): Promise<{ ok: boolean; detail: string }> {
  if (action.action === 'none') return { ok: true, detail: 'none' };

  const factory = opts?.factoryStatus ?? (await d1GetFactoryStatus(db));
  const now = opts?.now;
  const fresh = await d1GetJob(db, job.id);
  if (!fresh) return { ok: false, detail: 'JOB_NOT_FOUND' };
  job = fresh;

  if (action.action === 'requeue') {
    if (stopBlocksNewGeneration(factory) || !canStartNewWork(factory)) {
      const tr = await d1TransitionJobStatus(db, {
        jobId: job.id, fromStatus: job.status, toStatus: 'failed',
        errorCode: 'FACTORY_STOPPED', errorMessage: 'watchdog_requeue_blocked_by_stop',
        actor: 'watchdog', now,
      });
      return { ok: tr.ok, detail: tr.ok ? 'requeue_blocked_marked_failed' : tr.reason };
    }
    const from = job.status;
    const tr = await d1TransitionJobStatus(db, {
      jobId: job.id, fromStatus: from, toStatus: 'pending',
      errorMessage: action.reason, actor: 'watchdog', now,
    });
    await recordWatchdogAction(db, { jobId: job.id, action: 'requeue', reason: action.reason, fromStatus: from, toStatus: 'pending', now });
    return { ok: tr.ok, detail: tr.ok ? 'requeued' : tr.reason };
  }

  if (action.action === 'mark_failed') {
    const stuck = new Set(['generating', 'qc', 'running', 'queued', 'retry_wait', 'pending']);
    if (!stuck.has(String(job.status).toLowerCase())) {
      return { ok: false, detail: 'ALREADY_TERMINAL_OR_NOT_STUCK' };
    }
    const fromStatus = job.status;
    const tr = await d1TransitionJobStatus(db, {
      jobId: job.id, fromStatus, toStatus: 'failed',
      errorCode: action.errorCode, errorMessage: action.reason, actor: 'watchdog', now,
    });
    await recordWatchdogAction(db, { jobId: job.id, action: 'mark_failed', reason: action.reason, fromStatus, toStatus: 'failed', now });
    if (tr.ok) {
      try {
        await releaseReservedQuotaForJob(db, job.id);
      } catch { /* best-effort; job already failed */ }
    }
    return { ok: tr.ok, detail: tr.ok ? 'marked_failed' : tr.reason };
  }

  if (action.action === 'dead_letter') {
    const moved = await d1MoveJobToDeadLetter(db, {
      jobId: job.id, fromStatus: job.status, reason: action.reason,
      expectedAttemptCount: job.attempt_count, errorCode: 'WATCHDOG_DEAD_LETTER',
      provider: job.provider ?? undefined, requestId: job.request_id ?? undefined,
      idempotencyKey: job.idempotency_key ?? undefined, jobType: job.type,
      payloadJson: job.payload_json, now,
    });
    if (moved.ok) {
      try {
        await releaseReservedQuotaForJob(db, job.id);
      } catch { /* best-effort */ }
    }
    return { ok: moved.ok, detail: moved.reason };
  }

  return { ok: false, detail: 'unknown_action' };
}

export async function d1RunWatchdogForJobs(
  db: D1Like,
  jobs: JobRow[],
  policy: WatchdogPolicy = DEFAULT_WATCHDOG_POLICY,
  now = Date.now()
): Promise<{ jobId: string; detail: string; action: string }[]> {
  const factory = await d1GetFactoryStatus(db);
  const out: { jobId: string; detail: string; action: string }[] = [];
  for (const job of jobs) {
    const decision = evaluateWatchdogJob({
      jobId: job.id, state: job.status,
      stateEnteredAt: job.state_entered_at ?? job.updated_at,
      lastHeartbeatAt: job.last_heartbeat_at,
      attemptCount: job.attempt_count,
      idempotencyKey: job.idempotency_key ?? undefined,
    }, policy, now);
    const applied = await d1ApplyWatchdogAction(db, job, decision, { factoryStatus: factory, now });
    out.push({ jobId: job.id, detail: applied.detail, action: decision.action });
  }
  return out;
}

export async function d1IncrementAttemptAndScheduleRetry(
  db: D1Like,
  opts: {
    jobId: string; fromStatus: string; expectedAttemptCount: number;
    errorCode?: string; now?: number;
  }
): Promise<TransitionResult & { decision?: ReturnType<typeof decideRetry> }> {
  const decision = decideRetry({
    attemptCount: opts.expectedAttemptCount, errorCode: opts.errorCode,
    now: opts.now, rng: () => 0.5,
  });

  if (decision.action === 'dead_letter') {
    const moved = await d1MoveJobToDeadLetter(db, {
      jobId: opts.jobId, fromStatus: opts.fromStatus, reason: decision.reason,
      expectedAttemptCount: opts.expectedAttemptCount, errorCode: opts.errorCode, now: opts.now,
    });
    if (moved.ok) {
      try { await releaseReservedQuotaForJob(db, opts.jobId); } catch { /* best-effort */ }
    }
    return { ok: moved.ok, reason: moved.reason, changes: moved.ok ? 1 : 0, from: opts.fromStatus, to: 'dead_letter', decision } as TransitionResult & { decision: ReturnType<typeof decideRetry> };
  }

  const nextStatus = decision.action === 'waiting_for_quota' ? 'waiting_for_quota' : 'failed';
  const nextRetry =
    decision.action === 'retry' || decision.action === 'waiting_for_quota' ? decision.nextRetryAt : null;
  const nextAttempt =
    decision.action === 'retry' || decision.action === 'waiting_for_quota'
      ? decision.attempt : opts.expectedAttemptCount + 1;

  const tr = await d1TransitionJobStatus(db, {
    jobId: opts.jobId, fromStatus: opts.fromStatus, toStatus: nextStatus,
    errorCode: opts.errorCode, nextRetryAt: nextRetry,
    expectedAttemptCount: opts.expectedAttemptCount, setAttemptCount: nextAttempt,
    actor: 'retry', now: opts.now,
  });
  return { ...tr, decision };
}

export { canTransition };
export type { AssetState };
