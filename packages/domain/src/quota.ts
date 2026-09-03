/**
 * Quota Manager — pure logic.
 * Workers apply CHECK → RESERVE → EXECUTE → COMMIT/RELEASE against D1.
 * Never hard-code production limits as sole source of truth; read provider_quotas.
 */

export type QuotaWindow = 'daily' | 'monthly' | 'per_minute';
export type ReservationStatus = 'reserved' | 'committed' | 'released' | 'expired';

export interface QuotaSnapshot {
  providerId: string;
  modelId?: string;
  window: QuotaWindow;
  limitUnits: number;
  usedUnits: number;
  reservedUnits: number;
}

export interface QuotaReservation {
  id: string;
  providerId: string;
  modelId?: string;
  units: number;
  jobId?: string;
  status: ReservationStatus;
  expiresAt: string;
  createdAt: string;
}

export function availableUnits(q: QuotaSnapshot): number {
  return Math.max(0, q.limitUnits - q.usedUnits - q.reservedUnits);
}

export function canReserve(q: QuotaSnapshot, units: number): boolean {
  return units > 0 && availableUnits(q) >= units;
}

export type ReserveResult =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false; reason: 'INSUFFICIENT_QUOTA' | 'INVALID_UNITS'; snapshot: QuotaSnapshot };

export function applyReserve(q: QuotaSnapshot, units: number): ReserveResult {
  if (units <= 0) return { ok: false, reason: 'INVALID_UNITS', snapshot: q };
  if (!canReserve(q, units)) return { ok: false, reason: 'INSUFFICIENT_QUOTA', snapshot: q };
  return { ok: true, snapshot: { ...q, reservedUnits: q.reservedUnits + units } };
}

export function applyCommit(q: QuotaSnapshot, units: number): QuotaSnapshot {
  return {
    ...q,
    reservedUnits: Math.max(0, q.reservedUnits - units),
    usedUnits: q.usedUnits + units,
  };
}

export function applyRelease(q: QuotaSnapshot, units: number): QuotaSnapshot {
  return { ...q, reservedUnits: Math.max(0, q.reservedUnits - units) };
}

/**
 * Estimate neurons for flux-1-schnell (Official Pricing 2026-08-28):
 * 4.80 neurons / 512x512 tile + 9.60 neurons / step.
 */
export function estimateFluxSchnellNeurons(opts: {
  width: number;
  height: number;
  steps: number;
}): number {
  const steps = Math.min(8, Math.max(1, opts.steps));
  const maxDim = Math.max(opts.width, opts.height);
  const tilesPerSide = Math.max(1, Math.ceil(maxDim / 512));
  const tiles = tilesPerSide * tilesPerSide;
  return Math.ceil(4.8 * tiles + 9.6 * steps);
}

/** Official free daily neuron budget — override via DB */
export const DEFAULT_WORKERS_AI_DAILY_NEURONS = 10_000;
