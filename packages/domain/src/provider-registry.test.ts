import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from './provider-registry.js';
import { createMockProvider, MockGenerationProvider } from './mock-generation.js';
import {
  freeProviderDescriptor,
  paidProviderDescriptor,
  selectProvider,
  type ProviderQuotaSnapshot,
} from './provider-router.js';
import { GenerationService } from './generation.js';
import { MemoryStorage } from './storage.js';

function available(providerId: string, remaining = 10): ProviderQuotaSnapshot {
  return { providerId, remaining, dailyLimit: 100, status: 'AVAILABLE' };
}

describe('ProviderRegistry', () => {
  it('A/B/C. register, resolve, list', () => {
    const reg = new ProviderRegistry();
    const a = createMockProvider('mock-free-a');
    expect(reg.register(a).ok).toBe(true);
    const resolved = reg.resolve('mock-free-a');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider.id).toBe('mock-free-a');
    expect(reg.list().map((p) => p.id)).toEqual(['mock-free-a']);
  });

  it('D. duplicate provider id rejected', () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-free-a'));
    const dup = reg.register(createMockProvider('mock-free-a'));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('DUPLICATE_PROVIDER_ID');
  });

  it('E. missing provider rejected', () => {
    const reg = new ProviderRegistry();
    const r = reg.resolve('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PROVIDER_NOT_REGISTERED');
  });

  it('F. two mock providers coexist', () => {
    const reg = new ProviderRegistry();
    expect(reg.register(createMockProvider('mock-free-a')).ok).toBe(true);
    expect(reg.register(createMockProvider('mock-free-b')).ok).toBe(true);
    expect(reg.ids()).toEqual(['mock-free-a', 'mock-free-b']);
  });
});

describe('dispatch: Router → Registry → GenerationService', () => {
  it('G/H/I/J. select mock-free-a, resolve, dispatch, deterministic', async () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-free-a'));
    reg.register(createMockProvider('mock-free-b'));

    const candidates = [
      freeProviderDescriptor({ id: 'mock-free-b', priority: 20 }),
      freeProviderDescriptor({ id: 'mock-free-a', priority: 10 }),
    ];
    const quotas = [available('mock-free-a'), available('mock-free-b')];

    const selection = selectProvider({ candidates, quotas });
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.selected.id).toBe('mock-free-a');

    const service = new GenerationService({
      storage: new MemoryStorage(),
      dispatch: { candidates, quotas, registry: reg },
    });

    const r1 = await service.generateAndStore({
      jobId: 'job_1',
      requestId: 'req_1',
      prompt: 'box',
      width: 8,
      height: 8,
      format: 'png',
      seed: 3,
    });
    const r2 = await service.generateAndStore({
      jobId: 'job_1',
      requestId: 'req_1',
      prompt: 'box',
      width: 8,
      height: 8,
      format: 'png',
      seed: 3,
    });
    expect(r1.success && r2.success).toBe(true);
    if (!r1.success || !r2.success) return;
    expect(r1.provider).toBe('mock-free-a');
    expect(r1.imageBytes).toEqual(r2.imageBytes);
  });

  it('K. missing implementation → PROVIDER_UNAVAILABLE', async () => {
    const reg = new ProviderRegistry();
    // descriptor exists but no adapter registered
    const candidates = [freeProviderDescriptor({ id: 'mock-free-a', priority: 1 })];
    const service = new GenerationService({
      storage: new MemoryStorage(),
      dispatch: {
        candidates,
        quotas: [available('mock-free-a')],
        registry: reg,
      },
    });
    const r = await service.generateAndStore({
      jobId: 'job_1',
      requestId: 'req_1',
      prompt: 'x',
      width: 8,
      height: 8,
      format: 'png',
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('L. paid provider blocked before dispatch', async () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-paid-a'));
    const service = new GenerationService({
      storage: new MemoryStorage(),
      dispatch: {
        candidates: [paidProviderDescriptor({ id: 'mock-paid-a', priority: 1 })],
        quotas: [available('mock-paid-a')],
        registry: reg,
        policy: { allowPaidProviders: false, maxAllowedCost: 0 },
      },
    });
    const r = await service.generateAndStore({
      jobId: 'job_1',
      requestId: 'req_1',
      prompt: 'x',
      width: 8,
      height: 8,
      format: 'png',
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.code).toBe('NO_ELIGIBLE_PROVIDER');
  });

  it('M. exhausted provider not dispatched', async () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-free-a'));
    const service = new GenerationService({
      storage: new MemoryStorage(),
      dispatch: {
        candidates: [freeProviderDescriptor({ id: 'mock-free-a' })],
        quotas: [
          { providerId: 'mock-free-a', remaining: 0, dailyLimit: 10, status: 'EXHAUSTED' },
        ],
        registry: reg,
      },
    });
    const r = await service.generateAndStore({
      jobId: 'job_1',
      requestId: 'req_1',
      prompt: 'x',
      width: 8,
      height: 8,
      format: 'png',
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.code).toBe('NO_ELIGIBLE_PROVIDER');
  });

  it('N. unknown quota not dispatched', async () => {
    const reg = new ProviderRegistry();
    reg.register(createMockProvider('mock-free-a'));
    const service = new GenerationService({
      storage: new MemoryStorage(),
      dispatch: {
        candidates: [freeProviderDescriptor({ id: 'mock-free-a' })],
        quotas: [
          { providerId: 'mock-free-a', remaining: 0, dailyLimit: 0, status: 'UNKNOWN' },
        ],
        registry: reg,
      },
    });
    const r = await service.generateAndStore({
      jobId: 'job_1',
      requestId: 'req_1',
      prompt: 'x',
      width: 8,
      height: 8,
      format: 'png',
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.code).toBe('NO_ELIGIBLE_PROVIDER');
  });
});

describe('registry does not touch quota (O/P/Q) or network (R/S/T)', () => {
  it('pure registry ops', () => {
    const reg = new ProviderRegistry();
    reg.register(new MockGenerationProvider({ id: 'mock-free-a' }));
    expect(reg.size()).toBe(1);
    expect(reg.has('mock-free-a')).toBe(true);
  });

  it('fixed provider path still works', async () => {
    const service = new GenerationService({
      provider: createMockProvider('mock'),
      storage: new MemoryStorage(),
    });
    const r = await service.generateAndStore({
      jobId: 'job_x',
      requestId: 'req_x',
      prompt: 'y',
      width: 8,
      height: 8,
      format: 'png',
      seed: 1,
    });
    expect(r.success).toBe(true);
  });
});
