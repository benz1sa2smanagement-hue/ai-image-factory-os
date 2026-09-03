import { describe, it, expect } from 'vitest';
import {
  validateQueueMessage,
  buildQueueMessage,
  queueMessageSummary,
  MAX_QUEUE_PAYLOAD_BYTES,
} from './queue-message.js';
import { runMockProcessor } from './mock-processor.js';
import { orchestrateFactoryMessage } from './job-orchestrator.js';
import { MemoryJobsD1 } from './memory-jobs-d1.js';
import { MemoryD1 } from './memory-d1.js';

/** Combined memory surface for jobs + quota */
class IntegrationD1 extends MemoryJobsD1 {
  quota: MemoryD1;
  constructor() {
    super();
    this.quota = new MemoryD1();
    this.quota.seedQuota({
      id: 'q1',
      provider_id: 'cf_workers_ai',
      model_id: '@cf/black-forest-labs/flux-1-schnell',
      window: 'daily',
      limit_units: 100,
      used_units: 0,
      reserved_units: 0,
    });
  }
  // Route quota SQL to MemoryD1; jobs SQL to parent
  prepare(query: string) {
    const sql = query.replace(/\s+/g, ' ').trim();
    if (
      sql.includes('provider_quotas') ||
      sql.includes('quota_reservations') ||
      sql.includes('FROM quota')
    ) {
      return this.quota.prepare(query);
    }
    return super.prepare(query);
  }
}

describe('queue message schema', () => {
  it('accepts valid v1 envelope', () => {
    const v = validateQueueMessage({
      version: 1,
      jobId: 'job_1',
      requestId: 'req_1',
      idempotencyKey: 'idem_1',
      jobType: 'IMAGE_GENERATION',
      attempt: 0,
      payload: { mockOutcome: 'MOCK_SUCCESS' },
    });
    expect(v.ok).toBe(true);
  });

  it('rejects malformed / bad version / forbidden keys / large payload', () => {
    expect(validateQueueMessage(null).ok).toBe(false);
    expect(validateQueueMessage({ version: 2 }).ok).toBe(false);
    expect(
      validateQueueMessage({
        version: 1,
        jobId: 'j',
        requestId: 'r',
        idempotencyKey: 'i',
        jobType: 'IMAGE_GENERATION',
        attempt: 0,
        payload: { api_key: 'x' },
      }).ok
    ).toBe(false);
    const big = { x: 'a'.repeat(MAX_QUEUE_PAYLOAD_BYTES + 10) };
    expect(
      validateQueueMessage({
        version: 1,
        jobId: 'j',
        requestId: 'r',
        idempotencyKey: 'i',
        jobType: 'IMAGE_GENERATION',
        attempt: 0,
        payload: big,
      }).ok
    ).toBe(false);
  });

  it('summary has no secrets', () => {
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_1',
      idempotencyKey: 'idem_1',
      jobType: 'IMAGE_GENERATION',
      payload: { mockOutcome: 'MOCK_SUCCESS' },
    });
    const s = queueMessageSummary(msg);
    expect(JSON.stringify(s)).not.toMatch(/secret|password|authorization/i);
    expect(s.jobId).toBe('job_1');
    expect(s.idempotencyKey).toBe('idem_1');
  });
});

describe('mock processor', () => {
  it('MOCK_SUCCESS / RETRYABLE / PERMANENT', () => {
    expect(runMockProcessor({ jobId: 'j', jobType: 'IMAGE_GENERATION', attempt: 0 }).ok).toBe(true);
    expect(
      runMockProcessor({
        jobId: 'j',
        jobType: 'IMAGE_GENERATION',
        attempt: 0,
        mockOutcome: 'MOCK_RETRYABLE_ERROR',
      }).retryable
    ).toBe(true);
    expect(
      runMockProcessor({
        jobId: 'j',
        jobType: 'IMAGE_GENERATION',
        attempt: 0,
        mockOutcome: 'MOCK_PERMANENT_ERROR',
      }).retryable
    ).toBe(false);
  });
});

describe('orchestrateFactoryMessage integration', () => {
  function seed(db: IntegrationD1, id = 'job_1') {
    db.seedJob({
      id,
      status: 'queued',
      type: 'IMAGE_GENERATION',
      idempotency_key: `idem_${id}`,
      request_id: `req_${id}`,
      attempt_count: 0,
    });
  }

  it('successful MOCK job → ack + succeeded', async () => {
    const db = new IntegrationD1();
    seed(db);
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
      payload: { mockOutcome: 'MOCK_SUCCESS' },
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.disposition).toBe('ack');
    expect(r.code).toBe('MOCK_SUCCESS');
    expect(r.jobId).toBe('job_1');
    expect(r.idempotencyKey).toBe('idem_job_1');
    const job = db.jobs.find((j) => j.id === 'job_1');
    expect(job?.status).toBe('succeeded');
  });

  it('duplicate delivery of successful job → ack ALREADY_TERMINAL', async () => {
    const db = new IntegrationD1();
    seed(db);
    db.jobs[0]!.status = 'succeeded';
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.disposition).toBe('ack');
    expect(r.code).toBe('ALREADY_TERMINAL');
  });

  it('STOP prevents processing and does not ack', async () => {
    const db = new IntegrationD1();
    seed(db);
    db.setFactoryStatus('STOPPED');
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'STOPPED',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.disposition).toBe('retry');
    expect(r.code).toBe('FACTORY_STOPPED');
    expect(db.jobs[0]!.status).toBe('queued');
  });

  it('unknown job → ack', async () => {
    const db = new IntegrationD1();
    const msg = buildQueueMessage({
      jobId: 'missing',
      requestId: 'req_x',
      idempotencyKey: 'idem_x',
      jobType: 'IMAGE_GENERATION',
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.disposition).toBe('ack');
    expect(r.code).toBe('UNKNOWN_JOB');
  });

  it('permanent error → DLQ + ack (idempotent DLQ)', async () => {
    const db = new IntegrationD1();
    seed(db);
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
      payload: { mockOutcome: 'MOCK_PERMANENT_ERROR' },
    });
    const r1 = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r1.disposition).toBe('ack');
    expect(r1.code).toBe('DEAD_LETTER');
    expect(db.dead_letter_jobs.length).toBe(1);

    // second DLQ insert for same job is ignored
    db.jobs[0]!.status = 'running';
    const r2 = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r2.code).toBe('DEAD_LETTER');
    expect(db.dead_letter_jobs.length).toBe(1);
  });

  it('retryable failure → retry disposition', async () => {
    const db = new IntegrationD1();
    seed(db);
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
      attempt: 0,
      payload: { mockOutcome: 'MOCK_RETRYABLE_ERROR' },
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.disposition).toBe('retry');
    expect(r.jobId).toBe('job_1');
  });

  it('preserves job_id and idempotency_key on all paths', async () => {
    const db = new IntegrationD1();
    seed(db);
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.jobId).toBe('job_1');
    expect(r.idempotencyKey).toBe('idem_job_1');
  });
});
