/**
 * Small B2 transport boundary — no AWS/Backblaze SDK required for foundation.
 * Real networking will implement this interface later (Workers-compatible fetch).
 * Unit tests inject FakeB2Transport only.
 */

import type { StorageMetadata } from '../../domain/src/storage.js';
import { StorageError, type StorageErrorCode } from './storage-errors.js';

export interface B2TransportPutInput {
  key: string;
  body: Uint8Array;
  metadata?: StorageMetadata;
  contentType?: string;
}

export interface B2TransportObject {
  key: string;
  body: Uint8Array;
  metadata: StorageMetadata;
  contentType?: string;
}

/**
 * Minimal object-store transport. Implementations must be Workers-safe.
 */
export interface B2Transport {
  put(input: B2TransportPutInput): Promise<void>;
  get(key: string): Promise<B2TransportObject | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<boolean>;
}

/**
 * Map low-level/vendor failure hints into provider-neutral StorageError codes.
 * Pure function — no I/O.
 */
export function mapTransportFailure(
  err: unknown,
  fallback: StorageErrorCode = 'STORAGE_UNKNOWN'
): StorageError {
  if (err instanceof StorageError) return err;

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('not found') || lower.includes('nosuchkey') || lower.includes('404')) {
    return new StorageError('STORAGE_NOT_FOUND', msg, err);
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) {
    return new StorageError('STORAGE_TIMEOUT', msg, err);
  }
  if (
    lower.includes('unavailable') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('econnrefused') ||
    lower.includes('network')
  ) {
    return new StorageError('STORAGE_UNAVAILABLE', msg, err);
  }
  if (
    lower.includes('access denied') ||
    lower.includes('forbidden') ||
    lower.includes('unauthorized') ||
    lower.includes('403') ||
    lower.includes('401')
  ) {
    return new StorageError('STORAGE_PERMISSION_DENIED', msg, err);
  }
  if (lower.includes('invalid') || lower.includes('bad request') || lower.includes('400')) {
    return new StorageError('STORAGE_INVALID_REQUEST', msg, err);
  }
  return new StorageError(fallback, msg, err);
}

/**
 * In-memory fake transport for unit tests / MOCK paths.
 * Copies bytes and metadata; no network.
 */
export class FakeB2Transport implements B2Transport {
  private store = new Map<
    string,
    { body: Uint8Array; metadata: StorageMetadata; contentType?: string }
  >();

  /** Optional hook to simulate failures */
  failNext?: StorageErrorCode | Error;

  private maybeFail(): void {
    if (!this.failNext) return;
    const f = this.failNext;
    this.failNext = undefined;
    if (f instanceof Error) throw f;
    throw new StorageError(f, `simulated ${f}`);
  }

  async put(input: B2TransportPutInput): Promise<void> {
    this.maybeFail();
    const metadata: StorageMetadata = {};
    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) metadata[k] = v;
    }
    this.store.set(input.key, {
      body: new Uint8Array(input.body),
      metadata,
      contentType: input.contentType,
    });
  }

  async get(key: string): Promise<B2TransportObject | null> {
    this.maybeFail();
    const entry = this.store.get(key);
    if (!entry) return null;
    const metadata: StorageMetadata = {};
    for (const [k, v] of Object.entries(entry.metadata)) metadata[k] = v;
    return {
      key,
      body: new Uint8Array(entry.body),
      metadata,
      contentType: entry.contentType,
    };
  }

  async delete(key: string): Promise<void> {
    this.maybeFail();
    this.store.delete(key);
  }

  async head(key: string): Promise<boolean> {
    this.maybeFail();
    return this.store.has(key);
  }
}
