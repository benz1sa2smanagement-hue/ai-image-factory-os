import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ALLOWED_REPOSITORIES,
  ALLOWED_BRANCHES,
  APPROVED_OPENROUTER_FREE_MODELS,
  APPROVED_ANTIGRAVITY_MODELS,
  APPROVED_PROVIDERS,
  QUOTA_ERROR_PATTERNS,
  HUMAN_ONLY_ACTION_PATTERNS,
  LAUNCHER_ADAPTERS,
  DEFAULT_OPERATOR_ZERO_OVERAGE_FILE,
  DEFAULT_ANTIGRAVITY_SETTINGS_FILE,
} from './constants.ts';
import type {
  SafetyCheckResult,
  LauncherAdapter,
  ProviderType,
  CostPolicy,
  ZeroOverageVerificationState,
  CreditFallbackState,
  SafetyErrorCode,
} from './types.ts';

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
 * Determines whether a given file path is located inside the repository workspace directory.
 * Used to enforce trust boundaries: human operator verifications MUST reside outside the workspace
 * so that autonomous agents inside the workspace cannot self-authorize.
 */
export function isPathInsideWorkspace(targetPath: string, workspaceDir: string): boolean {
  if (!workspaceDir || !targetPath) return false;
  const resolvedTarget = path.resolve(workspaceDir, targetPath);
  const resolvedWorkspace = path.resolve(workspaceDir);
  const rel = path.relative(resolvedWorkspace, resolvedTarget);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Checks Antigravity AI Credit Overages / useG1Credits setting.
 *
 * Rules:
 * - If useG1Credits === true or aiCreditOverages === 'always': BLOCKED with ANTIGRAVITY_CREDIT_FALLBACK_ENABLED.
 * - If useG1Credits === false or aiCreditOverages === 'never': DISABLED (safe).
 * - If missing or cannot be read: UNKNOWN (requires external human verification to proceed).
 */
export function checkCreditFallbackSetting(options: {
  settingsPath?: string;
  configContent?: string;
}): {
  allowed: boolean;
  fallbackState: CreditFallbackState;
  code?: SafetyErrorCode;
  reason?: string;
} {
  let content = options.configContent;
  if (content === undefined && options.settingsPath) {
    try {
      if (fs.existsSync(options.settingsPath)) {
        content = fs.readFileSync(options.settingsPath, 'utf-8');
      }
    } catch {
      // Ignore read errors
    }
  }

  if (content !== undefined && content.trim() !== '') {
    try {
      const parsed = JSON.parse(content);
      const useG1Credits = parsed.useG1Credits ?? parsed.g1Credits ?? parsed.creditFallback;
      const aiCreditOverages = parsed.aiCreditOverages ?? parsed.overages;

      if (
        useG1Credits === true ||
        aiCreditOverages === 'always' ||
        aiCreditOverages === true ||
        parsed.allowPaidFallback === true
      ) {
        return {
          allowed: false,
          fallbackState: 'ENABLED',
          code: 'ANTIGRAVITY_CREDIT_FALLBACK_ENABLED',
          reason:
            'Antigravity execution blocked: AI Credit Overages / useG1Credits is ENABLED. Automatic credit fallback violates MAX_ALLOWED_COST=0 and ALLOW_PAID_API=false.',
        };
      }

      if (
        useG1Credits === false ||
        aiCreditOverages === 'never' ||
        aiCreditOverages === false ||
        parsed.allowPaidFallback === false
      ) {
        return {
          allowed: true,
          fallbackState: 'DISABLED',
        };
      }
    } catch {
      // Fallback to text matching if JSON parse fails
      if (/["']?useG1Credits["']?\s*:\s*true/i.test(content) || /["']?aiCreditOverages["']?\s*:\s*["']always["']/i.test(content)) {
        return {
          allowed: false,
          fallbackState: 'ENABLED',
          code: 'ANTIGRAVITY_CREDIT_FALLBACK_ENABLED',
          reason:
            'Antigravity execution blocked: AI Credit Overages / useG1Credits is ENABLED. Automatic credit fallback violates MAX_ALLOWED_COST=0 and ALLOW_PAID_API=false.',
        };
      }
      if (/["']?useG1Credits["']?\s*:\s*false/i.test(content) || /["']?aiCreditOverages["']?\s*:\s*["']never["']/i.test(content)) {
        return {
          allowed: true,
          fallbackState: 'DISABLED',
        };
      }
    }
  }

  return {
    allowed: true,
    fallbackState: 'UNKNOWN',
  };
}

/**
 * Verifies the human-confirmed AI Credit Overages policy for Antigravity:
 *
 * Requirements:
 * - Proof MUST reside outside the repository workspace to maintain the trust boundary.
 * - Files located inside the workspace are rejected as self-authorization (SELF_AUTHORIZATION_BLOCKED).
 * - CLI flags cannot self-authorize if external file is missing.
 * - Must be valid JSON containing status: "HUMAN_VERIFIED" confirming "AI Credit Overages = Never".
 * - Missing or unverified state BLOCKS execution with ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED.
 */
export function checkZeroOverageVerification(options: {
  filePath?: string;
  workspaceDir?: string;
}): {
  verified: boolean;
  state: ZeroOverageVerificationState;
  reason?: string;
  code?: SafetyErrorCode;
} {
  const targetPath = options.filePath || DEFAULT_OPERATOR_ZERO_OVERAGE_FILE;
  const workspace = options.workspaceDir || process.cwd();

  // 1. TRUST BOUNDARY: Enforce that verification file MUST NOT reside inside repository workspace.
  // Files inside workspace are rejected as self-authorization.
  if (isPathInsideWorkspace(targetPath, workspace)) {
    return {
      verified: false,
      state: 'UNVERIFIED',
      code: 'SELF_AUTHORIZATION_BLOCKED',
      reason: `Self-authorization blocked: zero-overage verification file cannot reside inside repository workspace (${targetPath}). Human operator must maintain verification file outside the workspace at ${DEFAULT_OPERATOR_ZERO_OVERAGE_FILE}.`,
    };
  }

  // 2. Read operator verification file
  try {
    if (fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, 'utf-8').trim();
      if (!content) {
        return {
          verified: false,
          state: 'UNVERIFIED',
          code: 'ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED',
          reason: `Verification file at ${targetPath} is empty.`,
        };
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content);
      } catch {
        return {
          verified: false,
          state: 'UNVERIFIED',
          code: 'ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED',
          reason: `Verification file at ${targetPath} is not valid JSON.`,
        };
      }

      // Both status === 'HUMAN_VERIFIED' and policy confirming 'AI Credit Overages = Never' are REQUIRED
      const hasHumanVerifiedStatus = parsed && parsed.status === 'HUMAN_VERIFIED';
      const policyValue = typeof parsed?.policy === 'string' ? parsed.policy.trim() : '';
      const hasNeverOveragePolicy = policyValue.toLowerCase() === 'ai credit overages = never';

      if (hasHumanVerifiedStatus && hasNeverOveragePolicy) {
        return { verified: true, state: 'HUMAN_VERIFIED' };
      }

      if (hasHumanVerifiedStatus && !hasNeverOveragePolicy) {
        return {
          verified: false,
          state: 'UNVERIFIED',
          code: 'ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED',
          reason: `Antigravity execution blocked: verification file at ${targetPath} has status HUMAN_VERIFIED but missing or invalid zero-overage policy ("${policyValue}"). Must confirm "policy": "AI Credit Overages = Never".`,
        };
      }
    }
  } catch {
    // Read errors fall through to unverified
  }

  return {
    verified: false,
    state: 'UNVERIFIED',
    code: 'ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED',
    reason:
      `Antigravity execution blocked: AI Credit Overages setting is UNVERIFIED. Google AI Pro baseline quota can incur overage charges unless "AI Credit Overages = Never" is confirmed by the human owner. Human operator must verify account settings and record status HUMAN_VERIFIED and policy "AI Credit Overages = Never" in ${targetPath}.`,
  };
}

/**
 * Validates the full Provider and Model Contract for a launcher:
 *
 * 1. Resolves launcher adapter
 * 2. Verifies provider is approved by project policy
 * 3. Enforces model/provider match (e.g. OpenRouter :free models CANNOT be used with Antigravity)
 * 4. Verifies model is in the adapter's approved allowlist
 * 5. Enforces zero-cost policy (free-tier or subscription_with_zero_overage)
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
      const isAntigravityModel =
        normalizedModel.startsWith('gemini-') ||
        (APPROVED_ANTIGRAVITY_MODELS as readonly string[]).some(
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

  // Reject any non-explicit adapter
  return {
    allowed: false,
    adapter,
    reason: `Launcher "${adapter.name}" model selection mode "${adapter.modelSelectionMode}" is not supported or verified as zero-cost. Only explicit zero-cost models are permitted.`,
    code: 'LAUNCHER_NOT_ALLOWED',
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
      if (/billing|credit\s*card|subscription\s*overdue/i.test(output)) {
        return {
          allowed: false,
          reason: `Billing error detected. Immediate STOP required.`,
          code: 'BILLING_ERROR',
        };
      }
      return {
        allowed: false,
        reason: `Free quota, billing, or overage error detected. Immediate STOP required (never add credits or fallback to paid).`,
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
