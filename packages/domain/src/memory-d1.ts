/**
 * In-memory D1-like store for unit tests (MOCK_MODE / local).
 * Implements enough SQL surface for quota-d1.ts only.
 * Not a full SQL engine — patterns match the exact queries in quota-d1.ts.
 */

import type { D1Like, D1Prepared, D1Bound } from './quota-d1.js';

type Row = Record<string, unknown>;

export class MemoryD1 implements D1Like {
  provider_quotas: Row[] = [];
  quota_reservations: Row[] = [];

  seedQuota(row: {
    id: string;
    provider_id: string;
    model_id?: string | null;
    window: string;
    limit_units: number;
    used_units?: number;
    reserved_units?: number;
  }) {
    this.provider_quotas.push({
      id: row.id,
      provider_id: row.provider_id,
      model_id: row.model_id ?? null,
      window: row.window,
      limit_units: row.limit_units,
      used_units: row.used_units ?? 0,
      reserved_units: row.reserved_units ?? 0,
      reset_at: null,
      updated_at: new Date().toISOString(),
    });
  }

  prepare(query: string): D1Prepared {
    const sql = query.replace(/\s+/g, ' ').trim();
    const self = this;
    return {
      bind(...values: unknown[]): D1Bound {
        return {
          async first<T>() {
            return self.execFirst(sql, values) as T | null;
          },
          async run() {
            return self.execRun(sql, values);
          },
          async all<T>() {
            return { results: self.execAll(sql, values) as T[] };
          },
        };
      },
    };
  }

  private execFirst(sql: string, values: unknown[]): Row | null {
    if (sql.includes('FROM provider_quotas WHERE id = ?')) {
      return this.provider_quotas.find((r) => r.id === values[0]) ?? null;
    }
    if (sql.includes('FROM provider_quotas') && sql.includes('provider_id = ?') && sql.includes('model_id = ?')) {
      return (
        this.provider_quotas.find(
          (r) =>
            r.provider_id === values[0] &&
            r.window === values[1] &&
            r.model_id === values[2]
        ) ?? null
      );
    }
    if (sql.includes('FROM provider_quotas') && sql.includes('provider_id = ?') && sql.includes('window = ?')) {
      return (
        this.provider_quotas.find(
          (r) => r.provider_id === values[0] && r.window === values[1]
        ) ?? null
      );
    }
    if (sql.includes('FROM quota_reservations WHERE id = ?')) {
      return this.quota_reservations.find((r) => r.id === values[0]) ?? null;
    }
    if (sql.includes('FROM quota_reservations WHERE idempotency_key = ?')) {
      return this.quota_reservations.find((r) => r.idempotency_key === values[0]) ?? null;
    }
    if (sql.includes('FROM quota_reservations') && sql.includes('job_id = ?') && sql.includes("status = 'reserved'")) {
      return (
        this.quota_reservations.find(
          (r) => r.job_id === values[0] && r.status === 'reserved'
        ) ?? null
      );
    }
    return null;
  }

  private execAll(_sql: string, _values: unknown[]): Row[] {
    return [];
  }

  private execRun(sql: string, values: unknown[]): { success: boolean; meta: { changes: number } } {
    if (sql.includes('UPDATE provider_quotas') && sql.includes('reserved_units = reserved_units + ?')) {
      const units = Number(values[0]);
      const id = values[1];
      const need = Number(values[2] ?? values[0]);
      const row = this.provider_quotas.find((r) => r.id === id);
      if (!row) return { success: true, meta: { changes: 0 } };
      const avail =
        Number(row.limit_units) - Number(row.used_units) - Number(row.reserved_units);
      if (avail < need) return { success: true, meta: { changes: 0 } };
      row.reserved_units = Number(row.reserved_units) + units;
      return { success: true, meta: { changes: 1 } };
    }

    if (
      sql.includes('UPDATE provider_quotas') &&
      sql.includes('used_units = used_units + ?')
    ) {
      const units = Number(values[0]);
      const units2 = Number(values[1]);
      const id = values[2];
      const row = this.provider_quotas.find((r) => r.id === id);
      if (!row) return { success: true, meta: { changes: 0 } };
      row.reserved_units = Math.max(0, Number(row.reserved_units) - units);
      row.used_units = Number(row.used_units) + units2;
      return { success: true, meta: { changes: 1 } };
    }

    if (
      sql.includes('UPDATE provider_quotas') &&
      sql.includes('reserved_units = MAX(0, reserved_units - ?)') &&
      !sql.includes('used_units')
    ) {
      const units = Number(values[0]);
      const id = values[1];
      const row = this.provider_quotas.find((r) => r.id === id);
      if (!row) return { success: true, meta: { changes: 0 } };
      row.reserved_units = Math.max(0, Number(row.reserved_units) - units);
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.includes("SET status = 'committed'") && sql.includes("status = 'reserved'")) {
      const id = values[0];
      const row = this.quota_reservations.find((r) => r.id === id && r.status === 'reserved');
      if (!row) return { success: true, meta: { changes: 0 } };
      row.status = 'committed';
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("SET status = 'released'") && sql.includes("status = 'reserved'")) {
      const id = values[0];
      const row = this.quota_reservations.find((r) => r.id === id && r.status === 'reserved');
      if (!row) return { success: true, meta: { changes: 0 } };
      row.status = 'released';
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.includes('INSERT INTO quota_reservations')) {
      const [id, provider_id, model_id, units, job_id, expires_at, idempotency_key] = values;
      if (job_id) {
        const clash = this.quota_reservations.find(
          (r) => r.job_id === job_id && r.status === 'reserved'
        );
        if (clash) throw new Error('UNIQUE constraint failed: job_id reserved');
      }
      if (idempotency_key) {
        const clash = this.quota_reservations.find((r) => r.idempotency_key === idempotency_key);
        if (clash) throw new Error('UNIQUE constraint failed: idempotency_key');
      }
      this.quota_reservations.push({
        id,
        provider_id,
        model_id,
        units,
        job_id,
        status: 'reserved',
        expires_at,
        created_at: new Date().toISOString(),
        idempotency_key: idempotency_key ?? null,
      });
      return { success: true, meta: { changes: 1 } };
    }

    return { success: true, meta: { changes: 0 } };
  }
}
