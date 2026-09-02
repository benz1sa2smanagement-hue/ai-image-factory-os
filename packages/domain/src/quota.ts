/** Quota reservation types — implementation uses D1 transactions in workers */

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

export function availableUnits(q: QuotaSnapshot): number {
  return Math.max(0, q.limitUnits - q.usedUnits - q.reservedUnits);
}

export function canReserve(q: QuotaSnapshot, units: number): boolean {
  return units > 0 && availableUnits(q) >= units;
}
