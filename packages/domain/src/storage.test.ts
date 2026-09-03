import { describe, it, expect } from 'vitest';
import { MemoryStorage, type StorageMetadata } from './storage.js';

describe('MemoryStorage', () => {
  it('put then exists returns true', async () => {
    const storage = new MemoryStorage();
    const input = {
      key: 'test-object',
      body: new Uint8Array([1, 2, 3, 4]),
    };
    await storage.put(input);
    const exists = await storage.exists('test-object');
    expect(exists).toBe(true);
  });

  it('get missing key returns null', async () => {
    const storage = new MemoryStorage();
    const result = await storage.get('nonexistent-key');
    expect(result).toBeNull();
  });

  it('put then get returns identical bytes', async () => {
    const storage = new MemoryStorage();
    const originalBytes = new Uint8Array([10, 20, 30, 40, 50]);
    const input = {
      key: 'image-data',
      body: originalBytes,
    };
    await storage.put(input);
    const retrieved = await storage.get('image-data');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.body).toEqual(originalBytes);
  });

  it('metadata is preserved', async () => {
    const storage = new MemoryStorage();
    const metadata: StorageMetadata = {
      'uploaded-by': 'test-worker',
      'asset-id': 'asset-12345',
    };
    const input = {
      key: 'asset-with-metadata',
      body: new Uint8Array([1, 2, 3]),
      metadata,
    };
    await storage.put(input);
    const retrieved = await storage.get('asset-with-metadata');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.metadata).toEqual(metadata);
  });

  it('contentType is preserved', async () => {
    const storage = new MemoryStorage();
    const input = {
      key: 'image-jpeg',
      body: new Uint8Array([255, 216, 255]), // JPEG magic bytes
      contentType: 'image/jpeg',
    };
    await storage.put(input);
    const retrieved = await storage.get('image-jpeg');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.contentType).toBe('image/jpeg');
  });

  it('delete removes object', async () => {
    const storage = new MemoryStorage();
    const input = {
      key: 'to-delete',
      body: new Uint8Array([1, 2, 3]),
    };
    await storage.put(input);
    expect(await storage.exists('to-delete')).toBe(true);
    await storage.delete('to-delete');
    expect(await storage.exists('to-delete')).toBe(false);
  });

  it('delete missing key is safe (idempotent)', async () => {
    const storage = new MemoryStorage();
    // Should not throw
    await storage.delete('nonexistent-key');
    await storage.delete('nonexistent-key');
    expect(await storage.exists('nonexistent-key')).toBe(false);
  });

  it('returned byte arrays are copies and cannot mutate stored data', async () => {
    const storage = new MemoryStorage();
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5]);
    await storage.put({
      key: 'immutable-bytes',
      body: originalBytes,
    });

    // Retrieve and mutate
    const retrieved = await storage.get('immutable-bytes');
    expect(retrieved).not.toBeNull();
    retrieved!.body[0] = 99;

    // Verify stored data is unchanged
    const retrieved2 = await storage.get('immutable-bytes');
    expect(retrieved2!.body[0]).toBe(1);
  });

  it('metadata returned from get is a copy and cannot mutate stored metadata', async () => {
    const storage = new MemoryStorage();
    const metadata: StorageMetadata = {
      'version': '1.0',
      'checksum': 'abc123',
    };
    await storage.put({
      key: 'immutable-metadata',
      body: new Uint8Array([1, 2, 3]),
      metadata,
    });

    // Retrieve and mutate
    const retrieved = await storage.get('immutable-metadata');
    expect(retrieved).not.toBeNull();
    retrieved!.metadata['version'] = '2.0';
    retrieved!.metadata['newkey'] = 'newvalue';

    // Verify stored metadata is unchanged
    const retrieved2 = await storage.get('immutable-metadata');
    expect(retrieved2!.metadata['version']).toBe('1.0');
    expect(retrieved2!.metadata['newkey']).toBeUndefined();
  });

  it('overwriting an existing key replaces the object', async () => {
    const storage = new MemoryStorage();
    const key = 'overwrite-test';

    // Put first object
    await storage.put({
      key,
      body: new Uint8Array([1, 2, 3]),
      metadata: { 'version': '1' },
      contentType: 'image/jpeg',
    });

    // Overwrite with new object
    await storage.put({
      key,
      body: new Uint8Array([4, 5, 6, 7]),
      metadata: { 'version': '2' },
      contentType: 'image/png',
    });

    // Verify new object is stored
    const retrieved = await storage.get(key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.body).toEqual(new Uint8Array([4, 5, 6, 7]));
    expect(retrieved!.metadata['version']).toBe('2');
    expect(retrieved!.contentType).toBe('image/png');
  });

  it('multiple objects can coexist', async () => {
    const storage = new MemoryStorage();

    await storage.put({
      key: 'object-1',
      body: new Uint8Array([1, 1, 1]),
    });

    await storage.put({
      key: 'object-2',
      body: new Uint8Array([2, 2, 2]),
    });

    await storage.put({
      key: 'object-3',
      body: new Uint8Array([3, 3, 3]),
    });

    const obj1 = await storage.get('object-1');
    const obj2 = await storage.get('object-2');
    const obj3 = await storage.get('object-3');

    expect(obj1!.body).toEqual(new Uint8Array([1, 1, 1]));
    expect(obj2!.body).toEqual(new Uint8Array([2, 2, 2]));
    expect(obj3!.body).toEqual(new Uint8Array([3, 3, 3]));
  });

  it('put with no metadata stores empty metadata', async () => {
    const storage = new MemoryStorage();
    await storage.put({
      key: 'no-metadata',
      body: new Uint8Array([1, 2, 3]),
    });

    const retrieved = await storage.get('no-metadata');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.metadata).toEqual({});
  });

  it('exists returns false for deleted key', async () => {
    const storage = new MemoryStorage();
    const key = 'exists-test';

    await storage.put({
      key,
      body: new Uint8Array([1, 2, 3]),
    });

    expect(await storage.exists(key)).toBe(true);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });
});
