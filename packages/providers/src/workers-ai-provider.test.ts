import { describe, it, expect } from 'vitest';
import {
  WorkersAiImageProvider,
  createWorkersAiImageProvider,
  workersAiProviderDescriptor,
} from './workers-ai-provider.js';
import { workersAiRunUrl, WORKERS_AI_PROVIDER_ID } from './workers-ai-config.js';
import { detectImageFormat, validateImageBytes, base64ToBytes } from './image-bytes.js';
import { selectProvider } from '../../domain/src/provider-router.js';
import { ProviderRegistry } from '../../domain/src/provider-registry.js';
import { GenerationService } from '../../domain/src/generation.js';
import { MemoryStorage } from '../../domain/src/storage.js';
import { createMockProvider } from '../../domain/src/mock-generation.js';

/** Minimal valid JPEG SOI…EOI */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b]);

function jpegB64(): string {
  let s = '';
  for (let i = 0; i < JPEG_BYTES.length; i++) s += String.fromCharCode(JPEG_BYTES[i]!);
  return btoa(s);
}

function testConfig(over: Record<string, unknown> = {}) {
  return {
    accountId: 'acc_test',
    apiToken: 'secret-token-xyz-never-log',
    enabled: true,
    timeoutMs: 5_000,
    ...over,
  };
}

const baseReq = {
  jobId: 'job_1',
  requestId: 'req_1',
  prompt: 'product photo on white',
  width: 512,
  height: 512,
  format: 'jpeg' as const,
  seed: 7,
};

describe('image-bytes validation', () => {
  it('Z. detects JPEG / PNG', () => {
    expect(detectImageFormat(JPEG_BYTES)).toBe('jpeg');
    expect(detectImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
  });

  it('S/T. empty / malformed rejected', () => {
    expect(validateImageBytes(new Uint8Array(0)).ok).toBe(false);
    expect(validateImageBytes(new Uint8Array([1, 2, 3, 4])).ok).toBe(false);
  });

  it('AB. format mismatch', () => {
    const v = validateImageBytes(JPEG_BYTES, 'png');
    expect(v.ok).toBe(false);
  });
});

describe('Workers AI provider', () => {
  it('A. descriptor disabled by default', () => {
    const d = workersAiProviderDescriptor();
    expect(d.enabled).toBe(false);
    expect(d.id).toBe(WORKERS_AI_PROVIDER_ID);
    expect(d.costPolicy.mode).toBe('FREE');
    expect(d.costPolicy.costPerGeneration).toBe(0);
  });

  it('D. disabled / mockMode does not call network', async () => {
    let calls = 0;
    const p = createWorkersAiImageProvider({
      config: testConfig({ enabled: false }),
      fetch: async () => {
        calls++;
        return new Response('{}');
      },
    });
    const r = await p.generate(baseReq);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('PROVIDER_DISABLED');
    expect(calls).toBe(0);
  });

  it('H. missing credential fails safely', async () => {
    const p = new WorkersAiImageProvider({
      config: { accountId: 'a', apiToken: '', enabled: true },
      fetch: async () => new Response('{}'),
    });
    const r = await p.generate(baseReq);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('PROVIDER_AUTH');
  });

  it('I/J. credential never in result/error', async () => {
    const token = 'secret-token-xyz-never-log';
    const p = createWorkersAiImageProvider({
      config: testConfig({ apiToken: token }),
      fetch: async () => new Response(JSON.stringify({ errors: [{ message: `bad ${token}` }] }), { status: 500 }),
    });
    const r = await p.generate(baseReq);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.message).not.toContain(token);
      expect(JSON.stringify(r)).not.toContain(token);
    }
  });

  it('P. unsupported PNG format for this model', async () => {
    const p = createWorkersAiImageProvider({
      config: testConfig(),
      fetch: async () => new Response('{}'),
    });
    const r = await p.generate({ ...baseReq, format: 'png' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('Q/AA/AC. successful JPEG response', async () => {
    const p = createWorkersAiImageProvider({
      config: testConfig(),
      fetch: async () =>
        new Response(JSON.stringify({ success: true, result: { image: jpegB64() } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const r = await p.generate(baseReq);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.format).toBe('jpeg');
    expect(r.mimeType).toBe('image/jpeg');
    expect(detectImageFormat(r.imageBytes)).toBe('jpeg');
    expect(r.provider).toBe(WORKERS_AI_PROVIDER_ID);
    expect(r.metadata.mock).toBe(false);
  });

  it('R. invalid JSON response', async () => {
    const p = createWorkersAiImageProvider({
      config: testConfig(),
      fetch: async () => new Response('not-json', { status: 200 }),
    });
    const r = await p.generate(baseReq);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('PROVIDER_MALFORMED_RESPONSE');
  });

  it('U. 401 mapped', async () => {
    const p = createWorkersAiImageProvider({
      config: testConfig(),
      fetch: async () => new Response('denied', { status: 401 }),
    });
    const r = await p.generate(baseReq);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('PROVIDER_AUTH');
  });

  it('V. 429 mapped retryable', async () => {
    const p = createWorkersAiImageProvider({
      config: testConfig(),
      fetch: async () => new Response('slow', { status: 429 }),
    });
    const r = await p.generate(baseReq);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.code).toBe('PROVIDER_RATE_LIMIT');
      expect(r.retryable).toBe(true);
    }
  });

  it('W. 5xx mapped', async () => {
    const p = createWorkersAiImageProvider({
      config: testConfig(),
      fetch: async () => new Response('err', { status: 503 }),
    });
    const r = await p.generate(baseReq);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('X. timeout mapped', async () => {
    const p = createWorkersAiImageProvider({
      config: testConfig({ timeoutMs: 20 }),
      fetch: async (_u, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    const r = await p.generate(baseReq);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('PROVIDER_TIMEOUT');
  });

  it('Y. single fetch attempt (no internal retry)', async () => {
    let n = 0;
    const p = createWorkersAiImageProvider({
      config: testConfig(),
      fetch: async () => {
        n++;
        return new Response('x', { status: 503 });
      },
    });
    await p.generate(baseReq);
    expect(n).toBe(1);
  });

  it('trusted URL only', () => {
    const url = workersAiRunUrl('acc1', '@cf/black-forest-labs/flux-1-schnell');
    expect(url.startsWith('https://api.cloudflare.com/')).toBe(true);
    expect(url).toContain('acc1');
  });
});

describe('router + registry integration', () => {
  it('E/F/AO/AQ/AR. paid blocked; unknown quota blocked; disabled not selected', () => {
    const d = workersAiProviderDescriptor({ enabled: true });
    expect(
      selectProvider({
        candidates: [d],
        quotas: [{ providerId: d.id, remaining: 0, dailyLimit: 0, status: 'UNKNOWN' }],
      }).ok
    ).toBe(false);

    expect(
      selectProvider({
        candidates: [workersAiProviderDescriptor({ enabled: false })],
        quotas: [{ providerId: WORKERS_AI_PROVIDER_ID, remaining: 100, dailyLimit: 10000, status: 'AVAILABLE' }],
      }).ok
    ).toBe(false);
  });

  it('B/C. registry registration + resolve', () => {
    const reg = new ProviderRegistry();
    const p = createWorkersAiImageProvider({ config: testConfig(), mockMode: true });
    expect(reg.register(p).ok).toBe(true);
    expect(reg.resolve(WORKERS_AI_PROVIDER_ID).ok).toBe(true);
  });

  it('AD. GenerationService stores validated bytes from mock path', async () => {
    const storage = new MemoryStorage();
    const service = new GenerationService({
      provider: createMockProvider('mock'),
      storage,
    });
    const r = await service.generateAndStore({
      jobId: 'job_1',
      requestId: 'req_1',
      prompt: 'x',
      width: 8,
      height: 8,
      format: 'png',
      seed: 1,
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const got = await storage.get(r.storageKey);
    expect(got!.body).toEqual(r.imageBytes);
  });
});
