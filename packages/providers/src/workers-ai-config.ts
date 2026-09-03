/**
 * Cloudflare Workers AI configuration boundary.
 * Secrets (API token) must come from runtime env / wrangler secret — never hard-coded.
 *
 * Official free tier (verified developers.cloudflare.com/workers-ai/platform/pricing 2026-08-28):
 * - 10,000 Neurons / day free (resets 00:00 UTC)
 * - Beyond free requires Workers Paid; excess billed $0.011 / 1k Neurons
 * - Model: @cf/black-forest-labs/flux-1-schnell
 * - Neuron cost: 4.80 / 512x512 tile + 9.60 / step
 */

export const WORKERS_AI_PROVIDER_ID = 'cf_workers_ai' as const;
export const WORKERS_AI_MODEL_ID = '@cf/black-forest-labs/flux-1-schnell' as const;

/** Official free daily neuron budget */
export const WORKERS_AI_FREE_DAILY_NEURONS = 10_000;

export const WORKERS_AI_DEFAULT_TIMEOUT_MS = 30_000;
export const WORKERS_AI_MAX_STEPS = 8;
export const WORKERS_AI_DEFAULT_STEPS = 4;

export interface WorkersAiConfig {
  /** Cloudflare account id (public-ish; not a secret) */
  accountId: string;
  /** API token with Workers AI run permission — from secret store */
  apiToken: string;
  /** Optional override; default official model id */
  modelId?: string;
  timeoutMs?: number;
  /** When true, adapter may call network. Default false — disabled until explicitly enabled. */
  enabled?: boolean;
}

export function assertWorkersAiConfig(
  cfg: Partial<WorkersAiConfig>
): asserts cfg is WorkersAiConfig {
  if (!cfg.accountId || typeof cfg.accountId !== 'string') {
    throw new Error('WorkersAiConfig.accountId is required');
  }
  if (!cfg.apiToken || typeof cfg.apiToken !== 'string') {
    throw new Error('WorkersAiConfig.apiToken is required');
  }
  if (cfg.timeoutMs !== undefined && (cfg.timeoutMs <= 0 || cfg.timeoutMs > 120_000)) {
    throw new Error('WorkersAiConfig.timeoutMs must be in (0, 120000]');
  }
}

export function workersAiConfigFromEnv(
  env: Record<string, string | undefined>
): Partial<WorkersAiConfig> {
  return {
    accountId: env.CF_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN ?? env.WORKERS_AI_API_TOKEN,
    modelId: env.WORKERS_AI_MODEL_ID,
    timeoutMs: env.WORKERS_AI_TIMEOUT_MS ? Number(env.WORKERS_AI_TIMEOUT_MS) : undefined,
    enabled: env.WORKERS_AI_ENABLED === 'true',
  };
}

/** Trusted REST endpoint builder — never accept user-supplied host */
export function workersAiRunUrl(accountId: string, modelId: string): string {
  const safeAccount = encodeURIComponent(accountId);
  const safeModel = modelId
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  return `https://api.cloudflare.com/client/v4/accounts/${safeAccount}/ai/run/${safeModel}`;
}
