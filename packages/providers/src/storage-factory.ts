/**
 * Runtime storage factory — Workers-safe dependency injection.
 *
 * MOCK_MODE=true  → MemoryStorage (no network)
 * MOCK_MODE=false → B2Storage + B2HttpTransport (requires full B2 config)
 *
 * Production NEVER silently falls back to MemoryStorage.
 * Domain never imports this module's B2 types into business logic.
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

export type StorageMode = 'mock' | 'b2';

export class StorageConfigurationError extends Error {
  readonly code = 'STORAGE_CONFIGURATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigurationError';
  }
}

export interface CreateRuntimeStorageOptions {
  /** When true (default), use MemoryStorage */
  mockMode: boolean;
  /** Env map (Workers bindings / process.env style) */
  env?: Record<string, string | undefined>;
  /** Explicit B2 config override (tests) */
  b2Config?: Partial<B2Config>;
  /** Inject transport (FakeB2Transport in tests; real HTTP in production) */
  transport?: B2Transport;
  /** Optional factory for real HTTP transport when not injected */
  createHttpTransport?: (config: B2Config) => B2Transport;
}

export interface RuntimeStorageResult {
  storage: Storage;
  mode: StorageMode;
}

/**
 * Build Storage for Consumer runtime.
 * Throws StorageConfigurationError if production config is incomplete.
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
    // Never include secret values in the error
    throw new StorageConfigurationError(
      `B2 production storage misconfigured: ${msg}. Set B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APPLICATION_KEY.`
    );
  }

  const config = merged as B2Config;

  let transport: B2Transport;
  if (opts.transport) {
    transport = opts.transport;
  } else if (opts.createHttpTransport) {
    transport = opts.createHttpTransport(config);
  } else {
    // Production path requires an HTTP transport implementation.
    // Prefer explicit injection; without it, fail closed (no MemoryStorage fallback).
    throw new StorageConfigurationError(
      'B2 production storage requires a transport (createHttpTransport or transport injection)'
    );
  }

  const storage = createB2Storage({ config, transport });
  return { storage, mode: 'b2' };
}

/** Test helper: production-like B2Storage with FakeB2Transport (zero network). */
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

export function isMockMode(env: { MOCK_MODE?: string } | Record<string, string | undefined>): boolean {
  return String((env as { MOCK_MODE?: string }).MOCK_MODE ?? 'true') !== 'false';
}
