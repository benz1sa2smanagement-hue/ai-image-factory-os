import { describe, it, expect, vi } from 'vitest';
import {
  createRuntimeStorage,
  createTestB2Storage,
  isMockMode,
  StorageConfigurationError,
} from './storage-factory.js';
import { MemoryStorage } from '../../domain/src/storage.js';
import { B2Storage } from './b2-storage.js';
import { FakeB2Transport } from './b2-transport.js';
import { B2HttpTransport } from './b2-http-transport.js';
import { StorageError } from './storage-errors.js';
import { orchestrateFactoryMessage } from '../../domain/src/job-orchestrator.js';
import { buildQueueMessage } from '../../domain/src/queue-message.js';
import {
  defaultMockRegistry,
  defaultMockCandidates,
  defaultMockQuotas,
} from '../../domain/src/job-orchestrator.js';

const validCfg = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'bucket',
  keyId: 'kid',
  applicationKey: 'secret-key-xyz-never-in-errors',
  region: 'us-west-004',
};

describe('runtime storage factory', () => {
  it('A. MOCK_MODE → MemoryStorage, no transport construction needed', () => {
    const r = createRuntimeStorage({ mockMode: true });
    expect(r.mode).toBe('mock');
    expect(r.storage).toBeInstanceOf(MemoryStorage);
  });

  it('B. production valid config → B2Storage + default B2HttpTransport', () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const r = createRuntimeStorage({
      mockMode: false,
      b2Config: validCfg,
      fetch: fetchMock,
    });
    expect(r.mode).toBe('b2');
    expect(r.storage).toBeInstanceOf(B2Storage);
    // no network until put/get
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('B2. injected FakeB2Transport works', () => {
    const r = createRuntimeStorage({
      mockMode: false,
      b2Config: validCfg,
      transport: new FakeB2Transport(),
    });
    expect(r.storage).toBeInstanceOf(B2Storage);
  });

  it('C. production missing config → explicit failure, not MemoryStorage', () => {
    expect(() =>
      createRuntimeStorage({
        mockMode: false,
        env: { B2_ENDPOINT: 'https://s3.example.com' },
      })
    ).toThrow(StorageConfigurationError);
  });

  it('C2. missing config does not return null/undefined', () => {
    let result: unknown = 'unset';
    try {
      result = createRuntimeStorage({ mockMode: false, env: {} });
    } catch (e) {
      result = e;
    }
    expect(result).toBeInstanceOf(StorageConfigurationError);
  });

  it('D. invalid config (missing region) fails', () => {
    expect(() =>
      createRuntimeStorage({
        mockMode: false,
        b2Config: {
          endpoint: 'https://s3.example.com',
          bucket: 'b',
          keyId: 'k',
          applicationKey: 's',
          // region missing
        },
      })
    ).toThrow(StorageConfigurationError);
  });

  it('E. MOCK_MODE without B2 credentials still works', () => {
    const r = createRuntimeStorage({ mockMode: true, env: {} });
    expect(r.storage).toBeInstanceOf(MemoryStorage);
  });

  it('F. secrets not in configuration errors', () => {
    try {
      createRuntimeStorage({
        mockMode: false,
        b2Config: {
          endpoint: 'https://s3.example.com',
          bucket: 'b',
          keyId: 'kid',
          applicationKey: 'secret-key-xyz-never-in-errors',
          // missing region
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      expect(msg).not.toContain('secret-key-xyz-never-in-errors');
    }
  });

  it('G. no real network in factory tests', async () => {
    const { storage } = createTestB2Storage();
    await storage.put({ key: 'k', body: new Uint8Array([9]) });
    expect(await storage.exists('k')).toBe(true);
  });

  it('production never falls back to MemoryStorage', () => {
    let mode: string | undefined;
    try {
      const r = createRuntimeStorage({ mockMode: false, env: {} });
      mode = r.mode;
    } catch {
      mode = 'threw';
    }
    expect(mode).toBe('threw');
  });
});

describe('consumer safety with invalid storage config', () => {
  it('H. generation can run only with valid Storage instance', async () => {
    // Simulate fail-closed: factory throws before orchestrator
    expect(() =>
      createRuntimeStorage({
        mockMode: false,
        env: { MOCK_MODE: 'false' },
      })
    ).toThrow(StorageConfigurationError);
  });

  it('pipeline with B2 FakeTransport succeeds', async () => {
    const { storage } = createTestB2Storage();
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_rt',
        requestId: 'req_rt',
        idempotencyKey: 'idem_rt',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'lamp', width: 16, height: 16, seed: 2 },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
      registry: defaultMockRegistry(),
      candidates: defaultMockCandidates(),
      quotas: defaultMockQuotas(),
    });
    expect(r.code).toBe('PIPELINE_PASSED');
    expect(await storage.exists(r.storageKey!)).toBe(true);
  });

  it('storage failure maps to retry', async () => {
    const { storage, transport } = createTestB2Storage();
    transport.failNext = new StorageError('STORAGE_UNAVAILABLE', 'down');
    const r = await orchestrateFactoryMessage({
      msg: buildQueueMessage({
        jobId: 'job_sf2',
        requestId: 'req_sf2',
        idempotencyKey: 'idem_sf2',
        jobType: 'IMAGE_GENERATION',
        payload: { prompt: 'x', width: 8, height: 8 },
      }),
      factoryStatus: 'RUNNING',
      storage,
      allowWithoutDb: true,
    });
    expect(r.disposition).toBe('retry');
  });
});
