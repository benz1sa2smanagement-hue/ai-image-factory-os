/**
 * AI Bridge Constants & Guardrails
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { LauncherAdapter, ProviderType } from './types.ts';

export const ALLOWED_REPOSITORIES = [
  'benz1sa2smanagement-hue/ai-image-factory-os',
] as const;

export const ALLOWED_BRANCHES = ['main'] as const;

export const DEFAULT_TASK_FILE = 'docs/AI_TASK.md';
export const DEFAULT_REPORT_FILE = 'docs/AI_REPORT.md';
export const DEFAULT_HANDOFF_FILE = 'AI_AGENT_HANDOFF.md';
export const DEFAULT_AUDIT_LOG_FILE = 'docs/AI_BRIDGE_AUDIT.log';
export const DEFAULT_KILL_SWITCH_FILE = '.bridge-stop';
export const DEFAULT_LOCK_FILE = '.bridge-lock';

/**
 * Operator-controlled zero-overage verification file.
 * MUST reside at an operator-controlled location outside the repository workspace
 * to maintain the trust boundary (agents cannot self-authorize).
 */
export const DEFAULT_OPERATOR_ZERO_OVERAGE_FILE = path.join(
  os.homedir(),
  '.config',
  'antigravity',
  'zero-overage-verified.json'
);

/** Path to Antigravity CLI configuration/settings */
export const DEFAULT_ANTIGRAVITY_SETTINGS_FILE = path.join(
  os.homedir(),
  '.config',
  'antigravity',
  'settings.json'
);

/** Backward compatibility alias */
export const DEFAULT_ZERO_OVERAGE_FILE = DEFAULT_OPERATOR_ZERO_OVERAGE_FILE;

/** Default remote git configuration */
export const DEFAULT_REMOTE_NAME = 'origin';
export const DEFAULT_REMOTE_BRANCH = 'main';

/** Default poll interval for watch mode (30 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Approved Providers under repository zero-cost policy.
 * - 'openrouter': free-tier models only (:free suffix)
 * - 'antigravity': Google AI Pro subscription with confirmed zero-overage (Never) only
 */
export const APPROVED_PROVIDERS: readonly ProviderType[] = [
  'openrouter',
  'antigravity',
];

/**
 * EXPLICIT allowlist of approved OpenRouter free-tier model IDs (cost_policy: free-tier).
 * Any model not on this exact list is BLOCKED.
 */
export const APPROVED_OPENROUTER_FREE_MODELS: readonly string[] = [
  'nvidia/nemotron-3.5-lightning:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-coder-32b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'google/gemini-2.0-flash-thinking-exp:free',
  'deepseek/deepseek-r1:free',
  'deepseek/deepseek-chat:free',
];

/** Default free OpenRouter model */
export const DEFAULT_OPENROUTER_MODEL = 'nvidia/nemotron-3.5-lightning:free';

/** Backward-compatibility aliases */
export const APPROVED_FREE_MODELS = APPROVED_OPENROUTER_FREE_MODELS;
export const DEFAULT_FREE_MODEL = DEFAULT_OPENROUTER_MODEL;

/**
 * EXPLICIT allowlist of approved Antigravity model slugs (cost_policy: subscription_with_zero_overage).
 * Based on official Antigravity CLI models with explicit quality/effort suffixes.
 * Exact matching only — no suffix addition, removal, or silent mutation.
 */
export const APPROVED_ANTIGRAVITY_MODELS: readonly string[] = [
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-high',
  'gemini-3.1-pro-high',
];

/** Default Antigravity model slug: gemini-3.8-flash-medium */
export const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-3.8-flash-medium';

/**
 * Explicit allowlist of approved launcher adapters with provider and cost contract.
 *
 * Rules:
 * - Antigravity invokes official interface: agy -p "<prompt>" --model <slug>
 * - Model must be passed explicitly via --model for Antigravity
 * - Antigravity cost policy is 'subscription_with_zero_overage' (requires confirmed zero-overage)
 * - OpenRouter free models CANNOT be used with Antigravity (and vice versa)
 * - No credentials transferred between tools
 */
export const LAUNCHER_ADAPTERS: readonly LauncherAdapter[] = [
  {
    name: 'ori-claude',
    provider: 'openrouter',
    costPolicy: 'free-tier',
    modelSelectionMode: 'explicit',
    binary: 'ori',
    prefixArgs: ['claude'],
    modelArgFlag: '--model',
    approvedModels: APPROVED_OPENROUTER_FREE_MODELS,
    defaultModel: DEFAULT_OPENROUTER_MODEL,
    description: 'Existing ori claude developer wrapper (OpenRouter free-tier)',
  },
  {
    name: 'antigravity',
    provider: 'antigravity',
    costPolicy: 'subscription_with_zero_overage',
    modelSelectionMode: 'explicit',
    binary: 'agy',
    prefixArgs: ['-p'],
    modelArgFlag: '--model',
    isHeadlessPrompt: true,
    approvedModels: APPROVED_ANTIGRAVITY_MODELS,
    defaultModel: DEFAULT_ANTIGRAVITY_MODEL,
    description: 'Official Antigravity CLI headless interface: agy -p "<prompt>" --model <slug>',
  },
  {
    name: 'agy',
    provider: 'antigravity',
    costPolicy: 'subscription_with_zero_overage',
    modelSelectionMode: 'explicit',
    binary: 'agy',
    prefixArgs: ['-p'],
    modelArgFlag: '--model',
    isHeadlessPrompt: true,
    approvedModels: APPROVED_ANTIGRAVITY_MODELS,
    defaultModel: DEFAULT_ANTIGRAVITY_MODEL,
    description: 'Alias for Antigravity CLI headless interface: agy -p "<prompt>" --model <slug>',
  },
] as const;

/** The default launcher adapter name. */
export const DEFAULT_LAUNCHER_NAME = 'ori-claude';

/** Patterns indicating billing, quota, or rate limit failures that require immediate STOP. */
export const QUOTA_ERROR_PATTERNS: readonly RegExp[] = [
  /credit balance is too low/i,
  /insufficient credit/i,
  /free quota exhausted/i,
  /quota exceeded/i,
  /exceeded your current quota/i,
  /rate limit exceeded/i,
  /429 Too Many Requests/i,
  /HTTP 429/i,
  /402 Payment Required/i,
  /payment required/i,
  /out of credits/i,
  /billing/i,
  /overage/i,
  /account.*suspended/i,
];

/** Patterns for actions strictly reserved for humans — any match causes STOP. */
export const HUMAN_ONLY_ACTION_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /wrangler\s+queues\s+create/i, reason: 'Cloudflare Queue creation requires human owner' },
  { pattern: /wrangler\s+d1\s+create/i, reason: 'Cloudflare D1 database creation requires human owner' },
  { pattern: /wrangler\s+r2\s+bucket\s+create/i, reason: 'Cloudflare R2 bucket creation requires human owner' },
  { pattern: /wrangler\s+deploy/i, reason: 'Production deployment requires human owner approval' },
  { pattern: /wrangler\s+secret\s+put/i, reason: 'Cloudflare secret management requires human owner' },
  { pattern: /(?:configure|update|modify|change)\s+(?:dns|domain)|(?:dns|domain)\s+(?:record|configuration)/i, reason: 'DNS and domain management requires human owner' },
  { pattern: /MAX_ALLOWED_COST\s*=\s*[1-9]/i, reason: 'Modifying MAX_ALLOWED_COST zero-cost constitution requires human approval' },
  { pattern: /ALLOW_PAID_API\s*=\s*true/i, reason: 'Modifying ALLOW_PAID_API zero-cost constitution requires human approval' },
  { pattern: /(?:automate|execute)\s+marketplace\s+(?:upload|submission)/i, reason: 'Marketplace automation requires explicit human verification' },
];

/** Secret detection patterns for sanitizing audit logs. */
export const SECRET_MASK_PATTERNS: readonly RegExp[] = [
  /(sk-[a-zA-Z0-9_-]{20,})/g,
  /(Bearer\s+)[a-zA-Z0-9_.-]{20,}/gi,
  /(ghp_[a-zA-Z0-9]{20,})/g,
  /(github_pat_[a-zA-Z0-9_]{20,})/g,
  /(AIza[0-9A-Za-z-_]{35})/g,
  /(token|password|secret|api[_-]?key)\s*[:=]\s*['"][^'"]+['"]/gi,
];
