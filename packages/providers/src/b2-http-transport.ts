/**
 * Workers-compatible B2 S3-Compatible HTTP transport.
 * Implements B2Transport using fetch + AWS SigV4 (Web Crypto).
 * One HTTP attempt per call — no retry loops (job retry/DLQ is outside).
 *
 * Never logs keyId, applicationKey, Authorization, or signing keys.
 */

import type { StorageMetadata } from '../../domain/src/storage.js';
import type { B2Config } from './b2-config.js';
import { B2_DEFAULT_TIMEOUT_MS } from './b2-config.js';
import type {
  B2Transport,
  B2TransportObject,
  B2TransportPutInput,
} from './b2-transport.js';
import { StorageError } from './storage-errors.js';
import { signRequest, uriEncode } from './aws-sigv4.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface B2HttpTransportOptions {
  config: B2Config;
  /** Inject for tests; defaults to globalThis.fetch */
  fetch?: FetchLike;
}

function ensureHttpsEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, '');
  if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
    throw new StorageError('STORAGE_INVALID_REQUEST', 'B2 endpoint must be an absolute URL');
  }
  // Production must be HTTPS; allow http only for deterministic unit tests
  return trimmed;
}

/** Path-style object URL: {endpoint}/{bucket}/{key} with path segments encoded. */
export function buildObjectUrl(endpoint: string, bucket: string, key: string): string {
  const base = ensureHttpsEndpoint(endpoint);
  const keyParts = key.split('/').map((p) => uriEncode(p, true));
  return `${base}/${uriEncode(bucket, true)}/${keyParts.join('/')}`;
}

export function mapHttpStatus(status: number, statusText = ''): StorageError {
  const msg = `HTTP ${status} ${statusText}`.trim();
  if (status === 404) return new StorageError('STORAGE_NOT_FOUND', msg);
  if (status === 401 || status === 403) return new StorageError('STORAGE_PERMISSION_DENIED', msg);
  if (status === 429 || status >= 500) return new StorageError('STORAGE_UNAVAILABLE', msg);
  if (status >= 400 && status < 500) return new StorageError('STORAGE_INVALID_REQUEST', msg);
  return new StorageError('STORAGE_UNKNOWN', msg);
}

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: string }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function metadataFromResponseHeaders(headers: Headers): StorageMetadata {
  const meta: StorageMetadata = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-amz-meta-')) {
      meta[lower.slice('x-amz-meta-'.length)] = value;
    }
  });
  return meta;
}

function metadataToHeaders(metadata?: StorageMetadata): Record<string, string> {
  const out: Record<string, string> = {};
  if (!metadata) return out;
  for (const [k, v] of Object.entries(metadata)) {
    out[`x-amz-meta-${k.toLowerCase()}`] = v;
  }
  return out;
}

export class B2HttpTransport implements B2Transport {
  private readonly config: B2Config;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly region: string;

  constructor(opts: B2HttpTransportOptions) {
    this.config = opts.config;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.config.timeoutMs ?? B2_DEFAULT_TIMEOUT_MS;
    // B2 S3-compatible often uses region "us-west-000" or similar; default from config
    this.region = opts.config.region ?? 'us-west-000';
  }

  async put(input: B2TransportPutInput): Promise<void> {
    const url = buildObjectUrl(this.config.endpoint, this.config.bucket, input.key);
    const extra: Record<string, string> = {
      ...metadataToHeaders(input.metadata),
    };
    if (input.contentType) extra['content-type'] = input.contentType;

    const signed = await signRequest({
      method: 'PUT',
      url,
      headers: extra,
      body: input.body,
      accessKeyId: this.config.keyId,
      secretAccessKey: this.config.applicationKey,
      region: this.region,
      service: 's3',
    });

    const res = await this.doFetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: signed.body,
    });

    if (!res.ok) {
      throw mapHttpStatus(res.status, res.statusText);
    }
  }

  async get(key: string): Promise<B2TransportObject | null> {
    const url = buildObjectUrl(this.config.endpoint, this.config.bucket, key);
    const signed = await signRequest({
      method: 'GET',
      url,
      accessKeyId: this.config.keyId,
      secretAccessKey: this.config.applicationKey,
      region: this.region,
      service: 's3',
    });

    const res = await this.doFetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    });

    if (res.status === 404) return null;
    if (!res.ok) throw mapHttpStatus(res.status, res.statusText);

    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      key,
      body: buf,
      metadata: metadataFromResponseHeaders(res.headers),
      contentType: res.headers.get('content-type') ?? undefined,
    };
  }

  async delete(key: string): Promise<void> {
    const url = buildObjectUrl(this.config.endpoint, this.config.bucket, key);
    const signed = await signRequest({
      method: 'DELETE',
      url,
      accessKeyId: this.config.keyId,
      secretAccessKey: this.config.applicationKey,
      region: this.region,
      service: 's3',
    });

    const res = await this.doFetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    });

    // Idempotent: 404 is success at transport layer for delete
    if (res.status === 404) return;
    if (!res.ok) throw mapHttpStatus(res.status, res.statusText);
  }

  async head(key: string): Promise<boolean> {
    const url = buildObjectUrl(this.config.endpoint, this.config.bucket, key);
    const signed = await signRequest({
      method: 'HEAD',
      url,
      accessKeyId: this.config.keyId,
      secretAccessKey: this.config.applicationKey,
      region: this.region,
      service: 's3',
    });

    const res = await this.doFetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
    });

    if (res.status === 404) return false;
    if (!res.ok) throw mapHttpStatus(res.status, res.statusText);
    return true;
  }

  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (isAbortError(e)) {
        throw new StorageError('STORAGE_TIMEOUT', `storage timeout after ${this.timeoutMs}ms`, e);
      }
      throw new StorageError(
        'STORAGE_UNAVAILABLE',
        e instanceof Error ? e.message : 'network error',
        e
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createB2HttpTransport(opts: B2HttpTransportOptions): B2HttpTransport {
  return new B2HttpTransport(opts);
}
