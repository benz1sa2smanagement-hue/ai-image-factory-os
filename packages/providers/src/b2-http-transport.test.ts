import { describe, it, expect, vi } from 'vitest';
import {
  B2HttpTransport,
  buildObjectUrl,
  mapHttpStatus,
  createB2HttpTransport,
  type FetchLike,
} from './b2-http-transport.js';
import type { B2Config } from './b2-config.js';
import { StorageError } from './storage-errors.js';

function testConfig(over: Partial<B2Config> = {}): B2Config {
  return {
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    bucket: 'aif-assets',
    keyId: 'testKeyIdOnly',
    applicationKey: 'testApplicationKeyOnly-not-real',
    region: 'us-west-004',
    timeoutMs: 5_000,
    ...over,
  };
}

function jsonResponse(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('buildObjectUrl', () => {
  it('path-style encodes bucket and key segments', () => {
    const url = buildObjectUrl(
      'https://s3.example.test',
      'my-bucket',
      'assets/id 1/original.jpg'
    );
    expect(url).toBe('https://s3.example.test/my-bucket/assets/id%201/original.jpg');
  });
});

describe('mapHttpStatus', () => {
  it('maps 404/403/401/429/5xx/4xx', () => {
    expect(mapHttpStatus(404).code).toBe('STORAGE_NOT_FOUND');
    expect(mapHttpStatus(403).code).toBe('STORAGE_PERMISSION_DENIED');
    expect(mapHttpStatus(401).code).toBe('STORAGE_PERMISSION_DENIED');
    expect(mapHttpStatus(429).code).toBe('STORAGE_UNAVAILABLE');
    expect(mapHttpStatus(500).code).toBe('STORAGE_UNAVAILABLE');
    expect(mapHttpStatus(503).code).toBe('STORAGE_UNAVAILABLE');
    expect(mapHttpStatus(400).code).toBe('STORAGE_INVALID_REQUEST');
  });
});

describe('B2HttpTransport request construction (mock fetch)', () => {
  it('PUT signs and sends body + content-type + meta', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200);
    };
    const t = createB2HttpTransport({ config: testConfig(), fetch: fetchMock });
    await t.put({
      key: 'assets/a1/original.jpg',
      body: new Uint8Array([0xff, 0xd8]),
      contentType: 'image/jpeg',
      metadata: { assetId: 'a1' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/aif-assets/assets/a1/original.jpg');
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(h['authorization']).toMatch(/^AWS4-HMAC-SHA256/);
    expect(h['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(h['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(h['content-type']).toBe('image/jpeg');
    expect(h['x-amz-meta-assetid']).toBe('a1');
    expect(h['host']).toBe('s3.us-west-004.backblazeb2.com');
    expect(calls[0]!.init!.method).toBe('PUT');
  });

  it('GET returns body metadata content-type', async () => {
    const fetchMock: FetchLike = async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-amz-meta-assetid': 'x',
        },
      });
    const t = new B2HttpTransport({ config: testConfig(), fetch: fetchMock });
    const obj = await t.get('assets/x/original.png');
    expect(obj).not.toBeNull();
    expect(obj!.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(obj!.contentType).toBe('image/png');
    expect(obj!.metadata.assetid).toBe('x');
  });

  it('GET 404 → null', async () => {
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async () => jsonResponse(404),
    });
    expect(await t.get('assets/missing/original.jpg')).toBeNull();
  });

  it('HEAD 200 → true, 404 → false', async () => {
    let status = 200;
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async () => jsonResponse(status),
    });
    expect(await t.head('assets/a/original.jpg')).toBe(true);
    status = 404;
    expect(await t.head('assets/a/original.jpg')).toBe(false);
  });

  it('DELETE 200 and 404 succeed (idempotent)', async () => {
    for (const status of [200, 404]) {
      const t = createB2HttpTransport({
        config: testConfig(),
        fetch: async () => jsonResponse(status),
      });
      await expect(t.delete('assets/a/original.jpg')).resolves.toBeUndefined();
    }
  });

  it('GET uses method GET and signs without body hash of payload file', async () => {
    const calls: RequestInit[] = [];
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async (_u, init) => {
        calls.push(init!);
        return jsonResponse(404);
      },
    });
    await t.get('assets/z/original.jpg');
    expect(calls[0]!.method).toBe('GET');
    const h = calls[0]!.headers as Record<string, string>;
    expect(h['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('HEAD uses method HEAD', async () => {
    const methods: string[] = [];
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async (_u, init) => {
        methods.push(init!.method!);
        return jsonResponse(200);
      },
    });
    await t.head('assets/z/original.jpg');
    expect(methods[0]).toBe('HEAD');
  });

  it('DELETE uses method DELETE', async () => {
    const methods: string[] = [];
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async (_u, init) => {
        methods.push(init!.method!);
        return jsonResponse(200);
      },
    });
    await t.delete('assets/z/original.jpg');
    expect(methods[0]).toBe('DELETE');
  });
});

describe('B2HttpTransport error mapping', () => {
  it('403 → STORAGE_PERMISSION_DENIED', async () => {
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async () => jsonResponse(403, 'Forbidden'),
    });
    await expect(t.put({ key: 'k', body: new Uint8Array([1]) })).rejects.toMatchObject({
      code: 'STORAGE_PERMISSION_DENIED',
    });
  });

  it('429 → STORAGE_UNAVAILABLE', async () => {
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async () => jsonResponse(429),
    });
    await expect(t.head('k')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('500 → STORAGE_UNAVAILABLE', async () => {
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async () => jsonResponse(500),
    });
    await expect(t.get('k')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('timeout / AbortError → STORAGE_TIMEOUT', async () => {
    const t = createB2HttpTransport({
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
    await expect(t.head('k')).rejects.toMatchObject({ code: 'STORAGE_TIMEOUT' });
  });
});

describe('security: no credential leakage in errors / public fields', () => {
  it('StorageError messages do not embed applicationKey', async () => {
    const secret = 'super-secret-application-key-xyz';
    const t = createB2HttpTransport({
      config: testConfig({ applicationKey: secret }),
      fetch: async () => jsonResponse(500, 'server boom'),
    });
    try {
      await t.get('assets/a/original.jpg');
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError);
      const msg = String((e as Error).message);
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain('super-secret');
      // Authorization must not appear in mapped HTTP errors
      expect(msg.toLowerCase()).not.toContain('authorization');
    }
  });

  it('mock fetch never required to log Authorization in test assertions beyond presence', async () => {
    // Ensure we can assert header exists without printing secrets in test output patterns
    let auth = '';
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async (_u, init) => {
        auth = (init!.headers as Record<string, string>)['authorization'] ?? '';
        return jsonResponse(200);
      },
    });
    await t.head('assets/a/original.jpg');
    expect(auth.startsWith('AWS4-HMAC-SHA256')).toBe(true);
    expect(auth).not.toContain(testConfig().applicationKey);
  });
});

describe('one attempt only (no internal retry)', () => {
  it('single fetch call on failure', async () => {
    let n = 0;
    const t = createB2HttpTransport({
      config: testConfig(),
      fetch: async () => {
        n += 1;
        return jsonResponse(503);
      },
    });
    await expect(t.put({ key: 'k', body: new Uint8Array([1]) })).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(n).toBe(1);
  });
});
