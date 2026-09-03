/**
 * B2 configuration boundary.
 * Secrets must never be hardcoded — inject via env / wrangler secret / dashboard.
 * No real network is performed by this module.
 */

export interface B2Config {
  /** S3-compatible endpoint, e.g. https://s3.us-west-004.backblazeb2.com */
  endpoint: string;
  /** Bucket name */
  bucket: string;
  /** Application Key ID (public identifier, not the secret) */
  keyId: string;
  /** Application Key secret — must come from secret store, never git */
  applicationKey: string;
  /** Optional region hint for S3-compatible clients */
  region?: string;
  /** Request timeout in ms (bounded; default 15s) */
  timeoutMs?: number;
}

export const B2_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Validate config shape without performing network I/O.
 * Does not verify credentials against B2.
 */
export function assertB2Config(cfg: Partial<B2Config>): asserts cfg is B2Config {
  if (!cfg.endpoint || typeof cfg.endpoint !== 'string') {
    throw new Error('B2Config.endpoint is required');
  }
  if (!cfg.bucket || typeof cfg.bucket !== 'string') {
    throw new Error('B2Config.bucket is required');
  }
  if (!cfg.keyId || typeof cfg.keyId !== 'string') {
    throw new Error('B2Config.keyId is required');
  }
  if (!cfg.applicationKey || typeof cfg.applicationKey !== 'string') {
    throw new Error('B2Config.applicationKey is required');
  }
  if (cfg.timeoutMs !== undefined && (cfg.timeoutMs <= 0 || cfg.timeoutMs > 60_000)) {
    throw new Error('B2Config.timeoutMs must be in (0, 60000]');
  }
}

/**
 * Build config from environment-like record.
 * Compatible with Workers env bindings / process.env style maps.
 * Missing values yield undefined fields — caller must assert before live use.
 */
export function b2ConfigFromEnv(env: Record<string, string | undefined>): Partial<B2Config> {
  return {
    endpoint: env.B2_ENDPOINT,
    bucket: env.B2_BUCKET,
    keyId: env.B2_KEY_ID,
    applicationKey: env.B2_APPLICATION_KEY,
    region: env.B2_REGION,
    timeoutMs: env.B2_TIMEOUT_MS ? Number(env.B2_TIMEOUT_MS) : undefined,
  };
}
