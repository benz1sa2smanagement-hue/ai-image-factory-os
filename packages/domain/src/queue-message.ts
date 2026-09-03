/**
 * Versioned Cloudflare Queue message envelope.
 * Queue carries job references/control data only — never secrets or binary assets.
 */

import { JOB_TYPES, type JobType } from './jobs.js';

export const QUEUE_MESSAGE_VERSION = 1 as const;

export const MAX_QUEUE_PAYLOAD_BYTES = 8_192;

export interface FactoryQueueMessageV1 {
  version: 1;
  jobId: string;
  requestId: string;
  idempotencyKey: string;
  jobType: JobType;
  attempt: number;
  /** Optional small control hints only — no secrets, no image bytes */
  payload?: Record<string, unknown>;
}

export type FactoryQueueMessage = FactoryQueueMessageV1;

const ID_RE = /^[a-zA-Z0-9_.:-]{1,128}$/;

export type QueueMessageValidation =
  | { ok: true; message: FactoryQueueMessageV1 }
  | { ok: false; code: string; reason: string };

export function validateQueueMessage(raw: unknown): QueueMessageValidation {
  if (raw == null || typeof raw !== 'object') {
    return { ok: false, code: 'MALFORMED_MESSAGE', reason: 'body must be object' };
  }
  const o = raw as Record<string, unknown>;

  if (o.version !== 1) {
    return { ok: false, code: 'UNSUPPORTED_VERSION', reason: `version=${String(o.version)}` };
  }
  if (typeof o.jobId !== 'string' || !ID_RE.test(o.jobId)) {
    return { ok: false, code: 'INVALID_JOB_ID', reason: 'jobId required' };
  }
  if (typeof o.requestId !== 'string' || !ID_RE.test(o.requestId)) {
    return { ok: false, code: 'INVALID_REQUEST_ID', reason: 'requestId required' };
  }
  if (typeof o.idempotencyKey !== 'string' || o.idempotencyKey.length < 1 || o.idempotencyKey.length > 256) {
    return { ok: false, code: 'INVALID_IDEMPOTENCY_KEY', reason: 'idempotencyKey required' };
  }
  if (typeof o.jobType !== 'string' || !(JOB_TYPES as readonly string[]).includes(o.jobType)) {
    return { ok: false, code: 'UNSUPPORTED_JOB_TYPE', reason: String(o.jobType) };
  }
  const attempt = o.attempt == null ? 0 : Number(o.attempt);
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 100) {
    return { ok: false, code: 'INVALID_ATTEMPT', reason: 'attempt must be 0..100' };
  }

  let payload: Record<string, unknown> | undefined;
  if (o.payload != null) {
    if (typeof o.payload !== 'object' || Array.isArray(o.payload)) {
      return { ok: false, code: 'INVALID_PAYLOAD', reason: 'payload must be object' };
    }
    payload = o.payload as Record<string, unknown>;
    // Reject obvious secret keys
    for (const k of Object.keys(payload)) {
      const lk = k.toLowerCase();
      if (
        lk.includes('secret') ||
        lk.includes('password') ||
        lk.includes('apikey') ||
        lk.includes('api_key') ||
        lk.includes('authorization') ||
        lk.includes('applicationkey')
      ) {
        return { ok: false, code: 'PAYLOAD_FORBIDDEN_KEY', reason: k };
      }
    }
    const size = JSON.stringify(payload).length;
    if (size > MAX_QUEUE_PAYLOAD_BYTES) {
      return { ok: false, code: 'PAYLOAD_TOO_LARGE', reason: `payload ${size} bytes` };
    }
  }

  return {
    ok: true,
    message: {
      version: 1,
      jobId: o.jobId,
      requestId: o.requestId,
      idempotencyKey: o.idempotencyKey,
      jobType: o.jobType as JobType,
      attempt,
      payload,
    },
  };
}

export function buildQueueMessage(input: {
  jobId: string;
  requestId: string;
  idempotencyKey: string;
  jobType: JobType;
  attempt?: number;
  payload?: Record<string, unknown>;
}): FactoryQueueMessageV1 {
  const msg: FactoryQueueMessageV1 = {
    version: 1,
    jobId: input.jobId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    jobType: input.jobType,
    attempt: input.attempt ?? 0,
  };
  if (input.payload) msg.payload = input.payload;
  const v = validateQueueMessage(msg);
  if (!v.ok) throw new Error(`${v.code}: ${v.reason}`);
  return v.message;
}

/** Safe summary for logs/DLQ — never includes secrets */
export function queueMessageSummary(msg: FactoryQueueMessageV1): Record<string, unknown> {
  return {
    version: msg.version,
    jobId: msg.jobId,
    requestId: msg.requestId,
    idempotencyKey: msg.idempotencyKey,
    jobType: msg.jobType,
    attempt: msg.attempt,
    payloadKeys: msg.payload ? Object.keys(msg.payload) : [],
  };
}
