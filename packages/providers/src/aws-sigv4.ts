/**
 * AWS Signature Version 4 — Workers-compatible (Web Crypto only).
 * Generic for S3-compatible APIs (B2, R2, MinIO, etc.).
 * No Node crypto, no Buffer, no AWS SDK.
 */

const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(hash);
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const keyBytes = key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

/**
 * URI-encode a single path segment per AWS SigV4 rules.
 * Unreserved: A-Z a-z 0-9 - . _ ~
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ch = value[i]!;
    if (
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x61 && c <= 0x7a) || // a-z
      (c >= 0x30 && c <= 0x39) || // 0-9
      ch === '-' ||
      ch === '.' ||
      ch === '_' ||
      ch === '~' ||
      (!encodeSlash && ch === '/')
    ) {
      out += ch;
    } else {
      const bytes = encoder.encode(ch);
      for (let j = 0; j < bytes.length; j++) {
        out += '%' + bytes[j]!.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

/** Canonical URI: encode each path segment, keep slashes. */
export function canonicalUri(path: string): string {
  if (!path || path === '/') return '/';
  const parts = path.split('/');
  return parts.map((p) => uriEncode(p, true)).join('/');
}

/** Canonical query string: sort by encoded key then value. */
export function canonicalQueryString(params: Record<string, string> | URLSearchParams): string {
  const entries: [string, string][] = [];
  if (params instanceof URLSearchParams) {
    params.forEach((v, k) => entries.push([k, v]));
  } else {
    for (const [k, v] of Object.entries(params)) entries.push([k, v]);
  }
  entries.sort((a, b) => {
    const ka = uriEncode(a[0]);
    const kb = uriEncode(b[0]);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    const va = uriEncode(a[1]);
    const vb = uriEncode(b[1]);
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
  return entries.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
}

/**
 * Canonical headers + signed headers list.
 * Header names lowercased, values trimmed, sorted by name.
 */
export function canonicalHeaders(headers: Record<string, string>): {
  canonicalHeaders: string;
  signedHeaders: string;
} {
  const normalized: [string, string][] = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase().trim();
    const value = v.trim().replace(/\s+/g, ' ');
    normalized.push([name, value]);
  }
  normalized.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonical = normalized.map(([k, v]) => `${k}:${v}\n`).join('');
  const signed = normalized.map(([k]) => k).join(';');
  return { canonicalHeaders: canonical, signedHeaders: signed };
}

export function buildCanonicalRequest(parts: {
  method: string;
  uri: string;
  query: string;
  headers: string;
  signedHeaders: string;
  payloadHash: string;
}): string {
  return [
    parts.method,
    parts.uri,
    parts.query,
    parts.headers,
    parts.signedHeaders,
    parts.payloadHash,
  ].join('\n');
}

export function credentialScope(dateStamp: string, region: string, service: string): string {
  return `${dateStamp}/${region}/${service}/aws4_request`;
}

export function stringToSign(
  amzDate: string,
  scope: string,
  canonicalRequestHash: string
): string {
  return ['AWS4-HMAC-SHA256', amzDate, scope, canonicalRequestHash].join('\n');
}

/** Derive signing key: HMAC chain from secret. */
export async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(encoder.encode('AWS4' + secretAccessKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

export async function signStringToSign(
  signingKey: ArrayBuffer,
  sts: string
): Promise<string> {
  const sig = await hmacSha256(signingKey, sts);
  return toHex(sig);
}

export function buildAuthorizationHeader(parts: {
  accessKeyId: string;
  scope: string;
  signedHeaders: string;
  signature: string;
}): string {
  return (
    'AWS4-HMAC-SHA256 ' +
    `Credential=${parts.accessKeyId}/${parts.scope}, ` +
    `SignedHeaders=${parts.signedHeaders}, ` +
    `Signature=${parts.signature}`
  );
}

export interface SignRequestInput {
  method: string;
  /** Full URL (https only for production use) */
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  /** Override clock for tests — ISO-like or Date */
  now?: Date;
}

export interface SignedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  amzDate: string;
  payloadHash: string;
}

/** Format date as YYYYMMDD'T'HHMMSS'Z' */
export function formatAmzDate(d: Date): { amzDate: string; dateStamp: string } {
  const iso = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // 20260903T120000Z
  const amzDate = iso.endsWith('Z') ? iso : iso + 'Z';
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Sign an HTTP request with AWS SigV4.
 * Returns headers including Authorization — never log secretAccessKey or Authorization in callers.
 */
export async function signRequest(input: SignRequestInput): Promise<SignedRequest> {
  const service = input.service ?? 's3';
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = formatAmzDate(now);

  const parsed = new URL(input.url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('signRequest: only http(s) URLs supported');
  }

  const payloadHash = input.body
    ? await sha256Hex(input.body)
    : await sha256Hex(new Uint8Array(0));

  const headers: Record<string, string> = {};
  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) {
      headers[k.toLowerCase()] = v;
    }
  }
  headers['host'] = parsed.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = payloadHash;

  const { canonicalHeaders: canonHdrs, signedHeaders } = canonicalHeaders(headers);
  const uri = canonicalUri(parsed.pathname || '/');
  const query = canonicalQueryString(parsed.searchParams);
  const canonical = buildCanonicalRequest({
    method: input.method.toUpperCase(),
    uri,
    query,
    headers: canonHdrs,
    signedHeaders,
    payloadHash,
  });
  const canonHash = await sha256Hex(canonical);
  const scope = credentialScope(dateStamp, input.region, service);
  const sts = stringToSign(amzDate, scope, canonHash);
  const signingKey = await deriveSigningKey(
    input.secretAccessKey,
    dateStamp,
    input.region,
    service
  );
  const signature = await signStringToSign(signingKey, sts);
  const authorization = buildAuthorizationHeader({
    accessKeyId: input.accessKeyId,
    scope,
    signedHeaders,
    signature,
  });

  return {
    method: input.method.toUpperCase(),
    url: input.url,
    headers: {
      ...headers,
      authorization,
    },
    body: input.body,
    amzDate,
    payloadHash,
  };
}
