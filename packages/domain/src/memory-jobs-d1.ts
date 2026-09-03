/** In-memory D1 surface for jobs / DLQ / audit / watchdog tests. */

import type { D1Like, D1Prepared, D1Bound } from './quota-d1.js';

type Row = Record<string, unknown>;

export class MemoryJobsD1 implements D1Like {
  jobs: Row[] = [];
  dead_letter_jobs: Row[] = [];
  audit_logs: Row[] = [];
  watchdog_actions: Row[] = [];
  settings: Row[] = [{ key: 'factory_status', value: 'RUNNING' }];

  setFactoryStatus(status: string) {
    const row = this.settings.find((r) => r.key === 'factory_status');
    if (row) row.value = status;
    else this.settings.push({ key: 'factory_status', value: status });
  }

  seedJob(job: {
    id: string;
    type?: string;
    status: string;
    attempt_count?: number;
    idempotency_key?: string;
    request_id?: string;
    payload_json?: string;
    provider?: string;
    state_entered_at?: string;
    last_heartbeat_at?: string;
    error_code?: string;
  }) {
    const ts = new Date().toISOString();
    this.jobs.push({
      id: job.id,
      type: job.type ?? 'IMAGE_GENERATION',
      status: job.status,
      idempotency_key: job.idempotency_key ?? null,
      request_id: job.request_id ?? null,
      payload_json: job.payload_json ?? '{}',
      attempt_count: job.attempt_count ?? 0,
      error_code: job.error_code ?? null,
      error_message: null,
      next_retry_at: null,
      provider: job.provider ?? null,
      asset_state: null,
      state_entered_at: job.state_entered_at ?? ts,
      last_heartbeat_at: job.last_heartbeat_at ?? null,
      created_at: ts,
      updated_at: ts,
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
    if (sql.includes("FROM settings WHERE key = 'factory_status'")) {
      return this.settings.find((r) => r.key === 'factory_status') ?? null;
    }
    if (sql.includes('FROM jobs WHERE id = ?')) {
      return this.jobs.find((r) => r.id === values[0]) ?? null;
    }
    return null;
  }

  private execAll(_sql: string, _values: unknown[]): Row[] {
    return [];
  }

  private execRun(sql: string, values: unknown[]): { success: boolean; meta: { changes: number } } {
    if (sql.startsWith('UPDATE jobs SET status')) {
      if (sql.includes('attempt_count = ?5')) {
        const [toStatus, errorCode, errorMessage, nextRetryAt, setAttempt, ts, jobId, fromStatus, expectedAttempt] =
          values as [string, string | null, string | null, string | null, number, string, string, string, number];
        const j = this.jobs.find((r) => r.id === jobId);
        if (!j || j.status !== fromStatus || j.attempt_count !== expectedAttempt) {
          return { success: true, meta: { changes: 0 } };
        }
        j.status = toStatus;
        j.error_code = errorCode;
        j.error_message = errorMessage;
        j.next_retry_at = nextRetryAt;
        j.attempt_count = setAttempt;
        j.state_entered_at = ts;
        j.updated_at = ts;
        return { success: true, meta: { changes: 1 } };
      }
      const [toStatus, errorCode, errorMessage, nextRetryAt, ts, jobId, fromStatus] = values as [
        string, string | null, string | null, string | null, string, string, string
      ];
      const j = this.jobs.find((r) => r.id === jobId);
      if (!j || j.status !== fromStatus) {
        return { success: true, meta: { changes: 0 } };
      }
      j.status = toStatus;
      j.error_code = errorCode;
      j.error_message = errorMessage;
      j.next_retry_at = nextRetryAt;
      j.state_entered_at = ts;
      j.updated_at = ts;
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.includes('INSERT OR IGNORE INTO dead_letter_jobs')) {
      const jobId = values[1] as string;
      if (this.dead_letter_jobs.some((r) => r.job_id === jobId)) {
        return { success: true, meta: { changes: 0 } };
      }
      this.dead_letter_jobs.push({
        id: values[0], job_id: jobId, request_id: values[2], idempotency_key: values[3],
        job_type: values[4], reason: values[5], error_code: values[6], error_message: values[7],
        attempt_count: values[8], provider: values[9], payload_json: values[10],
        status: 'open', created_at: values[11], failed_at: values[11],
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.includes('INSERT INTO audit_logs')) {
      this.audit_logs.push({
        id: values[0], entity_type: values[1], entity_id: values[2], action: values[3],
        from_state: values[4], to_state: values[5], actor: values[6], details_json: values[7], created_at: values[8],
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.includes('INSERT INTO watchdog_actions')) {
      this.watchdog_actions.push({
        id: values[0], job_id: values[1], action: values[2], reason: values[3],
        from_status: values[4], to_status: values[5], actor: 'watchdog', created_at: values[6],
      });
      return { success: true, meta: { changes: 1 } };
    }

    return { success: true, meta: { changes: 0 } };
  }
}
