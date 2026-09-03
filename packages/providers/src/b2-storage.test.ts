import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../../domain/src/storage.js';
import { B2Storage, createB2Storage } from './b2-storage.js';
import { FakeB2Transport, mapTransportFailure } from './b2-transport.js';
import { StorageError, STORAGE_ERROR_CODES } from './storage-errors.js';
import { assertB2Config, b2ConfigFromEnv, B2_DEFAULT_TIMEOUT_MS } from './b2-config.js';
import { buildAssetOriginalKey, parseAssetOriginalKey } from './b2-keys.js';

function testConfig() {
  return {
    endpoint: 'https://s3.example-b2.test',
    bucket: 'aif-assets-test',
    keyId: 'testKeyId',
    applicationKey: 'testAppKey-not-real',
    timeoutMs: 5_000,
  };
}

describe('B2 config boundary', () => {
  it('assertB2Config accepts complete config', () => {
    expect(() => assertB2Config(testConfig())).not.toThrow();
  });

  it('assertB2Config rejects missing fields', () => {
    expect(() => assertB2Config({ endpoint: 'x' })).toThrow(/bucket/);
  });

  it('b2ConfigFromEnv maps env keys without hardcoding secrets', () => {
    const partial = b2ConfigFromEnv({
      B2_ENDPOINT: 'https://ep',
      B2_BUCKET: 'b',
      B2_KEY_ID: 'kid',
      B2_APPLICATION_KEY: 'secret',
    });
    expect(partial.endpoint).toBe('https://ep');
    expect(partial.applicationKey).toBe('secret');
  });

  it('default timeout is bounded', () => {
    expect(B2_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(B2_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('storage key convention', () => {
  it('builds assets/{id}/original.{ext}', () => {
    expect(buildAssetOriginalKey('asset_01', 'jpg')).toBe('assets/asset_01/original.jpg');
    expect(buildAssetOriginalKey('a1', '.png')).toBe('assets/a1/original.png');
  });

  it('rejects unsafe assetId / ext', () => {
    expect(() => buildAssetOriginalKey('../etc', 'jpg')).toThrow();
    expect(() => buildAssetOriginalKey('ok', 'jpg/../../../x')).toThrow();
  });

  it('parses valid keys', () => {
    expect(parseAssetOriginalKey('assets/abc/original.jpeg')).toEqual({
      assetId: 'abc',
      ext: 'jpeg',
    });
    expect(parseAssetOriginalKey('other/key')).toBeNull();
  });
});

describe('error mapping', () => {
  it('exposes required codes', () => {
    for (const code of [
      'STORAGE_NOT_FOUND',
      'STORAGE_TIMEOUT',
      'STORAGE_UNAVAILABLE',
      'STORAGE_PERMISSION_DENIED',
      'STORAGE_INVALID_REQUEST',
      'STORAGE_UNKNOWN',
    ]) {
      expect(STORAGE_ERROR_CODES).toContain(code);
    }
  });

  it('maps common failure strings', () => {
    expect(mapTransportFailure(new Error('NoSuchKey')).code).toBe('STORAGE_NOT_FOUND');
    expect(mapTransportFailure(new Error('request timed out')).code).toBe('STORAGE_TIMEOUT');
    expect(mapTransportFailure(new Error('503 unavailable')).code).toBe('STORAGE_UNAVAILABLE');
    expect(mapTransportFailure(new Error('403 Forbidden')).code).toBe('STORAGE_PERMISSION_DENIED');
    expect(mapTransportFailure(new Error('400 Bad Request')).code).toBe('STORAGE_INVALID_REQUEST');
    expect(mapTransportFailure(new Error('weird')).code).toBe('STORAGE_UNKNOWN');
  });

  it('preserves StorageError', () => {
    const e = new StorageError('STORAGE_TIMEOUT', 't');
    expect(mapTransportFailure(e)).toBe(e);
  });
});

describe('B2Storage with FakeB2Transport (no network)', () => {
  it('put/get/exists/delete happy path', async () => {
    const transport = new FakeB2Transport();
    const storage = createB2Storage({ config: testConfig(), transport });
    const key = buildAssetOriginalKey('img1', 'jpg');
    const body = new Uint8Array([1, 2, 3, 4]);

    await storage.put({
      key,
      body,
      metadata: { assetId: 'img1' },
      contentType: 'image/jpeg',
    });

    expect(await storage.exists(key)).toBe(true);
    const got = await storage.get(key);
    expect(got).not.toBeNull();
    expect(got!.body).toEqual(body);
    expect(got!.metadata.assetId).toBe('img1');
    expect(got!.contentType).toBe('image/jpeg');

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    expect(await storage.get(key)).toBeNull();
  });

  it('delete missing key is idempotent', async () => {
    const storage = new B2Storage({ config: testConfig(), transport: new FakeB2Transport() });
    await expect(storage.delete('assets/none/original.jpg')).resolves.toBeUndefined();
  });

  it('get missing returns null', async () => {
    const storage = createB2Storage({ config: testConfig(), transport: new FakeB2Transport() });
    expect(await storage.get('assets/missing/original.jpg')).toBeNull();
  });

  it('maps transport failures to StorageError', async () => {
    const transport = new FakeB2Transport();
    const storage = createB2Storage({ config: testConfig(), transport });
    transport.failNext = 'STORAGE_PERMISSION_DENIED';
    await expect(
      storage.put({ key: 'assets/x/original.jpg', body: new Uint8Array([1]) })
    ).rejects.toMatchObject({ code: 'STORAGE_PERMISSION_DENIED' });
  });

  it('invalid put throws STORAGE_INVALID_REQUEST', async () => {
    const storage = createB2Storage({ config: testConfig(), transport: new FakeB2Transport() });
    await expect(storage.put({ key: '', body: new Uint8Array([1]) })).rejects.toMatchObject({
      code: 'STORAGE_INVALID_REQUEST',
    });
  });

  it('copy semantics: mutating returned body does not affect store', async () => {
    const transport = new FakeB2Transport();
    const storage = createB2Storage({ config: testConfig(), transport });
    const key = 'assets/c/original.bin';
    await storage.put({ key, body: new Uint8Array([9, 8, 7]) });
    const a = await storage.get(key);
    a!.body[0] = 0;
    const b = await storage.get(key);
    expect(b!.body[0]).toBe(9);
  });
});

describe('MOCK_MODE compatibility with MemoryStorage', () => {
  it('MemoryStorage still satisfies Storage for mock path', async () => {
    const mem = new MemoryStorage();
    const key = buildAssetOriginalKey('mock1', 'jpg');
    await mem.put({ key, body: new Uint8Array([0xff, 0xd8]) });
    expect(await mem.exists(key)).toBe(true);
    expect((await mem.get(key))!.body.length).toBe(2);
  });
});
