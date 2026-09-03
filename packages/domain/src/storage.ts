/**
 * Provider-neutral storage abstraction.
 * Vendor-agnostic interface for storing/retrieving/deleting binary objects.
 * MemoryStorage is deterministic and safe for testing / MOCK_MODE.
 *
 * Implementations may target R2, B2, S3, filesystem, memory, etc.
 * Domain code must never import Cloudflare / AWS / Backblaze SDKs.
 */

export type StorageMetadata = Record<string, string>;

export interface StoragePutInput {
  key: string;
  body: Uint8Array;
  metadata?: StorageMetadata;
  contentType?: string;
}

export interface StoredObject {
  key: string;
  body: Uint8Array;
  metadata: StorageMetadata;
  contentType?: string;
}

/**
 * Storage interface — vendor-neutral contract.
 */
export interface Storage {
  /**
   * Store an object.
   * Must copy input bytes and metadata (not retain references).
   * Overwriting an existing key is allowed and replaces the object.
   */
  put(input: StoragePutInput): Promise<void>;

  /**
   * Retrieve an object or null if missing.
   * Must return copies of bytes and metadata (not references).
   */
  get(key: string): Promise<StoredObject | null>;

  /**
   * Delete an object.
   * Deleting a missing key must be safe (idempotent, no error).
   */
  delete(key: string): Promise<void>;

  /**
   * Check if an object exists.
   */
  exists(key: string): Promise<boolean>;
}

/**
 * In-memory storage implementation.
 * Safe for MOCK_MODE and unit tests.
 * - Copies all input/output bytes and metadata
 * - Idempotent delete
 * - No external dependencies
 */
export class MemoryStorage implements Storage {
  private store: Map<
    string,
    { body: Uint8Array; metadata: StorageMetadata; contentType?: string }
  >;

  constructor() {
    this.store = new Map();
  }

  async put(input: StoragePutInput): Promise<void> {
    // Copy bytes (defensive — do not share reference with caller)
    const bodyCopy = new Uint8Array(input.body);

    // Copy metadata (defensive)
    const metadataCopy: StorageMetadata = {};
    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        metadataCopy[k] = v;
      }
    }

    this.store.set(input.key, {
      body: bodyCopy,
      metadata: metadataCopy,
      contentType: input.contentType,
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    // Copy bytes (defensive)
    const bodyCopy = new Uint8Array(entry.body);

    // Copy metadata (defensive)
    const metadataCopy: StorageMetadata = {};
    for (const [k, v] of Object.entries(entry.metadata)) {
      metadataCopy[k] = v;
    }

    return {
      key,
      body: bodyCopy,
      metadata: metadataCopy,
      contentType: entry.contentType,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
}
