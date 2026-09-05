import { describe, it, expect } from 'vitest';
import {
  normalizeGitRepoSlug,
  validateRepository,
  validateBranch,
  isFreeModel,
  validateModel,
  detectQuotaOrBillingError,
  detectHumanOnlyAction,
} from '../src/safety.ts';

describe('safety module', () => {
  describe('repository allowlist', () => {
    it('normalizes various git remote formats', () => {
      expect(
        normalizeGitRepoSlug('git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git')
      ).toBe('benz1sa2smanagement-hue/ai-image-factory-os');

      expect(
        normalizeGitRepoSlug('https://github.com/benz1sa2smanagement-hue/ai-image-factory-os.git')
      ).toBe('benz1sa2smanagement-hue/ai-image-factory-os');

      expect(
        normalizeGitRepoSlug('https://github.com/benz1sa2smanagement-hue/ai-image-factory-os')
      ).toBe('benz1sa2smanagement-hue/ai-image-factory-os');

      expect(
        normalizeGitRepoSlug('benz1sa2smanagement-hue/ai-image-factory-os')
      ).toBe('benz1sa2smanagement-hue/ai-image-factory-os');
    });

    it('allows approved repository', () => {
      const res = validateRepository('git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git');
      expect(res.allowed).toBe(true);
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

  describe('free-only model validation', () => {
    it('approves models ending with :free', () => {
      expect(isFreeModel('any-org/any-model:free')).toBe(true);
      expect(validateModel('meta-llama/llama-3.3-70b-instruct:free').allowed).toBe(true);
    });

    it('approves models from approved free list', () => {
      expect(validateModel('nvidia/nemotron-3.5-lightning:free').allowed).toBe(true);
      expect(validateModel('qwen/qwen-2.5-coder-32b-instruct:free').allowed).toBe(true);
    });

    it('rejects paid models and models without free suffix', () => {
      const paidModels = [
        'anthropic/claude-3-5-sonnet',
        'openai/gpt-4o',
        'anthropic/claude-3-opus',
        'google/gemini-1.5-pro',
      ];
      for (const m of paidModels) {
        const res = validateModel(m);
        expect(res.allowed).toBe(false);
        expect(res.code).toBe('PAID_MODEL_BLOCKED');
      }
    });

    it('rejects empty or undefined model name', () => {
      expect(validateModel('').allowed).toBe(false);
    });
  });

  describe('quota and billing failure detection', () => {
    it('detects credit balance too low', () => {
      const res = detectQuotaOrBillingError('Error 402: credit balance is too low');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('FREE_QUOTA_EXHAUSTED');
    });

    it('detects insufficient credits', () => {
      const res = detectQuotaOrBillingError('Failed: insufficient credit on account');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('FREE_QUOTA_EXHAUSTED');
    });

    it('detects free quota exhaustion', () => {
      const res = detectQuotaOrBillingError('Service reported: free quota exhausted for today');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('FREE_QUOTA_EXHAUSTED');
    });

    it('detects rate limit exceeded', () => {
      const res = detectQuotaOrBillingError('HTTP 429: rate limit exceeded');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('passes normal output without errors', () => {
      const res = detectQuotaOrBillingError('Task completed successfully. 107 tests passed.');
      expect(res.allowed).toBe(true);
    });
  });

  describe('human-only action detection', () => {
    it('blocks Cloudflare queue creation commands', () => {
      const res = detectHumanOnlyAction('Execute wrangler queues create aif-factory');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('HUMAN_ONLY_ACTION');
    });

    it('blocks Cloudflare D1 database creation', () => {
      const res = detectHumanOnlyAction('Run wrangler d1 create aif-db');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('HUMAN_ONLY_ACTION');
    });

    it('blocks production deployment', () => {
      const res = detectHumanOnlyAction('Run wrangler deploy');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('HUMAN_ONLY_ACTION');
    });

    it('blocks modification of MAX_ALLOWED_COST', () => {
      const res = detectHumanOnlyAction('Set MAX_ALLOWED_COST = 5');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('HUMAN_ONLY_ACTION');
    });

    it('blocks DNS changes', () => {
      const res = detectHumanOnlyAction('Change dns records for imagefactory.com');
      expect(res.allowed).toBe(false);
      expect(res.code).toBe('HUMAN_ONLY_ACTION');
    });

    it('does not block policy negation lines', () => {
      const policyDoc = `
No Cloudflare provisioning.
No production deployment.
Human-only actions must STOP: credentials/secrets, Cloudflare resource creation.
`;
      const res = detectHumanOnlyAction(policyDoc);
      expect(res.allowed).toBe(true);
    });
  });
});
