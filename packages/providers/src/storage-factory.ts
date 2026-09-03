/**
 * Runtime storage factory — ONE authoritative construction path.
 *
 * MOCK_MODE=true  → MemoryStorage (no B2HttpTransport, no network)
 * MOCK_MODE=false → B2Config → B2HttpTransport → B2Storage
 *
 * Production NEVER falls back to MemoryStorage.
 * Production NEVER returns null/undefined Storage.
 */

import { MemoryStorage, type Storage } from '../../domain/src/storage.js';
import {
  assertB2Config,
  b2ConfigFromEnv,
  type B2Config,
} from './b2-config.js';
import { B2Storage, createB2Storage } from './b2-storage.js';
import type { B2Transport } from './b2-transport.js';
import { FakeB2Transport } from './b2-transport.js';
import { createB2HttpTransport, type FetchLike } from './b2-http-transport.js';

export type StorageMode = 'mock' | 'b2';

export class StorageConfigurationError extends Error {
  readonly code = 'STORAGE_CONFIGURATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigurationError';
  }
}

export interface CreateRuntimeStorageOptions {
  mockMode: boolean;
  env?: Record<string, string | undefined>;
  b2Config?: Partial<B2Config>;
  /** Inject transport (tests: FakeB2Transport). Production defaults to B2HttpTransport. */
  transport?: B2Transport;
  /** Override fetch used by default B2HttpTransport (tests). */
  fetch?: FetchLike;
  /** Optional override factory; default creates B2HttpTransport */
  createHttpTransport?: (config: B2Config) => B2Transport;
}

export interface RuntimeStorageResult {
  storage: Storage;
  mode: StorageMode;
}

function defaultCreateHttpTransport(
  config: B2Config,
  fetch?: FetchLike
): B2Transport {
  return createB2HttpTransport({ config, fetch });
}

/**
 * Build Storage for Consumer runtime.
 * Always returns a concrete Storage or throws StorageConfigurationError.
 */
export function createRuntimeStorage(
  opts: CreateRuntimeStorageOptions
): RuntimeStorageResult {
  if (opts.mockMode) {
    return { storage: new MemoryStorage(), mode: 'mock' };
  }

  const fromEnv = opts.env ? b2ConfigFromEnv(opts.env) : {};
  const merged: Partial<B2Config> = { ...fromEnv, ...opts.b2Config };

  try {
    assertB2Config(merged);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid B2 config';
    throw new StorageConfigurationError(
      `B2 production storage misconfigured: ${msg}. Set B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APPLICATION_KEY, B2_REGION.`
    );
  }

  const config = merged as B2Config;

  // Require region in production (assertB2Config does not require it today)
  if (!config.region || typeof config.region !== 'string') {
    throw new StorageConfigurationError(
      'B2 production storage misconfigured: B2_REGION is required.'
    );
  }

  let transport: B2Transport;
  if (opts.transport) {
    transport = opts.transport;
  } else if (opts.createHttpTransport) {
    transport = opts.createHttpTransport(config);
  } else {
    transport = defaultCreateHttpTransport(config, opts.fetch);
  }

  const storage = createB2Storage({ config, transport });
  return { storage, mode: 'b2' };
}

/** Test helper: B2Storage + FakeB2Transport (zero network). */
export function createTestB2Storage(
  over: Partial<B2Config> = {}
): { storage: B2Storage; transport: FakeB2Transport; config: B2Config } {
  const config: B2Config = {
    endpoint: over.endpoint ?? 'https://s3.us-west-004.backblazeb2.com',
    bucket: over.bucket ?? 'aif-test-bucket',
    keyId: over.keyId ?? 'testKeyId',
    applicationKey: over.applicationKey ?? 'testApplicationKey-never-log',
    region: over.region ?? 'us-west-004',
    timeoutMs: over.timeoutMs ?? 5_000,
  };
  assertB2Config(config);
  const transport = new FakeB2Transport();
  const storage = createB2Storage({ config, transport });
  return { storage, transport, config };
}

export function isMockMode(
  env: { MOCK_MODE?: string } | Record<string, string | undefined>
): boolean {
  return String((env as { MOCK_MODE?: string }).MOCK_MODE ?? 'true') !== 'false';
}
