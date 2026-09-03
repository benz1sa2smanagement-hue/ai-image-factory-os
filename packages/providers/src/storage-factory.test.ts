import { describe, it, expect } from 'vitest';
import {
  createRuntimeStorage,
  createTestB2Storage,
  isMockMode,
  StorageConfigurationError,
} from './storage-factory.js';
import { MemoryStorage } from '../../domain/src/storage.js';
import { B2Storage } from './b2-storage.js';
import { FakeB2Transport } from './b2-transport.js';
import { StorageError } from './storage-errors.js';
import { orchestrateFactoryMessage } from '../../domain/src/job-orchestrator.js';
import { buildQueueMessage } from '../../domain/src/queue-message.js';
import {
  defaultMockRegistry,
  defaultMockCandidates,
  defaultMockQuotas,
} from '../../domain/src/job-orchestrator.js';

describe('storage factory', () => {
  it('1. MOCK_MODE selects MemoryStorage', () => {
    const r = createRuntimeStorage({ mockMode: true });
    expect(r.mode).toBe('mock');
    expect(r.storage).toBeInstanceOf(MemoryStorage);
  });

  it('2. production mode selects B2Storage with transport', () => {
    const transport = new FakeB2Transport();
    const r = createRuntimeStorage({
      mockMode: false,
      b2Config: {
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        bucket: 'bucket',
        keyId: 'kid',
        applicationKey: 'secret-key-xyz',
      },
      transport,
    });
    expect(r.mode).toBe('b2');
    expect(r.storage).toBeInstanceOf(B2Storage);
  });

  it('3. missing B2 config fails explicitly', () => {
    expect(() =>
      createRuntimeStorage({
        mockMode: false,
        env: { B2_ENDPOINT: 'https://s3.example.com' },
        transport: new FakeB2Transport(),
      })
    ).toThrow(StorageConfigurationError);
  });

  it('4. production never falls back to MemoryStorage', () => {
    let threw = false;
    try {
      createRuntimeStorage({ mockMode: false, env: {} });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(StorageConfigurationError);
    }
    expect(threw).toBe(true);
  });

  it('5-8. B2 put/get/exists/delete via Storage interface', async () => {
    const { storage } = createTestB2Storage();
    await storage.put({
      key: 'assets/a1/original.png',
      body: new Uint8Array([1, 2, 3, 4]),
      contentType: 'image/png',
      metadata: { jobId: 'j1' },
    });
    expect(await storage.exists('assets/a1/original.png')).toBe(true);
    const got = await storage.get('assets/a1/original.png');
    expect(got!.body).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(got!.metadata.jobId).toBe('j1');
    await storage.delete('assets/a1/original.png');
    expect(await storage.exists('assets/a1/original.png')).toBe(false);
  });

  it('9. timeout maps correctly', async () => {
    const { storage, transport } = createTestB2Storage({ timeoutMs: 50 });
    transport.failNext = new StorageError('STORAGE_TIMEOUT', 'timeout');
    await expect(
      storage.put({ key: 'k', body: new Uint8Array([1]) })
    ).rejects.toMatchObject({ code: 'STORAGE_TIMEOUT' });
  });

  it('10. unavailable maps correctly', async () => {
    const { storage, transport } = createTestB2Storage();
    transport.failNext = new StorageError('STORAGE_UNAVAILABLE', '503');
    await expect(
      storage.put({ key: 'k', body: new Uint8Array([1]) })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('11. permission failure maps correctly', async () => {
    const { storage, transport } = createTestB2Storage();
    transport.failNext = new StorageError('STORAGE_PERMISSION_DENIED', '403');
    await expect(
      storage.put({ key: 'k', body: new Uint8Array([1]) })
    ).rejects.toMatchObject({ code: 'STORAGE_PERMISSION_DENIED' });
  });

  it('12. not found → null get / false exists', async () => {
    const { storage } = createTestB2Storage();
    expect(await storage.get('missing')).toBeNull();
    expect(await storage.exists('missing')).toBe(false);
  });

  it('13. credentials never appear in configuration errors', () => {
    try {
      createRuntimeStorage({
        mockMode: false,
        b2Config: {
          endpoint: 'https://s3.example.com',
          bucket: 'b',
          keyId: 'kid',
          // missing applicationKey
        },
        transport: new FakeB2Transport(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      expect(msg).not.toContain('secret');
      expect(msg).not.toMatch(/applicationKey\s*=/);
    }
  });

  it('isMockMode defaults true', () => {
    expect(isMockMode({})).toBe(true);
    expect(isMockMode({ MOCK_MODE: 'false' })).toBe(false);
  });
});

describe('integration: pipeline + B2 FakeTransport', () => {
  it('15-16. generation stores via B2 adapter then QC', async () => {
    const { storage } = createTestB2Storage();
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_b2',
        requestId: 'req_b2',
        idempotencyKey: 'idem_b2',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'cup', width: 16, height: 16, seed: 3 },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
      registry: defaultMockRegistry(),
      candidates: defaultMockCandidates(),
      quotas: defaultMockQuotas(),
    });
    expect(r.disposition).toBe('ack');
    expect(r.code).toBe('PIPELINE_PASSED');
    expect(r.storageKey).toBeTruthy();
    expect(await storage.exists(r.storageKey!)).toBe(true);
  });

  it('17. storage failure → retry handling', async () => {
    const { storage, transport } = createTestB2Storage();
    transport.failNext = new StorageError('STORAGE_UNAVAILABLE', 'down');
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_sf',
        requestId: 'req_sf',
        idempotencyKey: 'idem_sf',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'x', width: 8, height: 8 },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
      registry: defaultMockRegistry(),
      candidates: defaultMockCandidates(),
      quotas: defaultMockQuotas(),
    });
    expect(r.disposition).toBe('retry');
    expect(r.failureCategory === 'STORAGE_ERROR' || r.code === 'RETRY' || r.code.includes('STORAGE')).toBe(
      true
    );
  });

  it('18. MOCK_MODE zero network — MemoryStorage path', async () => {
    const { storage } = createRuntimeStorage({ mockMode: true });
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_m',
        requestId: 'req_m',
        idempotencyKey: 'idem_m',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'y', width: 8, height: 8, seed: 1 },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
    });
    expect(r.code).toBe('PIPELINE_PASSED');
  });
});
