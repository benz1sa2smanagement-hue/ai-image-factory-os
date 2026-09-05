/**
 * AI Bridge Constants & Guardrails
 */
import type { LauncherAdapter } from './types.ts';

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

/** Default remote git configuration */
export const DEFAULT_REMOTE_NAME = 'origin';
export const DEFAULT_REMOTE_BRANCH = 'main';

/** Default poll interval for watch mode (30 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * EXPLICIT allowlist of approved free-tier OpenRouter model IDs.
 * DO NOT replace with suffix-based matching (':free').
 * Any model not on this exact list is BLOCKED.
 * To add a model, add it here and commit the change for human review.
 */
export const APPROVED_FREE_MODELS: readonly string[] = [
  'nvidia/nemotron-3.5-lightning:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-coder-32b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'google/gemini-2.0-flash-thinking-exp:free',
  'deepseek/deepseek-r1:free',
  'deepseek/deepseek-chat:free',
];

/**
 * Default free model to use when none is specified.
 * Must be in APPROVED_FREE_MODELS.
 */
export const DEFAULT_FREE_MODEL = 'nvidia/nemotron-3.5-lightning:free';

/**
 * Explicit allowlist of approved launcher adapters.
 * Each entry maps a name to an exact binary + prefix-args pair.
 * To add a new launcher, add it here. DO NOT accept arbitrary binary names.
 *
 * IMPORTANT:
 * - Antigravity headless adapter uses the officially supported interface:
 *     agy -p "<prompt>"
 * - Do NOT invent or assume unsupported `agy run` semantics.
 * - Do NOT connect or transfer Antigravity credentials into Claude Code.
 * - Do NOT implement unsafe third-party credential bypasses.
 */
export const LAUNCHER_ADAPTERS: readonly LauncherAdapter[] = [
  {
    name: 'ori-claude',
    binary: 'ori',
    prefixArgs: ['claude'],
    description: 'Existing ori claude developer wrapper',
  },
  {
    name: 'claude-direct',
    binary: 'claude',
    prefixArgs: [],
    description: 'Direct Claude Code CLI',
  },
  {
    name: 'antigravity',
    binary: 'agy',
    prefixArgs: ['-p'],
    isHeadlessPrompt: true,
    description: 'Officially supported Antigravity CLI headless interface (agy -p "<prompt>")',
  },
  {
    name: 'agy',
    binary: 'agy',
    prefixArgs: ['-p'],
    isHeadlessPrompt: true,
    description: 'Alias for Antigravity CLI headless interface (agy -p "<prompt>")',
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
