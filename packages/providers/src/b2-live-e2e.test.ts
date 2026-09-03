/**
 * Opt-in LIVE Backblaze B2 E2E validation.
 *
 * REQUIRES:
 *   B2_LIVE_E2E=true
 *   B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APPLICATION_KEY, B2_REGION
 *
 * Without B2_LIVE_E2E=true this suite SKIPS — never contacts B2 in normal CI.
 *
 * Path under test:
 *   Storage (B2Storage) → B2HttpTransport → SigV4 → real B2
 *
 * Cleanup is mandatory (finally DELETE). Leaves zero test objects on success.
 * Never logs credentials.
 */

import { describe, it, expect } from 'vitest';
import { createRuntimeStorage, StorageConfigurationError } from './storage-factory.js';
import { assertB2Config, b2ConfigFromEnv } from './b2-config.js';

const LIVE = process.env.B2_LIVE_E2E === 'true';

function requireLiveEnv(): void {
  const required = [
    'B2_ENDPOINT',
    'B2_BUCKET',
    'B2_KEY_ID',
    'B2_APPLICATION_KEY',
    'B2_REGION',
  ] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `B2 live E2E missing configuration: ${missing.join(', ')} (values not printed)`
    );
  }
  const endpoint = process.env.B2_ENDPOINT!;
  if (!endpoint.startsWith('https://')) {
    throw new Error('B2_ENDPOINT must use HTTPS');
  }
}

function uniqueKey(): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `e2e/task12/${id}/test.bin`;
}

describe.skipIf(!LIVE)('LIVE B2 E2E (opt-in B2_LIVE_E2E=true)', () => {
  it('PUT → HEAD → GET → DELETE → HEAD via B2Storage + B2HttpTransport', async () => {
    requireLiveEnv();

    // Production path: mockMode=false auto-wires B2HttpTransport
    const { storage, mode } = createRuntimeStorage({
      mockMode: false,
      env: {
        B2_ENDPOINT: process.env.B2_ENDPOINT,
        B2_BUCKET: process.env.B2_BUCKET,
        B2_KEY_ID: process.env.B2_KEY_ID,
        B2_APPLICATION_KEY: process.env.B2_APPLICATION_KEY,
        B2_REGION: process.env.B2_REGION,
        B2_TIMEOUT_MS: process.env.B2_TIMEOUT_MS ?? '15000',
      },
    });

    expect(mode).toBe('b2');

    const key = uniqueKey();
    const payload = new TextEncoder().encode(
      'AI Image Factory Task 12 B2 E2E test'
    );

    let putOk = false;
    try {
      // STEP 1 — PUT
      await storage.put({
        key,
        body: payload,
        contentType: 'application/octet-stream',
        metadata: { e2e: 'task12' },
      });
      putOk = true;

      // STEP 2 — HEAD / exists
      expect(await storage.exists(key)).toBe(true);

      // STEP 3 — GET + byte verification
      const got = await storage.get(key);
      expect(got).not.toBeNull();
      expect(got!.body).toEqual(payload);

      // STEP 4 — DELETE
      await storage.delete(key);

      // STEP 5 — HEAD after delete
      expect(await storage.exists(key)).toBe(false);
      expect(await storage.get(key)).toBeNull();
    } finally {
      // Cleanup protection — always attempt DELETE if put succeeded
      if (putOk) {
        try {
          await storage.delete(key);
        } catch {
          // report via rethrow only if object still present
          const stillThere = await storage.exists(key).catch(() => false);
          if (stillThere) {
            throw new Error(
              `B2 E2E cleanup failed: object still exists at e2e key (key not logged)`
            );
          }
        }
      }
    }
  }, 60_000);

  it('config validates without printing secrets', () => {
    requireLiveEnv();
    const cfg = b2ConfigFromEnv({
      B2_ENDPOINT: process.env.B2_ENDPOINT,
      B2_BUCKET: process.env.B2_BUCKET,
      B2_KEY_ID: process.env.B2_KEY_ID,
      B2_APPLICATION_KEY: process.env.B2_APPLICATION_KEY,
      B2_REGION: process.env.B2_REGION,
    });
    expect(() => assertB2Config(cfg)).not.toThrow();
    expect(cfg.endpoint!.startsWith('https://')).toBe(true);
  });
});

describe('LIVE B2 E2E guardrails (always run)', () => {
  it('skips live path when B2_LIVE_E2E is not true', () => {
    expect(LIVE).toBe(false);
  });

  it('missing production config fails closed (no MemoryStorage)', () => {
    expect(() =>
      createRuntimeStorage({
        mockMode: false,
        env: {},
      })
    ).toThrow(StorageConfigurationError);
  });

  it('MOCK_MODE still uses MemoryStorage without B2 credentials', async () => {
    const { storage, mode } = createRuntimeStorage({ mockMode: true });
    expect(mode).toBe('mock');
    await storage.put({ key: 'local-only', body: new Uint8Array([1, 2]) });
    expect(await storage.exists('local-only')).toBe(true);
  });
});
