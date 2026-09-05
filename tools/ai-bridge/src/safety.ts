import {
  ALLOWED_REPOSITORIES,
  ALLOWED_BRANCHES,
  APPROVED_FREE_MODELS,
  QUOTA_ERROR_PATTERNS,
  HUMAN_ONLY_ACTION_PATTERNS,
  LAUNCHER_ADAPTERS,
} from './constants.ts';
import type { SafetyCheckResult, LauncherAdapter } from './types.ts';

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
 * Validates model against the EXPLICIT allowlist.
 * Unlike the previous implementation, suffix ':free' alone is NOT sufficient.
 * The model name MUST appear exactly in APPROVED_FREE_MODELS.
 */
export function validateModel(
  modelName: string,
  allowlist: readonly string[] = APPROVED_FREE_MODELS
): SafetyCheckResult {
  const normalized = modelName.trim().toLowerCase();
  const isAllowed = allowlist.some((m) => m.toLowerCase() === normalized);
  if (!normalized || !isAllowed) {
    return {
      allowed: false,
      reason: `Model "${modelName}" is not in the explicit free-model allowlist. Paid models and unapproved models are prohibited (MAX_ALLOWED_COST=0). Add the model to APPROVED_FREE_MODELS for human review.`,
      code: 'PAID_MODEL_BLOCKED',
    };
  }
  return { allowed: true };
}

/**
 * Resolves a launcher adapter by name from the explicit LAUNCHER_ADAPTERS allowlist.
 * Rejects any launcher name not in the allowlist.
 */
export function resolveLauncherAdapter(launcherName: string): {
  adapter?: LauncherAdapter;
  error?: string;
  code?: 'LAUNCHER_NOT_ALLOWED';
} {
  const normalized = launcherName.trim().toLowerCase();
  const found = LAUNCHER_ADAPTERS.find((a) => a.name.toLowerCase() === normalized);
  if (!found) {
    return {
      error: `Launcher "${launcherName}" is not in the explicit adapter allowlist. Allowed launchers: ${LAUNCHER_ADAPTERS.map((a) => a.name).join(', ')}`,
      code: 'LAUNCHER_NOT_ALLOWED',
    };
  }
  return { adapter: found };
}

/**
 * Detects quota, billing, or rate-limit exhaustion strings in process output.
 */
export function detectQuotaOrBillingError(output: string): SafetyCheckResult {
  for (const pattern of QUOTA_ERROR_PATTERNS) {
    if (pattern.test(output)) {
      if (/rate\s*limit|429/i.test(output)) {
        return {
          allowed: false,
          reason: `Rate limit or HTTP 429 detected. Execution halted (never retry with paid fallback).`,
          code: 'RATE_LIMIT_EXCEEDED',
        };
      }
      return {
        allowed: false,
        reason: `Free quota or billing error detected. Immediate STOP required (never add credits or fallback to paid).`,
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
    // Skip policy negation / guardrail descriptions
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
