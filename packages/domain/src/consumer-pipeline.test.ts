import { describe, it, expect } from 'vitest';
import {
  orchestrateFactoryMessage,
  defaultMockRegistry,
  defaultMockCandidates,
  defaultMockQuotas,
} from './job-orchestrator.js';
import { buildQueueMessage } from './queue-message.js';
import { MemoryStorage } from './storage.js';
import { MemoryJobsD1 } from './memory-jobs-d1.js';
import { ProviderRegistry } from './provider-registry.js';
import { createMockProvider } from './mock-generation.js';
import { freeProviderDescriptor, paidProviderDescriptor } from './provider-router.js';

function seedQueued(db: MemoryJobsD1, id = 'job_1') {
  db.seedJob({
    id,
    status: 'queued',
    type: 'IMAGE_GENERATION',
    idempotency_key: `idem_${id}`,
    request_id: `req_${id}`,
  });
}

describe('consumer ↔ generation pipeline wiring', () => {
  it('A/B/C. Queue → Orchestrator → Pipeline → Storage → QC success', async () => {
    const storage = new MemoryStorage();
    const db = new MemoryJobsD1();
    seedQueued(db);
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
      payload: { prompt: 'mug on table', width: 16, height: 16, seed: 5 },
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
      storage,
      registry: defaultMockRegistry(),
      candidates: defaultMockCandidates(),
      quotas: defaultMockQuotas(),
    });
    expect(r.disposition).toBe('ack');
    expect(r.code).toBe('PIPELINE_PASSED');
    expect(r.storageKey).toBeTruthy();
    expect(await storage.exists(r.storageKey!)).toBe(true);
    expect(r.phase).toBe('PASSED');
  });

  it('D. quota exhausted blocks', async () => {
    const storage = new MemoryStorage();
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_q',
        requestId: 'req_q',
        idempotencyKey: 'idem_q',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'x', width: 8, height: 8 },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
      registry: defaultMockRegistry(),
      candidates: defaultMockCandidates(),
      quotas: [
        {
          providerId: 'mock-free-a',
          remaining: 0,
          dailyLimit: 10_000,
          status: 'EXHAUSTED',
        },
      ],
    });
    expect(r.disposition).toBe('retry');
    expect(r.failureCategory === 'QUOTA_EXHAUSTED' || r.code.includes('ELIGIBLE') || r.code === 'RETRY').toBe(
      true
    );
  });

  it('E. UNKNOWN quota blocked', async () => {
    const storage = new MemoryStorage();
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_u',
        requestId: 'req_u',
        idempotencyKey: 'idem_u',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'x', width: 8, height: 8 },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
      registry: defaultMockRegistry(),
      candidates: defaultMockCandidates(),
      quotas: [
        {
          providerId: 'mock-free-a',
          remaining: 0,
          dailyLimit: 0,
          status: 'UNKNOWN',
        },
      ],
    });
    expect(r.disposition).toBe('retry');
  });

  it('F. paid provider blocked', async () => {
    const storage = new MemoryStorage();
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-paid-a'));
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_p',
        requestId: 'req_p',
        idempotencyKey: 'idem_p',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'x', width: 8, height: 8 },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
      registry: reg,
      candidates: [paidProviderDescriptor({ id: 'mock-paid-a', priority: 1 })],
      quotas: [
        {
          providerId: 'mock-paid-a',
          remaining: 100,
          dailyLimit: 100,
          status: 'AVAILABLE',
        },
      ],
    });
    expect(r.disposition).toBe('retry');
  });

  it('H. permanent failure → DLQ', async () => {
    const storage = new MemoryStorage();
    const db = new MemoryJobsD1();
    seedQueued(db, 'job_perm');
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_perm',
        requestId: 'req_job_perm',
        idempotencyKey: 'idem_job_perm',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'x', width: 8, height: 8, mockOutcome: 'MOCK_PERMANENT_ERROR' },
      }),
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
      storage,
      registry: defaultMockRegistry(),
      candidates: defaultMockCandidates(),
      quotas: defaultMockQuotas(),
    });
    expect(r.disposition).toBe('ack');
    expect(r.code).toBe('DEAD_LETTER');
  });

  it('L. STOPPED factory does not generate', async () => {
    const storage = new MemoryStorage();
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_s',
        requestId: 'req_s',
        idempotencyKey: 'idem_s',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'x', width: 8, height: 8 },
      }),
      factoryStatus: 'STOPPED',
      storage,
      allowWithoutDb: true,
    });
    expect(r.code).toBe('FACTORY_STOPPED');
    expect(r.disposition).toBe('retry');
    expect(storage.listKeys().length).toBe(0);
  });

  it('M/P. duplicate terminal → ALREADY_TERMINAL', async () => {
    const storage = new MemoryStorage();
    const db = new MemoryJobsD1();
    db.seedJob({
      id: 'job_1',
      status: 'succeeded',
      type: 'IMAGE_GENERATION',
      idempotency_key: 'idem_job_1',
      request_id: 'req_job_1',
    });
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_1',
        requestId: 'req_job_1',
        idempotencyKey: 'idem_job_1',
        jobType: 'IMAGE_GENERATION',
      }),
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
      storage,
    });
    expect(r.code).toBe('ALREADY_TERMINAL');
    expect(r.disposition).toBe('ack');
  });

  it('N. retryable failure → retry disposition', async () => {
    const storage = new MemoryStorage();
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_r',
        requestId: 'req_r',
        idempotencyKey: 'idem_r',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'x', width: 8, height: 8, mockOutcome: 'MOCK_RETRYABLE_ERROR' },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
      registry: defaultMockRegistry(),
      candidates: defaultMockCandidates(),
      quotas: defaultMockQuotas(),
    });
    expect(r.disposition).toBe('retry');
  });

  it('R. no storage keys when no generation', async () => {
    const storage = new MemoryStorage();
    await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_x',
        requestId: 'req_x',
        idempotencyKey: 'idem_x',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'x', width: 8, height: 8, mockOutcome: 'MOCK_RETRYABLE_ERROR' },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
    });
    expect(storage.listKeys().length).toBe(0);
  });
});
