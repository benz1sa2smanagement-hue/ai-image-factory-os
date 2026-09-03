import { describe, it, expect } from 'vitest';
import {
  selectProvider,
  listEligibleProviders,
  freeProviderDescriptor,
  paidProviderDescriptor,
  DEFAULT_ROUTER_POLICY,
  type ProviderDescriptor,
  type ProviderQuotaSnapshot,
} from './provider-router.js';
import { GenerationService } from './generation.js';
import { MockGenerationProvider } from './mock-generation.js';
import { MemoryStorage } from './storage.js';

function available(providerId: string, remaining = 10): ProviderQuotaSnapshot {
  return {
    providerId,
    remaining,
    dailyLimit: 100,
    status: 'AVAILABLE',
  };
}

describe('ProviderRouter selection', () => {
  it('A. selects eligible free provider', () => {
    const candidates = [freeProviderDescriptor({ id: 'mock-free-a', priority: 1 })];
    const r = selectProvider({
      candidates,
      quotas: [available('mock-free-a')],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.selected.id).toBe('mock-free-a');
  });

  it('B. rejects paid provider when paid=false', () => {
    const candidates = [paidProviderDescriptor({ id: 'mock-paid-a', priority: 1 })];
    const r = selectProvider({
      candidates,
      quotas: [available('mock-paid-a')],
      policy: { allowPaidProviders: false, maxAllowedCost: 0 },
    });
    expect(r.ok).toBe(false);
    expect(r.evaluations[0]!.reasons).toContain('PAID_BLOCKED');
  });

  it('C. paid provider eligible only when policy allows', () => {
    const candidates = [paidProviderDescriptor({ id: 'mock-paid-a', priority: 1 })];
    const blocked = selectProvider({
      candidates,
      quotas: [available('mock-paid-a')],
      policy: { allowPaidProviders: false, maxAllowedCost: 0 },
    });
    expect(blocked.ok).toBe(false);

    const allowed = selectProvider({
      candidates,
      quotas: [available('mock-paid-a')],
      policy: { allowPaidProviders: true, maxAllowedCost: 10 },
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.selected.id).toBe('mock-paid-a');
  });

  it('D. exhausted quota rejected', () => {
    const candidates = [freeProviderDescriptor({ id: 'mock-exhausted' })];
    const r = selectProvider({
      candidates,
      quotas: [
        { providerId: 'mock-exhausted', remaining: 0, dailyLimit: 10, status: 'EXHAUSTED' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.evaluations[0]!.reasons).toContain('QUOTA_EXHAUSTED');
  });

  it('E. unknown quota rejected (not treated as infinite free)', () => {
    const candidates = [freeProviderDescriptor({ id: 'mock-unknown-quota' })];
    const r = selectProvider({
      candidates,
      quotas: [
        {
          providerId: 'mock-unknown-quota',
          remaining: 0,
          dailyLimit: 0,
          status: 'UNKNOWN',
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.evaluations[0]!.reasons).toContain('QUOTA_UNKNOWN');
  });

  it('E2. missing quota snapshot → QUOTA_UNKNOWN', () => {
    const candidates = [freeProviderDescriptor({ id: 'mock-free-a' })];
    const r = selectProvider({ candidates, quotas: [] });
    expect(r.ok).toBe(false);
    expect(r.evaluations[0]!.reasons).toContain('QUOTA_UNKNOWN');
  });

  it('F. unhealthy provider rejected', () => {
    const candidates = [
      freeProviderDescriptor({
        id: 'mock-unhealthy',
        healthPolicy: { status: 'UNAVAILABLE' },
      }),
    ];
    const r = selectProvider({
      candidates,
      quotas: [available('mock-unhealthy')],
    });
    expect(r.ok).toBe(false);
    expect(r.evaluations[0]!.reasons).toContain('UNHEALTHY');
  });

  it('G. cooldown provider rejected', () => {
    const now = 1_000_000;
    const candidates = [
      freeProviderDescriptor({
        id: 'mock-cooldown',
        healthPolicy: { status: 'HEALTHY', cooldownUntil: now + 60_000 },
      }),
    ];
    const r = selectProvider({
      candidates,
      quotas: [available('mock-cooldown')],
      policy: { now },
    });
    expect(r.ok).toBe(false);
    expect(r.evaluations[0]!.reasons).toContain('COOLDOWN');
  });

  it('H. disabled provider rejected', () => {
    const candidates = [freeProviderDescriptor({ id: 'mock-off', enabled: false })];
    const r = selectProvider({
      candidates,
      quotas: [available('mock-off')],
    });
    expect(r.ok).toBe(false);
    expect(r.evaluations[0]!.reasons).toContain('DISABLED');
  });

  it('I. non-image provider rejected', () => {
    const candidates = [
      freeProviderDescriptor({ id: 'mock-text', supportsImageGeneration: false }),
    ];
    const r = selectProvider({
      candidates,
      quotas: [available('mock-text')],
    });
    expect(r.ok).toBe(false);
    expect(r.evaluations[0]!.reasons).toContain('NOT_IMAGE_PROVIDER');
  });

  it('J. higher priority wins (lower number)', () => {
    const candidates = [
      freeProviderDescriptor({ id: 'mock-free-b', priority: 20, qualityScore: 99 }),
      freeProviderDescriptor({ id: 'mock-free-a', priority: 10, qualityScore: 1 }),
    ];
    const r = selectProvider({
      candidates,
      quotas: [available('mock-free-a'), available('mock-free-b')],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.selected.id).toBe('mock-free-a');
  });

  it('K. quality score tie-breaker', () => {
    const candidates = [
      freeProviderDescriptor({ id: 'mock-free-b', priority: 5, qualityScore: 10 }),
      freeProviderDescriptor({ id: 'mock-free-a', priority: 5, qualityScore: 90 }),
    ];
    const r = selectProvider({
      candidates,
      quotas: [available('mock-free-a'), available('mock-free-b')],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.selected.id).toBe('mock-free-a');
  });

  it('L. provider id stable tie-breaker', () => {
    const candidates = [
      freeProviderDescriptor({ id: 'mock-free-z', priority: 1, qualityScore: 50 }),
      freeProviderDescriptor({ id: 'mock-free-a', priority: 1, qualityScore: 50 }),
    ];
    const r = selectProvider({
      candidates,
      quotas: [available('mock-free-a'), available('mock-free-z')],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.selected.id).toBe('mock-free-a');
  });

  it('M. deterministic selection', () => {
    const candidates = [
      freeProviderDescriptor({ id: 'mock-free-b', priority: 2 }),
      freeProviderDescriptor({ id: 'mock-free-a', priority: 1 }),
    ];
    const quotas = [available('mock-free-a'), available('mock-free-b')];
    const a = selectProvider({ candidates, quotas });
    const b = selectProvider({ candidates, quotas });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.selected.id).toBe(b.selected.id);
  });

  it('default policy is zero-cost', () => {
    expect(DEFAULT_ROUTER_POLICY.allowPaidProviders).toBe(false);
    expect(DEFAULT_ROUTER_POLICY.maxAllowedCost).toBe(0);
  });

  it('listEligibleProviders returns ranked list for fallback', () => {
    const candidates = [
      freeProviderDescriptor({ id: 'mock-free-b', priority: 2 }),
      freeProviderDescriptor({ id: 'mock-free-a', priority: 1 }),
      paidProviderDescriptor({ id: 'mock-paid-a', priority: 0 }),
    ];
    const list = listEligibleProviders({
      candidates,
      quotas: [
        available('mock-free-a'),
        available('mock-free-b'),
        available('mock-paid-a'),
      ],
      policy: { allowPaidProviders: false },
    });
    expect(list.map((p) => p.id)).toEqual(['mock-free-a', 'mock-free-b']);
  });
});

describe('Router does not touch quota lifecycle (N/O/P)', () => {
  it('selectProvider is pure — no mutation of snapshots', () => {
    const quotas: ProviderQuotaSnapshot[] = [
      { providerId: 'mock-free-a', remaining: 5, dailyLimit: 10, status: 'AVAILABLE' },
    ];
    const before = structuredClone(quotas);
    selectProvider({
      candidates: [freeProviderDescriptor({ id: 'mock-free-a' })],
      quotas,
    });
    expect(quotas).toEqual(before);
  });
});

describe('no network / credentials / deps (Q/R/S)', () => {
  it('works with GenerationService + MockGenerationProvider', async () => {
    const candidates: ProviderDescriptor[] = [
      freeProviderDescriptor({ id: 'mock', priority: 1 }),
    ];
    const selected = selectProvider({
      candidates,
      quotas: [available('mock')],
    });
    expect(selected.ok).toBe(true);

    const service = new GenerationService({
      provider: new MockGenerationProvider(),
      storage: new MemoryStorage(),
    });
    const result = await service.generateAndStore({
      jobId: 'job_1',
      requestId: 'req_1',
      prompt: 'product',
      width: 8,
      height: 8,
      format: 'png',
      seed: 1,
    });
    expect(result.success).toBe(true);
  });
});
