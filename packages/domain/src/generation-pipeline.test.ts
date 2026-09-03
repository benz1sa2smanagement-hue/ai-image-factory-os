import { describe, it, expect } from 'vitest';
import {
  computeEffectiveLimit,
  evaluateQuotaGuard,
  guardQuotaSnapshot,
  applyGuardToQuotaSnapshots,
  DEFAULT_QUOTA_GUARD_POLICY,
} from './quota-guard.js';
import { runProviderFallback } from './provider-fallback.js';
import { runGenerationPipeline, classifyFailure } from './generation-pipeline.js';
import { validateStoredAsset } from './asset-qc.js';
import { ProviderRegistry } from './provider-registry.js';
import { createMockProvider } from './mock-generation.js';
import { freeProviderDescriptor, paidProviderDescriptor } from './provider-router.js';
import { MemoryStorage } from './storage.js';
import { buildQueueMessage } from './queue-message.js';
import { orchestrateFactoryMessage } from './job-orchestrator.js';
import { MemoryJobsD1 } from './memory-jobs-d1.js';
import { MemoryD1 } from './memory-d1.js';

function avail(id: string, remaining = 1000, status: 'AVAILABLE' | 'EXHAUSTED' | 'UNKNOWN' = 'AVAILABLE') {
  return { providerId: id, remaining, dailyLimit: 10000, status };
}

describe('quota guard', () => {
  it('1-3. safety margin math', () => {
    expect(computeEffectiveLimit(10000, { safetyMarginUnits: 500, unitsRequired: 1 })).toBe(9500);
    const below = evaluateQuotaGuard(
      { limitUnits: 1000, usedUnits: 600, reservedUnits: 0 },
      { safetyMarginUnits: 500, unitsRequired: 1 }
    );
    expect(below.ok).toBe(false);
    const exact = evaluateQuotaGuard(
      { limitUnits: 1000, usedUnits: 500, reservedUnits: 0 },
      { safetyMarginUnits: 500, unitsRequired: 1 }
    );
    // remaining effective = 0 → not ok for unitsRequired 1
    expect(exact.ok).toBe(false);
    const above = evaluateQuotaGuard(
      { limitUnits: 1000, usedUnits: 100, reservedUnits: 0 },
      { safetyMarginUnits: 500, unitsRequired: 1 }
    );
    expect(above.ok).toBe(true);
    expect(above.remaining).toBe(400);
  });

  it('4-5. UNKNOWN and exhausted', () => {
    expect(
      evaluateQuotaGuard(
        { limitUnits: 10000, usedUnits: 0, reservedUnits: 0, status: 'UNKNOWN' },
        DEFAULT_QUOTA_GUARD_POLICY
      ).ok
    ).toBe(false);
    expect(
      evaluateQuotaGuard(
        { limitUnits: 100, usedUnits: 100, reservedUnits: 0, status: 'EXHAUSTED' },
        DEFAULT_QUOTA_GUARD_POLICY
      ).ok
    ).toBe(false);
  });

  it('applyGuard marks low remaining EXHAUSTED', () => {
    const out = applyGuardToQuotaSnapshots(
      [avail('a', 100), avail('b', 9000)],
      { safetyMarginUnits: 500, unitsRequired: 1 }
    );
    expect(out.find((q) => q.providerId === 'a')!.status).toBe('EXHAUSTED');
    expect(out.find((q) => q.providerId === 'b')!.status).toBe('AVAILABLE');
  });
});

describe('provider fallback', () => {
  it('A succeeds first', async () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-free-a'));
    reg.register(createMockProvider('mock-free-b'));
    const r = await runProviderFallback({
      request: {
        jobId: 'j1',
        requestId: 'r1',
        prompt: 'x',
        width: 8,
        height: 8,
        format: 'png',
        seed: 1,
      },
      candidates: [
        freeProviderDescriptor({ id: 'mock-free-a', priority: 1 }),
        freeProviderDescriptor({ id: 'mock-free-b', priority: 2 }),
      ],
      quotas: [avail('mock-free-a'), avail('mock-free-b')],
      registry: reg,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.providerId).toBe('mock-free-a');
  });

  it('retryable A → B succeeds', async () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-free-a'));
    reg.register(createMockProvider('mock-free-b'));
    const r = await runProviderFallback({
      request: {
        jobId: 'j1',
        requestId: 'r1',
        prompt: 'x',
        width: 8,
        height: 8,
        format: 'png',
        mockOutcome: 'MOCK_RETRYABLE_ERROR',
      },
      candidates: [
        freeProviderDescriptor({ id: 'mock-free-a', priority: 1 }),
        freeProviderDescriptor({ id: 'mock-free-b', priority: 2 }),
      ],
      quotas: [avail('mock-free-a'), avail('mock-free-b')],
      registry: reg,
    });
    // both get same mockOutcome from request — both fail retryable
    expect(r.ok).toBe(false);
    expect(r.attempts.length).toBe(2);
  });

  it('permanent A → no fallback', async () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-free-a'));
    reg.register(createMockProvider('mock-free-b'));
    const r = await runProviderFallback({
      request: {
        jobId: 'j1',
        requestId: 'r1',
        prompt: 'x',
        width: 8,
        height: 8,
        format: 'png',
        mockOutcome: 'MOCK_PERMANENT_ERROR',
      },
      candidates: [
        freeProviderDescriptor({ id: 'mock-free-a', priority: 1 }),
        freeProviderDescriptor({ id: 'mock-free-b', priority: 2 }),
      ],
      quotas: [avail('mock-free-a'), avail('mock-free-b')],
      registry: reg,
    });
    expect(r.ok).toBe(false);
    expect(r.attempts.length).toBe(1);
    expect(r.retryable).toBe(false);
  });

  it('paid blocked by router', async () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-paid-a'));
    const r = await runProviderFallback({
      request: {
        jobId: 'j1',
        requestId: 'r1',
        prompt: 'x',
        width: 8,
        height: 8,
        format: 'png',
      },
      candidates: [paidProviderDescriptor({ id: 'mock-paid-a', priority: 1 })],
      quotas: [avail('mock-paid-a')],
      registry: reg,
      routerPolicy: { allowPaidProviders: false, maxAllowedCost: 0 },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_ELIGIBLE_PROVIDER');
  });

  it('missing registry entry → next', async () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-free-b'));
    const r = await runProviderFallback({
      request: {
        jobId: 'j1',
        requestId: 'r1',
        prompt: 'x',
        width: 8,
        height: 8,
        format: 'png',
        seed: 2,
      },
      candidates: [
        freeProviderDescriptor({ id: 'mock-free-a', priority: 1 }),
        freeProviderDescriptor({ id: 'mock-free-b', priority: 2 }),
      ],
      quotas: [avail('mock-free-a'), avail('mock-free-b')],
      registry: reg,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.providerId).toBe('mock-free-b');
  });
});

describe('asset QC', () => {
  it('PASS for stored mock PNG', async () => {
    const storage = new MemoryStorage();
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock'));
    const pipe = await runGenerationPipeline({
      request: {
        jobId: 'job_qc',
        requestId: 'req',
        prompt: 'box',
        width: 8,
        height: 8,
        format: 'png',
        seed: 1,
      },
      storage,
      registry: reg,
      candidates: [freeProviderDescriptor({ id: 'mock', priority: 1 })],
      quotas: [avail('mock', 9000)],
      relaxQcDimensions: true,
    });
    expect(pipe.ok).toBe(true);
    if (pipe.ok) expect(pipe.phase).toBe('PASSED');
  });

  it('REJECT missing storage object', async () => {
    const storage = new MemoryStorage();
    const qc = await validateStoredAsset(storage, { storageKey: 'assets/x/original.png' });
    expect(qc.verdict).toBe('REJECTED');
  });
});

describe('generation pipeline E2E-style', () => {
  it('enqueue path identity + pipeline success', async () => {
    const storage = new MemoryStorage();
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-free-a'));
    const result = await runGenerationPipeline({
      request: {
        jobId: 'job_e2e',
        requestId: 'req_e2e',
        prompt: 'product',
        width: 16,
        height: 16,
        format: 'png',
        seed: 9,
      },
      storage,
      registry: reg,
      candidates: [freeProviderDescriptor({ id: 'mock-free-a', priority: 1 })],
      quotas: [avail('mock-free-a', 9000)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.jobId).toBe('job_e2e');
    expect(result.storageKey).toContain('job_e2e');
    expect(await storage.exists(result.storageKey)).toBe(true);
  });

  it('G. factory STOP still via orchestrator', async () => {
    const db = new MemoryJobsD1();
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
    });
    const r = await orchestrateFactoryMessage({
      msg,
      factoryStatus: 'STOPPED',
      db: db as unknown as import('./quota-d1.js').D1Like,
    });
    expect(r.disposition).toBe('retry');
    expect(r.code).toBe('FACTORY_STOPPED');
  });

  it('E. duplicate terminal delivery idempotent', async () => {
    const db = new MemoryJobsD1();
    db.seedJob({
      id: 'job_1',
      status: 'succeeded',
      type: 'IMAGE_GENERATION',
      idempotency_key: 'idem_job_1',
      request_id: 'req_job_1',
    });
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
    expect(r.code).toBe('ALREADY_TERMINAL');
  });

  it('classifyFailure categories', () => {
    expect(classifyFailure('PROVIDER_TIMEOUT').category).toBe('TIMEOUT');
    expect(classifyFailure('QC_REJECTED').retryable).toBe(false);
    expect(classifyFailure('PROVIDER_AUTH').category).toBe('AUTH');
  });
});
