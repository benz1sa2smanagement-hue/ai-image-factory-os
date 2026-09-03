/**
 * Provider-neutral Storage abstraction.
 * Domain never imports R2Bucket, B2, S3 SDK, or Cloudflare types.
 */

export type StorageMetadata = Record<string, string>;

export interface StoragePutInput {
  key: string;
  body: Uint8Array;
  contentType?: string;
  metadata?: StorageMetadata;
}

export interface StoredObject {
  key: string;
  body: Uint8Array;
  contentType?: string;
  metadata: StorageMetadata;
}

export interface Storage {
  put(input: StoragePutInput): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/**
 * In-memory storage — MOCK_MODE and unit tests.
 * Copies all input/output bytes and metadata.
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
    const bodyCopy = new Uint8Array(input.body);
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
    if (!entry) return null;
    const metadataCopy: StorageMetadata = {};
    for (const [k, v] of Object.entries(entry.metadata)) {
      metadataCopy[k] = v;
    }
    return {
      key,
      body: new Uint8Array(entry.body),
      contentType: entry.contentType,
      metadata: metadataCopy,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  /** Test helper — list all keys (sorted). */
  listKeys(): string[] {
    return Array.from(this.store.keys()).sort();
  }
}
