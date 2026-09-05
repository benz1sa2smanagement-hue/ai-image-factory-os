import {
  ALLOWED_REPOSITORIES,
  ALLOWED_BRANCHES,
  APPROVED_OPENROUTER_FREE_MODELS,
  APPROVED_ANTIGRAVITY_MODELS,
  APPROVED_PROVIDERS,
  QUOTA_ERROR_PATTERNS,
  HUMAN_ONLY_ACTION_PATTERNS,
  LAUNCHER_ADAPTERS,
} from './constants.ts';
import type { SafetyCheckResult, LauncherAdapter, ProviderType, CostPolicy } from './types.ts';

/**
 * Normalizes a git remote URL into an owner/repo slug.
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
 * Validates a model against the OpenRouter free allowlist (legacy/direct helper).
 */
export function validateModel(
  modelName: string,
  allowlist: readonly string[] = APPROVED_OPENROUTER_FREE_MODELS
): SafetyCheckResult {
  const normalized = modelName.trim().toLowerCase();
  const isAllowed = allowlist.some((m) => m.toLowerCase() === normalized);
  if (!normalized || !isAllowed) {
    return {
      allowed: false,
      reason: `Model "${modelName}" is not in the explicit free-model allowlist. Paid models and unapproved models are prohibited (MAX_ALLOWED_COST=0).`,
      code: 'PAID_MODEL_BLOCKED',
    };
  }
  return { allowed: true };
}

/**
 * Validates the full Provider and Model Contract for a launcher:
 *
 * 1. Resolves launcher adapter
 * 2. Verifies provider is approved by project policy
 * 3. Enforces model/provider match (e.g. OpenRouter :free models CANNOT be used with Antigravity)
 * 4. Verifies model is in the adapter's approved allowlist
 * 5. Verifies zero-cost policy (free-tier or subscription_entitlement)
 */
export function validateProviderAndModel(
  launcherName: string,
  requestedModel?: string,
  allowedProviders: readonly ProviderType[] = APPROVED_PROVIDERS
): {
  allowed: boolean;
  adapter?: LauncherAdapter;
  model?: string;
  provider?: ProviderType;
  costPolicy?: CostPolicy;
  reason?: string;
  code?: 'LAUNCHER_NOT_ALLOWED' | 'PROVIDER_NOT_ALLOWED' | 'MODEL_PROVIDER_MISMATCH' | 'PAID_MODEL_BLOCKED';
} {
  // 1. Resolve launcher adapter
  const resolution = resolveLauncherAdapter(launcherName);
  if (!resolution.adapter) {
    return {
      allowed: false,
      reason: resolution.error,
      code: resolution.code,
    };
  }

  const adapter = resolution.adapter;

  // 2. Verify provider is permitted under repository policy
  if (!allowedProviders.includes(adapter.provider)) {
    return {
      allowed: false,
      adapter,
      reason: `Provider "${adapter.provider}" is not permitted under project policy. Approved providers: ${allowedProviders.join(', ')}`,
      code: 'PROVIDER_NOT_ALLOWED',
    };
  }

  // 3. Determine active model
  const activeModel = (requestedModel && requestedModel.trim()) || adapter.defaultModel;

  if (adapter.modelSelectionMode === 'explicit') {
    if (!activeModel) {
      return {
        allowed: false,
        adapter,
        reason: `Launcher "${adapter.name}" requires an explicit model selection, but none was provided and no default exists.`,
        code: 'PAID_MODEL_BLOCKED',
      };
    }

    const normalizedModel = activeModel.trim().toLowerCase();

    // Check cross-provider mismatches:
    // Antigravity adapter given an OpenRouter model:
    if (adapter.provider === 'antigravity') {
      const isOpenRouterModel =
        normalizedModel.endsWith(':free') ||
        (APPROVED_OPENROUTER_FREE_MODELS as readonly string[]).some((m) => m.toLowerCase() === normalizedModel) ||
        normalizedModel.includes('/');

      if (isOpenRouterModel) {
        return {
          allowed: false,
          adapter,
          model: activeModel,
          reason: `Model/provider mismatch: model "${activeModel}" is an OpenRouter model, but launcher "${adapter.name}" uses provider "antigravity". Antigravity requires an approved Antigravity model slug (${adapter.approvedModels.join(', ')}). Never claim OpenRouter models were used by Antigravity.`,
          code: 'MODEL_PROVIDER_MISMATCH',
        };
      }
    }

    // OpenRouter adapter given an Antigravity model:
    if (adapter.provider === 'openrouter') {
      const isAntigravityModel = (APPROVED_ANTIGRAVITY_MODELS as readonly string[]).some(
        (m) => m.toLowerCase() === normalizedModel
      );
      if (isAntigravityModel) {
        return {
          allowed: false,
          adapter,
          model: activeModel,
          reason: `Model/provider mismatch: model "${activeModel}" is an Antigravity model, but launcher "${adapter.name}" uses provider "openrouter". OpenRouter requires an approved free model (${adapter.approvedModels.join(', ')}).`,
          code: 'MODEL_PROVIDER_MISMATCH',
        };
      }
    }

    // Verify model is in the adapter's approved allowlist
    const isApproved = adapter.approvedModels.some((m) => m.toLowerCase() === normalizedModel);
    if (!isApproved) {
      return {
        allowed: false,
        adapter,
        model: activeModel,
        reason: `Model "${activeModel}" is not in the approved allowlist for provider "${adapter.provider}". Prohibited by MAX_ALLOWED_COST=0. Approved models: ${adapter.approvedModels.join(', ')}`,
        code: 'PAID_MODEL_BLOCKED',
      };
    }

    return {
      allowed: true,
      adapter,
      model: activeModel,
      provider: adapter.provider,
      costPolicy: adapter.costPolicy,
    };
  }

  // Provider-controlled session (e.g. claude-direct)
  return {
    allowed: true,
    adapter,
    model: activeModel || 'provider-session',
    provider: adapter.provider,
    costPolicy: adapter.costPolicy,
  };
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
