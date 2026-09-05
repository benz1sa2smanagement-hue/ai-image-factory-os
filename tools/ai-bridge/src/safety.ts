import {
  ALLOWED_REPOSITORIES,
  ALLOWED_BRANCHES,
  APPROVED_FREE_MODELS,
  FREE_MODEL_SUFFIX,
  QUOTA_ERROR_PATTERNS,
  HUMAN_ONLY_ACTION_PATTERNS,
} from './constants.ts';
import type { SafetyCheckResult } from './types.ts';

/**
 * Normalizes a git remote URL into an owner/repo slug.
 * Handles:
 * - git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git
 * - https://github.com/benz1sa2smanagement-hue/ai-image-factory-os.git
 * - https://github.com/benz1sa2smanagement-hue/ai-image-factory-os
 * - benz1sa2smanagement-hue/ai-image-factory-os
 */
export function normalizeGitRepoSlug(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const withoutGit = trimmed.replace(/\.git$/i, '');
  const match = withoutGit.match(/(?:github\.com[:/]|git@github\.com:)([^/]+\/[^/\s]+)$/i);
  if (match) {
    return match[1];
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(withoutGit)) {
    return withoutGit;
  }
  return trimmed;
}

/**
 * Verifies that the git remote repository is in the allowlist.
 */
export function validateRepository(remoteUrl: string): SafetyCheckResult {
  const slug = normalizeGitRepoSlug(remoteUrl);
  const isAllowed = (ALLOWED_REPOSITORIES as readonly string[]).includes(slug);
  if (!isAllowed) {
    return {
      allowed: false,
      reason: `Repository "${slug}" is not in allowlist: ${ALLOWED_REPOSITORIES.join(', ')}`,
      code: 'REPO_NOT_ALLOWED',
    };
  }
  return { allowed: true };
}

/**
 * Verifies that the git branch is in the allowlist.
 */
export function validateBranch(branch: string): SafetyCheckResult {
  const trimmed = branch.trim();
  const isAllowed = (ALLOWED_BRANCHES as readonly string[]).includes(trimmed);
  if (!isAllowed) {
    return {
      allowed: false,
      reason: `Branch "${trimmed}" is not in allowlist: ${ALLOWED_BRANCHES.join(', ')}`,
      code: 'BRANCH_NOT_ALLOWED',
    };
  }
  return { allowed: true };
}

/**
 * Validates if an AI model name conforms to the free-only guardrail.
 */
export function isFreeModel(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  if (normalized.endsWith(FREE_MODEL_SUFFIX)) {
    return true;
  }
  return (APPROVED_FREE_MODELS as readonly string[]).some(
    (m) => m.toLowerCase() === normalized
  );
}

/**
 * Enforces free-only execution at the bridge layer.
 * Any paid model or missing :free designation triggers a stop.
 */
export function validateModel(modelName: string): SafetyCheckResult {
  if (!modelName || !isFreeModel(modelName)) {
    return {
      allowed: false,
      reason: `Model "${modelName}" is not an approved free-tier model. Paid models and paid fallbacks are prohibited by MAX_ALLOWED_COST=0.`,
      code: 'PAID_MODEL_BLOCKED',
    };
  }
  return { allowed: true };
}

/**
 * Detects quota, billing, or rate-limit exhaustion strings in process output.
 */
export function detectQuotaOrBillingError(output: string): SafetyCheckResult {
  for (const pattern of QUOTA_ERROR_PATTERNS) {
    if (pattern.test(output)) {
      if (/rate\s*limit/i.test(output)) {
        return {
          allowed: false,
          reason: `Rate limit detected in output matching "${pattern}". Execution halted to prevent hammering.`,
          code: 'RATE_LIMIT_EXCEEDED',
        };
      }
      return {
        allowed: false,
        reason: `Free quota or billing error detected matching "${pattern}". Immediate STOP required (never add credits or fallback to paid).`,
        code: 'FREE_QUOTA_EXHAUSTED',
      };
    }
  }
  return { allowed: true };
}

/**
 * Detects if a command, objective, or instruction contains human-only reserved actions.
 */
export function detectHumanOnlyAction(text: string): SafetyCheckResult {
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    // Skip policy negation / guardrail descriptions (e.g., "Human-only actions must STOP: ...", "No Cloudflare ...")
    if (/^(?:no\s+|do\s+not\s+|never\s+|human-only.*(?:stop|must))/i.test(line)) {
      continue;
    }
    for (const { pattern, reason } of HUMAN_ONLY_ACTION_PATTERNS) {
      if (pattern.test(line)) {
        return {
          allowed: false,
          reason: `Human-only action blocked: ${reason}`,
          code: 'HUMAN_ONLY_ACTION',
        };
      }
    }
  }
  return { allowed: true };
}
