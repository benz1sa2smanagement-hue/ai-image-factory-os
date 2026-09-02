/** Job types for Cloudflare Queues — D1 remains source of truth */

export const JOB_TYPES = [
  'TREND_ANALYSIS',
  'STRATEGY',
  'PRODUCTION_PLAN',
  'IMAGE_GENERATION',
  'QC',
  'DUPLICATE_CHECK',
  'METADATA',
  'UPLOAD',
  'ANALYTICS',
  'LEARNING',
  'CLEANUP',
  'WATCHDOG',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  'pending',
  'queued',
  'running',
  'succeeded',
  'failed',
  'waiting_for_quota',
  'cancelled',
  'dead_letter',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  idempotency_key?: string;
  request_id?: string;
  payload_json: string;
  attempt_count: number;
  error_code?: string;
  error_message?: string;
  next_retry_at?: string;
  created_at: string;
  updated_at: string;
}

export function isRetryableJobStatus(status: JobStatus): boolean {
  return status === 'failed' || status === 'waiting_for_quota';
}

export function maxAttemptsFor(type: JobType): number {
  switch (type) {
    case 'IMAGE_GENERATION':
    case 'QC':
    case 'UPLOAD':
      return 3;
    case 'CLEANUP':
    case 'WATCHDOG':
      return 5;
    default:
      return 2;
  }
}
