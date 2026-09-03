/**
 * D1-backed Quota Manager — atomic reserve / commit / release.
 * Pure domain helpers stay in quota.ts.
 *
 * Atomicity (SQLite/D1):
 * 1. Idempotency by job_id / idempotency_key
 * 2. UPDATE provider_quotas with capacity in WHERE (changes===1 wins)
 * 3. INSERT reservation only after successful UPDATE
 * 4. Commit/release with WHERE status='reserved' (idempotent)
 *
 * Zero-cost policy is enforced by callers via assertZeroCost — this layer tracks free units only.
 */

import {
  availableUnits,
  type QuotaSnapshot,
  type ReservationStatus,
} from './quota.js';

export interface D1Prepared {
  bind(...values: unknown[]): D1Bound;
}

export interface D1Bound {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Like {
  prepare(query: string): D1Prepared;
}

export interface QuotaRow {
  id: string;
  provider_id: string;
  model_id: string | null;
  window: string;
  limit_units: number;
  used_units: number;
  reserved_units: number;
  reset_at: string | null;
}

export interface ReservationRow {
  id: string;
  provider_id: string;
  model_id: string | null;
  units: number;
  job_id: string | null;
  status: ReservationStatus;
  expires_at: string;
  created_at: string;
  idempotency_key?: string | null;
}

export type D1ReserveOk = {
  ok: true;
  reservationId: string;
  quotaId: string;
  units: number;
  snapshot: QuotaSnapshot;
  idempotent: boolean;
};

export type D1ReserveErr = {
  ok: false;
  reason: 'INSUFFICIENT_QUOTA' | 'INVALID_UNITS' | 'QUOTA_NOT_FOUND' | 'DB_ERROR';
  snapshot?: QuotaSnapshot;
};

export type D1ReserveResult = D1ReserveOk | D1ReserveErr;

export type D1MutationResult =
  | { ok: true; reservationId: string; alreadyDone: boolean; snapshot?: QuotaSnapshot }
  | { ok: false; reason: 'NOT_FOUND' | 'INVALID_STATE' | 'DB_ERROR' };

function rowToSnapshot(row: QuotaRow): QuotaSnapshot {
  return {
    providerId: row.provider_id,
    modelId: row.model_id ?? undefined,
    window: row.window as QuotaSnapshot['window'],
    limitUnits: Number(row.limit_units),
    usedUnits: Number(row.used_units),
    reservedUnits: Number(row.reserved_units),
  };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadQuotaById(db: D1Like, quotaId: string): Promise<QuotaRow | null> {
  return db
    .prepare(
      `SELECT id, provider_id, model_id, window, limit_units, used_units, reserved_units, reset_at
       FROM provider_quotas WHERE id = ? LIMIT 1`
    )
    .bind(quotaId)
    .first<QuotaRow>();
}

export async function loadQuotaForProvider(
  db: D1Like,
  providerId: string,
  window: string,
  modelId?: string
): Promise<QuotaRow | null> {
  if (modelId) {
    const row = await db
      .prepare(
        `SELECT id, provider_id, model_id, window, limit_units, used_units, reserved_units, reset_at
         FROM provider_quotas
         WHERE provider_id = ? AND window = ? AND model_id = ?
         LIMIT 1`
      )
      .bind(providerId, window, modelId)
      .first<QuotaRow>();
    if (row) return row;
  }
  return db
    .prepare(
      `SELECT id, provider_id, model_id, window, limit_units, used_units, reserved_units, reset_at
       FROM provider_quotas
       WHERE provider_id = ? AND window = ?
       ORDER BY CASE WHEN model_id IS NULL THEN 1 ELSE 0 END
       LIMIT 1`
    )
    .bind(providerId, window)
    .first<QuotaRow>();
}

async function findActiveReservation(
  db: D1Like,
  opts: { jobId?: string; idempotencyKey?: string; reservationId?: string }
): Promise<ReservationRow | null> {
  if (opts.reservationId) {
    return db
      .prepare(
        `SELECT id, provider_id, model_id, units, job_id, status, expires_at, created_at, idempotency_key
         FROM quota_reservations WHERE id = ? LIMIT 1`
      )
      .bind(opts.reservationId)
      .first<ReservationRow>();
  }
  if (opts.idempotencyKey) {
    const byKey = await db
      .prepare(
        `SELECT id, provider_id, model_id, units, job_id, status, expires_at, created_at, idempotency_key
         FROM quota_reservations WHERE idempotency_key = ? LIMIT 1`
      )
      .bind(opts.idempotencyKey)
      .first<ReservationRow>();
    if (byKey) return byKey;
  }
  if (opts.jobId) {
    return db
      .prepare(
        `SELECT id, provider_id, model_id, units, job_id, status, expires_at, created_at, idempotency_key
         FROM quota_reservations
         WHERE job_id = ? AND status = 'reserved'
         LIMIT 1`
      )
      .bind(opts.jobId)
      .first<ReservationRow>();
  }
  return null;
}

export async function d1Reserve(opts: {
  db: D1Like;
  quotaId?: string;
  providerId: string;
  modelId?: string;
  window?: string;
  units: number;
  jobId?: string;
  idempotencyKey?: string;
  ttlSeconds?: number;
  now?: Date;
}): Promise<D1ReserveResult> {
  const units = opts.units;
  if (!(units > 0) || !Number.isFinite(units)) {
    return { ok: false, reason: 'INVALID_UNITS' };
  }

  const existing = await findActiveReservation(opts.db, {
    jobId: opts.jobId,
    idempotencyKey: opts.idempotencyKey,
  });
  if (existing && existing.status === 'reserved') {
    const q =
      (opts.quotaId ? await loadQuotaById(opts.db, opts.quotaId) : null) ??
      (await loadQuotaForProvider(
        opts.db,
        existing.provider_id,
        opts.window ?? 'daily',
        existing.model_id ?? undefined
      ));
    return {
      ok: true,
      reservationId: existing.id,
      quotaId: q?.id ?? opts.quotaId ?? '',
      units: Number(existing.units),
      snapshot: q
        ? rowToSnapshot(q)
        : {
            providerId: existing.provider_id,
            modelId: existing.model_id ?? undefined,
            window: (opts.window ?? 'daily') as QuotaSnapshot['window'],
            limitUnits: 0,
            usedUnits: 0,
            reservedUnits: 0,
          },
      idempotent: true,
    };
  }

  if (opts.idempotencyKey) {
    const any = await opts.db
      .prepare(
        `SELECT id, provider_id, model_id, units, job_id, status, expires_at, created_at, idempotency_key
         FROM quota_reservations WHERE idempotency_key = ? LIMIT 1`
      )
      .bind(opts.idempotencyKey)
      .first<ReservationRow>();
    if (any && (any.status === 'committed' || any.status === 'reserved')) {
      const q = await loadQuotaForProvider(
        opts.db,
        any.provider_id,
        opts.window ?? 'daily',
        any.model_id ?? undefined
      );
      return {
        ok: true,
        reservationId: any.id,
        quotaId: q?.id ?? '',
        units: Number(any.units),
        snapshot: q
          ? rowToSnapshot(q)
          : {
              providerId: any.provider_id,
              window: 'daily',
              limitUnits: 0,
              usedUnits: 0,
              reservedUnits: 0,
            },
        idempotent: true,
      };
    }
  }

  const quota =
    (opts.quotaId ? await loadQuotaById(opts.db, opts.quotaId) : null) ??
    (await loadQuotaForProvider(
      opts.db,
      opts.providerId,
      opts.window ?? 'daily',
      opts.modelId
    ));

  if (!quota) return { ok: false, reason: 'QUOTA_NOT_FOUND' };

  const snap = rowToSnapshot(quota);
  if (availableUnits(snap) < units) {
    return { ok: false, reason: 'INSUFFICIENT_QUOTA', snapshot: snap };
  }

  const update = await opts.db
    .prepare(
      `UPDATE provider_quotas
       SET reserved_units = reserved_units + ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND (limit_units - used_units - reserved_units) >= ?`
    )
    .bind(units, quota.id, units)
    .run();

  if (!update.meta || update.meta.changes !== 1) {
    const fresh = await loadQuotaById(opts.db, quota.id);
    return {
      ok: false,
      reason: 'INSUFFICIENT_QUOTA',
      snapshot: fresh ? rowToSnapshot(fresh) : snap,
    };
  }

  const now = opts.now ?? new Date();
  const ttl = opts.ttlSeconds ?? 900;
  const reservationId = newId('qres');
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

  try {
    await opts.db
      .prepare(
        `INSERT INTO quota_reservations (
           id, provider_id, model_id, units, job_id, status, expires_at, created_at, idempotency_key
         ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, datetime('now'), ?)`
      )
      .bind(
        reservationId,
        quota.provider_id,
        quota.model_id,
        units,
        opts.jobId ?? null,
        expiresAt,
        opts.idempotencyKey ?? null
      )
      .run();
  } catch {
    await opts.db
      .prepare(
        `UPDATE provider_quotas
         SET reserved_units = MAX(0, reserved_units - ?),
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(units, quota.id)
      .run();
    return { ok: false, reason: 'DB_ERROR' };
  }

  const after = await loadQuotaById(opts.db, quota.id);
  return {
    ok: true,
    reservationId,
    quotaId: quota.id,
    units,
    snapshot: after
      ? rowToSnapshot(after)
      : { ...snap, reservedUnits: snap.reservedUnits + units },
    idempotent: false,
  };
}

export async function d1Commit(opts: {
  db: D1Like;
  reservationId: string;
  quotaId?: string;
}): Promise<D1MutationResult> {
  const res = await findActiveReservation(opts.db, { reservationId: opts.reservationId });
  if (!res) return { ok: false, reason: 'NOT_FOUND' };
  if (res.status === 'committed') {
    return { ok: true, reservationId: res.id, alreadyDone: true };
  }
  if (res.status !== 'reserved') return { ok: false, reason: 'INVALID_STATE' };

  const units = Number(res.units);
  const quota =
    (opts.quotaId ? await loadQuotaById(opts.db, opts.quotaId) : null) ??
    (await loadQuotaForProvider(opts.db, res.provider_id, 'daily', res.model_id ?? undefined));
  if (!quota) return { ok: false, reason: 'NOT_FOUND' };

  const statusUpdate = await opts.db
    .prepare(
      `UPDATE quota_reservations SET status = 'committed' WHERE id = ? AND status = 'reserved'`
    )
    .bind(res.id)
    .run();

  if (!statusUpdate.meta || statusUpdate.meta.changes !== 1) {
    return { ok: true, reservationId: res.id, alreadyDone: true };
  }

  await opts.db
    .prepare(
      `UPDATE provider_quotas
       SET reserved_units = MAX(0, reserved_units - ?),
           used_units = used_units + ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(units, units, quota.id)
    .run();

  const after = await loadQuotaById(opts.db, quota.id);
  return {
    ok: true,
    reservationId: res.id,
    alreadyDone: false,
    snapshot: after ? rowToSnapshot(after) : undefined,
  };
}

export async function d1Release(opts: {
  db: D1Like;
  reservationId: string;
  quotaId?: string;
}): Promise<D1MutationResult> {
  const res = await findActiveReservation(opts.db, { reservationId: opts.reservationId });
  if (!res) return { ok: false, reason: 'NOT_FOUND' };
  if (res.status === 'released' || res.status === 'expired') {
    return { ok: true, reservationId: res.id, alreadyDone: true };
  }
  if (res.status === 'committed') return { ok: false, reason: 'INVALID_STATE' };
  if (res.status !== 'reserved') return { ok: false, reason: 'INVALID_STATE' };

  const units = Number(res.units);
  const quota =
    (opts.quotaId ? await loadQuotaById(opts.db, opts.quotaId) : null) ??
    (await loadQuotaForProvider(opts.db, res.provider_id, 'daily', res.model_id ?? undefined));
  if (!quota) return { ok: false, reason: 'NOT_FOUND' };

  const statusUpdate = await opts.db
    .prepare(
      `UPDATE quota_reservations SET status = 'released' WHERE id = ? AND status = 'reserved'`
    )
    .bind(res.id)
    .run();

  if (!statusUpdate.meta || statusUpdate.meta.changes !== 1) {
    return { ok: true, reservationId: res.id, alreadyDone: true };
  }

  await opts.db
    .prepare(
      `UPDATE provider_quotas
       SET reserved_units = MAX(0, reserved_units - ?),
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(units, quota.id)
    .run();

  const after = await loadQuotaById(opts.db, quota.id);
  return {
    ok: true,
    reservationId: res.id,
    alreadyDone: false,
    snapshot: after ? rowToSnapshot(after) : undefined,
  };
}
