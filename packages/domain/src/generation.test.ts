import { describe, it, expect } from 'vitest';
import {
  validateGenerationRequest,
  buildGenerationStorageKey,
  GenerationService,
} from './generation.js';
import { MockGenerationProvider, encodeDeterministicPng } from './mock-generation.js';
import { MemoryStorage } from './storage.js';
import { orchestrateFactoryMessage } from './job-orchestrator.js';
import { buildQueueMessage } from './queue-message.js';
import { MemoryJobsD1 } from './memory-jobs-d1.js';
import { MemoryD1 } from './memory-d1.js';

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
  prepare(query: string) {
    const sql = query.replace(/\s+/g, ' ').trim();
    if (sql.includes('provider_quotas') || sql.includes('quota_reservations') || sql.includes('FROM quota')) {
      return this.quota.prepare(query);
    }
    return super.prepare(query);
  }
}

describe('validateGenerationRequest', () => {
  const base = {
    jobId: 'job_1',
    requestId: 'req_1',
    prompt: 'kraft packaging on white',
    width: 512,
    height: 512,
    format: 'png' as const,
  };

  it('A. accepts valid generation request', () => {
    const v = validateGenerationRequest(base);
    expect(v.ok).toBe(true);
  });

  it('B. rejects empty prompt', () => {
    expect(validateGenerationRequest({ ...base, prompt: '  ' }).ok).toBe(false);
    expect(validateGenerationRequest({ ...base, prompt: '' }).ok).toBe(false);
  });

  it('C. rejects invalid dimensions', () => {
    expect(validateGenerationRequest({ ...base, width: 0 }).ok).toBe(false);
    expect(validateGenerationRequest({ ...base, height: 99999 }).ok).toBe(false);
  });

  it('rejects unsupported format', () => {
    expect(validateGenerationRequest({ ...base, format: 'gif' as 'png' }).ok).toBe(false);
  });
});

describe('MockGenerationProvider', () => {
  const provider = new MockGenerationProvider();

  const req = {
    jobId: 'job_1',
    requestId: 'req_1',
    prompt: 'product photo',
    width: 64,
    height: 64,
    format: 'png' as const,
    seed: 42,
  };

  it('D/E. deterministic valid PNG bytes', async () => {
    const a = await provider.generate(req);
    const b = await provider.generate(req);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    if (!a.success || !b.success) return;
    expect(a.imageBytes).toEqual(b.imageBytes);
    // PNG signature
    expect(a.imageBytes[0]).toBe(0x89);
    expect(a.imageBytes[1]).toBe(0x50);
    expect(a.imageBytes[2]).toBe(0x4e);
    expect(a.imageBytes[3]).toBe(0x47);
  });

  it('different seed → different bytes', async () => {
    const a = await provider.generate(req);
    const b = await provider.generate({ ...req, seed: 99 });
    expect(a.success && b.success).toBe(true);
    if (!a.success || !b.success) return;
    expect(a.imageBytes).not.toEqual(b.imageBytes);
  });

  it('F. MOCK_SUCCESS default', async () => {
    const r = await provider.generate(req);
    expect(r.success).toBe(true);
  });

  it('G. MOCK_RETRYABLE_ERROR', async () => {
    const r = await provider.generate({ ...req, mockOutcome: 'MOCK_RETRYABLE_ERROR' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.retryable).toBe(true);
    expect(r.code).toBe('MOCK_RETRYABLE_ERROR');
  });

  it('H. MOCK_PERMANENT_ERROR', async () => {
    const r = await provider.generate({ ...req, mockOutcome: 'MOCK_PERMANENT_ERROR' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.retryable).toBe(false);
  });

  it('I. generation metadata', async () => {
    const r = await provider.generate(req);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.metadata.jobId).toBe('job_1');
    expect(r.metadata.requestId).toBe('req_1');
    expect(r.metadata.provider).toBe('mock');
    expect(r.metadata.model).toBe('mock-image-v1');
    expect(r.metadata.prompt).toBe('product photo');
    expect(r.metadata.mock).toBe(true);
    expect(r.metadata.seed).toBe(42);
    expect(r.metadata.generatedAt).toBeTruthy();
  });

  it('P/Q/R. no network, no credentials', async () => {
    // pure function path — encodeDeterministicPng has no fetch
    const bytes = encodeDeterministicPng({ width: 8, height: 8, seed: 1, prompt: 'x' });
    expect(bytes.length).toBeGreaterThan(20);
    expect(provider.id).toBe('mock');
  });
});

describe('GenerationService + Storage', () => {
  it('J/K/L. put, storageKey, retrieve bytes', async () => {
    const storage = new MemoryStorage();
    const service = new GenerationService({
      provider: new MockGenerationProvider(),
      storage,
    });
    const result = await service.generateAndStore({
      jobId: 'job_abc',
      requestId: 'req_1',
      prompt: 'box photo',
      width: 32,
      height: 32,
      format: 'png',
      seed: 7,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.storageKey).toBe('assets/job_abc/original.png');
    expect(result.metadata.storageKey).toBe(result.storageKey);
    const got = await storage.get(result.storageKey);
    expect(got).not.toBeNull();
    expect(got!.body).toEqual(result.imageBytes);
    expect(got!.contentType).toBe('image/png');
  });

  it('buildGenerationStorageKey convention', () => {
    expect(buildGenerationStorageKey('asset1', 'png')).toBe('assets/asset1/original.png');
    expect(buildGenerationStorageKey('asset1', 'jpeg')).toBe('assets/asset1/original.jpg');
  });

  it('validation failure does not touch storage', async () => {
    const storage = new MemoryStorage();
    const service = new GenerationService({
      provider: new MockGenerationProvider(),
      storage,
    });
    const r = await service.generateAndStore({
      jobId: 'j',
      requestId: 'r',
      prompt: '',
      width: 10,
      height: 10,
      format: 'png',
    });
    expect(r.success).toBe(false);
    expect(await storage.exists('assets/j/original.png')).toBe(false);
  });
});

describe('job lifecycle via orchestrator (M/N/O)', () => {
  it('M. success path preserves job_id', async () => {
    const db = new IntegrationD1();
    db.seedJob({
      id: 'job_1',
      status: 'queued',
      type: 'IMAGE_GENERATION',
      idempotency_key: 'idem_job_1',
      request_id: 'req_job_1',
    });
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
      payload: { mockOutcome: 'MOCK_SUCCESS', prompt: 'x' },
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.disposition).toBe('ack');
    expect(r.jobId).toBe('job_1');
  });

  it('N. retryable generation failure → retry disposition', async () => {
    const db = new IntegrationD1();
    db.seedJob({
      id: 'job_1',
      status: 'queued',
      type: 'IMAGE_GENERATION',
      idempotency_key: 'idem_job_1',
      request_id: 'req_job_1',
    });
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
      payload: { mockOutcome: 'MOCK_RETRYABLE_ERROR' },
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.disposition).toBe('retry');
  });

  it('O. permanent failure → DLQ', async () => {
    const db = new IntegrationD1();
    db.seedJob({
      id: 'job_1',
      status: 'queued',
      type: 'IMAGE_GENERATION',
      idempotency_key: 'idem_job_1',
      request_id: 'req_job_1',
    });
    const msg = buildQueueMessage({
      jobId: 'job_1',
      requestId: 'req_job_1',
      idempotencyKey: 'idem_job_1',
      jobType: 'IMAGE_GENERATION',
      payload: { mockOutcome: 'MOCK_PERMANENT_ERROR' },
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'RUNNING',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.disposition).toBe('ack');
    expect(r.code).toBe('DEAD_LETTER');
    expect(db.dead_letter_jobs.length).toBe(1);
  });
});
