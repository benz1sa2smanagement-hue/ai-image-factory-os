import { describe, it, expect } from 'vitest';
import {
  normalizeGitRepoSlug,
  validateRepository,
  validateBranch,
  validateModel,
  resolveLauncherAdapter,
  validateProviderAndModel,
  detectQuotaOrBillingError,
  detectHumanOnlyAction,
} from '../src/safety.ts';
import { APPROVED_FREE_MODELS } from '../src/constants.ts';

describe('safety module', () => {
  describe('repository allowlist', () => {
    it('normalizes various git remote formats', () => {
      expect(normalizeGitRepoSlug('git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git'))
        .toBe('benz1sa2smanagement-hue/ai-image-factory-os');
      expect(normalizeGitRepoSlug('https://github.com/benz1sa2smanagement-hue/ai-image-factory-os.git'))
        .toBe('benz1sa2smanagement-hue/ai-image-factory-os');
      expect(normalizeGitRepoSlug('https://github.com/benz1sa2smanagement-hue/ai-image-factory-os'))
        .toBe('benz1sa2smanagement-hue/ai-image-factory-os');
      expect(normalizeGitRepoSlug('benz1sa2smanagement-hue/ai-image-factory-os'))
        .toBe('benz1sa2smanagement-hue/ai-image-factory-os');
    });

    it('allows approved repository', () => {
      expect(validateRepository('git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git').allowed).toBe(true);
    });

    it('rejects unapproved repository', () => {
      const res = validateRepository('git@github.com:attacker/malicious-repo.git');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('REPO_NOT_ALLOWED');
    });
  });

  describe('branch allowlist', () => {
    it('allows main branch', () => {
      expect(validateBranch('main').allowed).toBe(true);
    });

    it('rejects non-main branch', () => {
      const res = validateBranch('feature/unauthorized');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('BRANCH_NOT_ALLOWED');
    });
  });

  describe('strict explicit free-model allowlist', () => {
    it('approves all models in APPROVED_FREE_MODELS', () => {
      for (const model of APPROVED_FREE_MODELS) {
        expect(validateModel(model).allowed).toBe(true);
      }
    });

    it('rejects models not in the explicit allowlist even with :free suffix', () => {
      // This is the key hardening: suffix alone is no longer sufficient
      const newFreeModel = 'some-new-org/some-model:free';
      const res = validateModel(newFreeModel);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('PAID_MODEL_BLOCKED');
    });

    it('rejects paid models', () => {
      const paidModels = [
        'anthropic/claude-3-5-sonnet',
        'openai/gpt-4o',
        'anthropic/claude-3-opus',
        'google/gemini-1.5-pro',
        'gpt-4',
      ];
      for (const m of paidModels) {
        const res = validateModel(m);
        expect(res.allowed).toBe(false);
        expect(res.code).toBe('PAID_MODEL_BLOCKED');
      }
    });

    it('rejects empty model name', () => {
      expect(validateModel('').allowed).toBe(false);
    });

    it('allows model via custom allowlist override', () => {
      const customList = ['custom/test-model:free'];
      expect(validateModel('custom/test-model:free', customList).allowed).toBe(true);
      // But with default allowlist it is blocked
      expect(validateModel('custom/test-model:free').allowed).toBe(false);
    });
  });

  describe('launcher adapter allowlist', () => {
    it('resolves ori-claude adapter', () => {
      const result = resolveLauncherAdapter('ori-claude');
      expect(result.adapter).toBeDefined();
      expect(result.adapter?.binary).toBe('ori');
      expect(result.adapter?.prefixArgs).toEqual(['claude']);
    });

    it('resolves claude-direct adapter', () => {
      const result = resolveLauncherAdapter('claude-direct');
      expect(result.adapter).toBeDefined();
      expect(result.adapter?.binary).toBe('claude');
    });

    it('resolves antigravity adapter to official agy -p headless interface', () => {
      const result = resolveLauncherAdapter('antigravity');
      expect(result.adapter).toBeDefined();
      expect(result.adapter?.binary).toBe('agy');
      expect(result.adapter?.prefixArgs).toEqual(['-p']);
      expect(result.adapter?.isHeadlessPrompt).toBe(true);
    });

    it('resolves agy alias adapter to agy -p', () => {
      const result = resolveLauncherAdapter('agy');
      expect(result.adapter).toBeDefined();
      expect(result.adapter?.binary).toBe('agy');
      expect(result.adapter?.prefixArgs).toEqual(['-p']);
      expect(result.adapter?.isHeadlessPrompt).toBe(true);
    });

    it('rejects unsupported or guessed launcher variants such as antigravity-run', () => {
      const result = resolveLauncherAdapter('antigravity-run');
      expect(result.adapter).toBeUndefined();
      expect(result.code).toBe('LAUNCHER_NOT_ALLOWED');
    });

    it('rejects unsupported developer launcher', () => {
      const result = resolveLauncherAdapter('arbitrary-custom-launcher');
      expect(result.adapter).toBeUndefined();
      expect(result.code).toBe('LAUNCHER_NOT_ALLOWED');
      expect(result.error).toContain('not in the explicit adapter allowlist');
    });

    it('rejects arbitrary binary names', () => {
      for (const badLauncher of ['bash', 'python', 'curl', 'wget', '/usr/bin/sh']) {
        const result = resolveLauncherAdapter(badLauncher);
        expect(result.adapter).toBeUndefined();
        expect(result.code).toBe('LAUNCHER_NOT_ALLOWED');
      }
    });

    it('is case-insensitive for lookup', () => {
      expect(resolveLauncherAdapter('ORI-CLAUDE').adapter).toBeDefined();
      expect(resolveLauncherAdapter('Ori-Claude').adapter).toBeDefined();
    });
  });

  describe('provider and model contract validation', () => {
    it('resolves Antigravity with default approved model (gemini-2.0-flash) and subscription_entitlement', () => {
      const res = validateProviderAndModel('antigravity');
      expect(res.allowed).toBe(true);
      expect(res.provider).toBe('antigravity');
      expect(res.model).toBe('gemini-2.0-flash');
      expect(res.costPolicy).toBe('subscription_entitlement');
    });

    it('resolves Antigravity with explicit approved model (gemini-2.5-pro)', () => {
      const res = validateProviderAndModel('antigravity', 'gemini-2.5-pro');
      expect(res.allowed).toBe(true);
      expect(res.model).toBe('gemini-2.5-pro');
    });

    it('rejects OpenRouter model passed to Antigravity (MODEL_PROVIDER_MISMATCH)', () => {
      const res = validateProviderAndModel('antigravity', 'nvidia/nemotron-3.5-lightning:free');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('MODEL_PROVIDER_MISMATCH');
      expect(res.reason).toContain('OpenRouter model');
      expect(res.reason).toContain('antigravity');
    });

    it('rejects arbitrary :free suffix model passed to Antigravity', () => {
      const res = validateProviderAndModel('antigravity', 'meta-llama/llama-3.3-70b-instruct:free');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('MODEL_PROVIDER_MISMATCH');
    });

    it('rejects Antigravity model passed to OpenRouter (MODEL_PROVIDER_MISMATCH)', () => {
      const res = validateProviderAndModel('ori-claude', 'gemini-2.5-pro');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('MODEL_PROVIDER_MISMATCH');
      expect(res.reason).toContain('Antigravity model');
      expect(res.reason).toContain('openrouter');
    });

    it('rejects unapproved Antigravity model (PAID_MODEL_BLOCKED)', () => {
      const res = validateProviderAndModel('antigravity', 'gemini-ultra-unapproved');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('PAID_MODEL_BLOCKED');
      expect(res.reason).toContain('not in the approved allowlist');
    });

    it('rejects unapproved provider if provider allowlist does not include it', () => {
      const res = validateProviderAndModel('antigravity', 'gemini-2.0-flash', ['openrouter']);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('PROVIDER_NOT_ALLOWED');
    });

    it('resolves ori-claude with default OpenRouter free model', () => {
      const res = validateProviderAndModel('ori-claude');
      expect(res.allowed).toBe(true);
      expect(res.provider).toBe('openrouter');
      expect(res.model).toBe('nvidia/nemotron-3.5-lightning:free');
      expect(res.costPolicy).toBe('free-tier');
    });
  });

  describe('quota and billing failure detection', () => {
    it('detects credit balance too low', () => {
      const res = detectQuotaOrBillingError('Error 402: credit balance is too low');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('FREE_QUOTA_EXHAUSTED');
    });

    it('detects HTTP 429 rate limit', () => {
      const res = detectQuotaOrBillingError('HTTP 429 Too Many Requests');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('detects free quota exhausted phrase', () => {
      const res = detectQuotaOrBillingError('Service: free quota exhausted for today');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('FREE_QUOTA_EXHAUSTED');
    });

    it('detects rate limit exceeded phrase', () => {
      const res = detectQuotaOrBillingError('rate limit exceeded on model endpoint');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('passes normal output without errors', () => {
      expect(detectQuotaOrBillingError('Task completed successfully. 107 tests passed.').allowed).toBe(true);
    });
  });

  describe('human-only action detection', () => {
    it('blocks Cloudflare queue creation commands', () => {
      const res = detectHumanOnlyAction('Execute wrangler queues create aif-factory');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('HUMAN_ONLY_ACTION');
    });

    it('blocks production deployment', () => {
      const res = detectHumanOnlyAction('Run wrangler deploy');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('HUMAN_ONLY_ACTION');
    });

    it('blocks MAX_ALLOWED_COST modification', () => {
      const res = detectHumanOnlyAction('Set MAX_ALLOWED_COST = 5');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('HUMAN_ONLY_ACTION');
    });

    it('does not block policy negation lines', () => {
      const policyDoc = `
No Cloudflare provisioning.
No production deployment.
Human-only actions must STOP: credentials/secrets, Cloudflare resource creation.
Do not run wrangler deploy.
`;
      const res = detectHumanOnlyAction(policyDoc);
      expect(res.allowed).toBe(true);
    });
  });
});
