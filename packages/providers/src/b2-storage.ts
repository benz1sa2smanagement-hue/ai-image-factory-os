/**
 * B2 Storage adapter — implements domain Storage via B2Transport.
 * Lives outside domain. Domain never imports this module.
 *
 * Foundation only: no real B2 network, no AWS SDK, no credentials in code.
 * Inject FakeB2Transport for tests; real transport comes later.
 */

import type {
  Storage,
  StoragePutInput,
  StoredObject,
} from '../../domain/src/storage.js';
import type { B2Config } from './b2-config.js';
import { B2_DEFAULT_TIMEOUT_MS } from './b2-config.js';
import type { B2Transport } from './b2-transport.js';
import { mapTransportFailure } from './b2-transport.js';
import { StorageError } from './storage-errors.js';

export interface B2StorageOptions {
  config: B2Config;
  transport: B2Transport;
}

/**
 * B2-backed Storage implementation.
 * put/get/delete/exists match domain Storage semantics (copy on write/read,
 * idempotent delete, null on missing get).
 */
export class B2Storage implements Storage {
  readonly config: B2Config;
  private readonly transport: B2Transport;
  private readonly timeoutMs: number;

  constructor(opts: B2StorageOptions) {
    this.config = opts.config;
    this.transport = opts.transport;
    this.timeoutMs = opts.config.timeoutMs ?? B2_DEFAULT_TIMEOUT_MS;
  }

  async put(input: StoragePutInput): Promise<void> {
    if (!input.key || input.body == null) {
      throw new StorageError('STORAGE_INVALID_REQUEST', 'put requires key and body');
    }
    try {
      await this.withTimeout(
        this.transport.put({
          key: input.key,
          body: input.body,
          metadata: input.metadata,
          contentType: input.contentType,
        })
      );
    } catch (e) {
      throw mapTransportFailure(e);
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    if (!key) {
      throw new StorageError('STORAGE_INVALID_REQUEST', 'get requires key');
    }
    try {
      const obj = await this.withTimeout(this.transport.get(key));
      if (!obj) return null;
      return {
        key: obj.key,
        body: obj.body,
        metadata: obj.metadata,
        contentType: obj.contentType,
      };
    } catch (e) {
      const mapped = mapTransportFailure(e);
      if (mapped.code === 'STORAGE_NOT_FOUND') return null;
      throw mapped;
    }
  }

  async delete(key: string): Promise<void> {
    if (!key) {
      throw new StorageError('STORAGE_INVALID_REQUEST', 'delete requires key');
    }
    try {
      await this.withTimeout(this.transport.delete(key));
    } catch (e) {
      const mapped = mapTransportFailure(e);
      // Idempotent: missing key is not an error
      if (mapped.code === 'STORAGE_NOT_FOUND') return;
      throw mapped;
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!key) {
      throw new StorageError('STORAGE_INVALID_REQUEST', 'exists requires key');
    }
    try {
      return await this.withTimeout(this.transport.head(key));
    } catch (e) {
      const mapped = mapTransportFailure(e);
      if (mapped.code === 'STORAGE_NOT_FOUND') return false;
      throw mapped;
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new StorageError('STORAGE_TIMEOUT', `storage timeout after ${this.timeoutMs}ms`));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * Factory helper — keeps construction consistent for future real transport.
 */
export function createB2Storage(opts: B2StorageOptions): B2Storage {
  return new B2Storage(opts);
}
