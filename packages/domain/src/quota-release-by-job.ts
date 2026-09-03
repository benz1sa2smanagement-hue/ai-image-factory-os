/**
 * Thin re-export / helper module so watchdog can release by job_id
 * without redesigning quota-d1 core.
 * Prefer importing d1ReleaseByJobId from './quota-d1.js' after merge;
 * this file remains as documentation of the recovery path until inlined.
 */

import { d1Release, type D1Like, type D1MutationResult } from './quota-d1.js';

/**
 * Find active reserved quota for job_id and release once.
 * - reserved → released (units returned)
 * - committed → INVALID_STATE (no release)
 * - already released → alreadyDone
 * - missing → NOT_FOUND
 */
export async function releaseReservedQuotaForJob(
  db: D1Like,
  jobId: string
): Promise<D1MutationResult> {
  // Delegate to quota-d1 when available; inline lookup mirrors findActiveReservation
  const res = await db
    .prepare(
      `SELECT id, status FROM quota_reservations WHERE job_id = ? AND status = 'reserved' LIMIT 1`
    )
    .bind(jobId)
    .first<{ id: string; status: string }>();

  if (!res) {
    // Check committed — must not release
    const committed = await db
      .prepare(
        `SELECT id, status FROM quota_reservations WHERE job_id = ? AND status = 'committed' LIMIT 1`
      )
      .bind(jobId)
      .first<{ id: string; status: string }>();
    if (committed) return { ok: false, reason: 'INVALID_STATE' };
    return { ok: false, reason: 'NOT_FOUND' };
  }

  return d1Release({ db, reservationId: res.id });
}
