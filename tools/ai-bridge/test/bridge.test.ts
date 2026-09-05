import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AIBridge, constructTaskPrompt, buildLauncherArgs } from '../src/bridge.ts';
import { triggerKillSwitch, clearKillSwitch } from '../src/kill-switch.ts';
import { readAuditLogs } from '../src/audit-logger.ts';
import { acquireLock, releaseLock } from '../src/lock.ts';
import { detectQuotaOrBillingError } from '../src/safety.ts';
import type { GitContext, GitSyncResult } from '../src/git-utils.ts';
import type { TaskDefinition } from '../src/types.ts';

describe('AIBridge engine', () => {
  const tempDir = path.resolve(process.cwd(), 'scratch-bridge-test-rework3');
  const tempTaskFile = path.resolve(tempDir, 'AI_TASK.md');
  const tempAuditFile = path.resolve(tempDir, 'AUDIT.log');
  const tempKillFile = path.resolve(tempDir, '.bridge-stop');
  const tempLockFile = path.resolve(tempDir, '.bridge-lock');

  const mockGitContext: GitContext = {
    remoteUrl: 'git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git',
    branch: 'main',
    commitSha: '2c98a0e8b955a3f3a60fdd44c49cfef5e726812b',
    isClean: true,
    uncommittedFiles: [],
  };

  const sampleTaskDoc = `
# AI TASK — ChatGPT → Claude Code

## Current Task

**TASK ID:** TASK-002
**STATUS:** READY
**TITLE:** Build Phase B Local Bridge
**SOURCE:** GitHub Issue #6

### Objective
Implement Phase B isolated bridge.

### Required work
1. Write code.
2. Run tests.

### Hard constraints
- MAX_ALLOWED_COST = 0
- ALLOW_PAID_API = false
`;

  function makeBridge(overrides: Partial<ConstructorParameters<typeof AIBridge>[0]> = {}): AIBridge {
    return new AIBridge({
      gitContextResolver: async () => mockGitContext,
      testRunner: async () => ({ ok: true, output: 'All tests passed' }),
      agyInterfaceVerifier: async () => ({ ok: true }),
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: false,
        syncRemote: false,
      },
      ...overrides,
    });
  }

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(tempTaskFile, sampleTaskDoc, 'utf-8');
    try { await fs.unlink(tempKillFile); } catch { /* ok */ }
    try { await fs.unlink(tempLockFile); } catch { /* ok */ }
    try { await fs.unlink(tempAuditFile); } catch { /* ok */ }
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ─── Core safety gates ────────────────────────────────────────────────

  it('passes preconditions for valid configuration', async () => {
    const bridge = makeBridge();
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(true);
    expect(pre.task?.id).toBe('TASK-002');
  });

  it('stops immediately if kill switch is active', async () => {
    await triggerKillSwitch(tempKillFile, 'Operator stop request');
    const bridge = makeBridge();
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('KILL_SWITCH_ACTIVE');
  });

  it('rejects unauthorized git repository', async () => {
    const bridge = makeBridge({
      gitContextResolver: async () => ({ ...mockGitContext, remoteUrl: 'git@github.com:other-user/other-repo.git' }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('REPO_NOT_ALLOWED');
  });

  it('rejects non-main branch', async () => {
    const bridge = makeBridge({
      gitContextResolver: async () => ({ ...mockGitContext, branch: 'feature/unapproved' }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('BRANCH_NOT_ALLOWED');
  });

  it('rejects paid model', async () => {
    const bridge = makeBridge({ model: 'anthropic/claude-3-5-sonnet' });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('PAID_MODEL_BLOCKED');
  });

  it('rejects arbitrary :free suffix model not in explicit allowlist', async () => {
    const bridge = makeBridge({ model: 'unknown-org/brand-new-model:free' });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('PAID_MODEL_BLOCKED');
  });

  it('rejects unsupported developer launcher', async () => {
    const bridge = makeBridge({
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'arbitrary-launcher',
        syncRemote: false,
      },
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('LAUNCHER_NOT_ALLOWED');
  });

  // ─── Antigravity launcher allowlist & interface verification ───────────

  it('accepts allowlisted antigravity launcher when zero-overage is verified and CLI supports agy -p --model', async () => {
    const bridge = makeBridge({
      model: 'gemini-3.8-flash',
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        zeroOverageVerified: true,
        syncRemote: false,
      },
      agyInterfaceVerifier: async () => ({ ok: true }),
      agyModelsGetter: async () => ({ ok: true, models: ['gemini-3.8-flash', 'gemini-3.8-pro'] }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(true);
    expect(pre.zeroOverageVerificationState).toBe('HUMAN_VERIFIED');
    expect(pre.selectedModel).toBe('gemini-3.8-flash');
  });

  it('blocks Antigravity execution with ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED when zero-overage is unverified', async () => {
    const bridge = makeBridge({
      model: 'gemini-3.8-flash',
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        zeroOverageVerified: false,
        syncRemote: false,
      },
      agyInterfaceVerifier: async () => ({ ok: true }),
      agyModelsGetter: async () => ({ ok: true, models: ['gemini-3.8-flash'] }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED');
    expect(pre.zeroOverageVerificationState).toBe('UNVERIFIED');
    expect(pre.reason).toContain('AI Credit Overages setting is UNVERIFIED');
  });

  it('blocks Antigravity execution with MODEL_NOT_IN_CLI when model is missing from agy models', async () => {
    const bridge = makeBridge({
      model: 'gemini-3.8-pro',
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        zeroOverageVerified: true,
        syncRemote: false,
      },
      agyInterfaceVerifier: async () => ({ ok: true }),
      agyModelsGetter: async () => ({ ok: true, models: ['gemini-3.8-flash'] }), // pro missing from CLI
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('MODEL_NOT_IN_CLI');
    expect(pre.reason).toContain('not supported by installed Antigravity CLI');
  });

  it('rejects guessed or unsupported antigravity-run launcher', async () => {
    const bridge = makeBridge({
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity-run',
        syncRemote: false,
      },
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('LAUNCHER_NOT_ALLOWED');
  });

  it('stops if installed agy CLI differs from documented -p headless interface', async () => {
    const bridge = makeBridge({
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        zeroOverageVerified: true,
        syncRemote: false,
      },
      agyInterfaceVerifier: async () => ({
        ok: false,
        code: 'LAUNCHER_NOT_ALLOWED',
        reason: 'Installed "agy" CLI differs from documented headless interface (does not support -p): detected unexpected version',
      }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('LAUNCHER_NOT_ALLOWED');
    expect(pre.reason).toContain('differs from documented headless interface');
  });

  it('constructs safe execution prompt for agy -p from TaskDefinition', () => {
    const task: TaskDefinition = {
      id: 'TASK-002',
      status: 'READY',
      title: 'Build Bridge',
      source: 'Issue #6',
      objective: 'Build isolated bridge without paid API',
      requiredWork: ['Write code', 'Run tests'],
      hardConstraints: ['MAX_ALLOWED_COST = 0', 'ALLOW_PAID_API = false'],
      rawText: '',
    };
    const prompt = constructTaskPrompt(task);
    expect(prompt).toContain('Execute approved task TASK-002: Build Bridge');
    expect(prompt).toContain('Objective: Build isolated bridge without paid API');
    expect(prompt).toContain('1. Write code');
    expect(prompt).toContain('2. Run tests');
    expect(prompt).toContain('- MAX_ALLOWED_COST = 0');
  });

  it('buildLauncherArgs includes explicit --model <slug> and -p <prompt> for Antigravity', () => {
    const task: TaskDefinition = {
      id: 'TASK-002',
      status: 'READY',
      title: 'Build Bridge',
      source: 'Issue #6',
      objective: 'Run safely',
      requiredWork: [],
      hardConstraints: [],
      rawText: '',
    };
    const adapter = {
      name: 'antigravity',
      provider: 'antigravity' as const,
      costPolicy: 'subscription_with_zero_overage' as const,
      modelSelectionMode: 'explicit' as const,
      binary: 'agy',
      prefixArgs: ['-p'],
      modelArgFlag: '--model',
      isHeadlessPrompt: true,
      approvedModels: ['gemini-3.8-flash'],
      defaultModel: 'gemini-3.8-flash',
    };
    const { binary, args } = buildLauncherArgs(adapter, 'gemini-3.8-flash', task);
    expect(binary).toBe('agy');
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('Execute approved task TASK-002');
    expect(args[2]).toBe('--model');
    expect(args[3]).toBe('gemini-3.8-flash');
  });

  it('rejects claude-direct launcher adapter', async () => {
    const bridge = makeBridge({
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'claude-direct',
        syncRemote: false,
      },
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('LAUNCHER_NOT_ALLOWED');
  });

  it('blocks safely with LOCAL_CHANGES_PRESENT when repository has uncommitted local changes', async () => {
    const bridge = makeBridge({
      gitContextResolver: async () => ({
        ...mockGitContext,
        isClean: false,
        uncommittedFiles: ['packages/domain/src/work.ts'],
      }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('LOCAL_CHANGES_PRESENT');
    expect(pre.reason).toContain('uncommitted local changes');
  });

  it('blocks with ANTIGRAVITY_MODEL_POLICY_MISMATCH when model is in CLI but not in repository allowlist', async () => {
    const bridge = makeBridge({
      model: 'gemini-future-unapproved',
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        zeroOverageVerified: true,
        syncRemote: false,
      },
      agyInterfaceVerifier: async () => ({ ok: true }),
      agyModelsGetter: async () => ({ ok: true, models: ['gemini-future-unapproved'] }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('PAID_MODEL_BLOCKED');
  });

  // ─── Provider and Model Contract Enforcement ─────────────────────────

  it('rejects OpenRouter model passed to Antigravity launcher in bridge', async () => {
    const bridge = makeBridge({
      model: 'nvidia/nemotron-3.5-lightning:free',
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        zeroOverageVerified: true,
        syncRemote: false,
      },
      agyInterfaceVerifier: async () => ({ ok: true }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('MODEL_PROVIDER_MISMATCH');
    expect(pre.reason).toContain('OpenRouter model');
    expect(pre.reason).toContain('antigravity');
  });

  it('rejects stale older gemini-2.0-flash model for Antigravity in bridge', async () => {
    const bridge = makeBridge({
      model: 'gemini-2.0-flash',
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        zeroOverageVerified: true,
        syncRemote: false,
      },
      agyInterfaceVerifier: async () => ({ ok: true }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('PAID_MODEL_BLOCKED');
  });

  it('OpenRouter free-model policy cannot accidentally authorize Antigravity', async () => {
    const bridge = makeBridge({
      model: 'google/gemini-2.0-flash-exp:free',
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        zeroOverageVerified: true,
        syncRemote: false,
      },
      agyInterfaceVerifier: async () => ({ ok: true }),
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('MODEL_PROVIDER_MISMATCH');
  });

  it('audit log records provider, launcher, model slug, costPolicy, and zeroOverageVerificationState on dry-run', async () => {
    const bridge = makeBridge({
      model: 'gemini-3.8-flash',
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        zeroOverageVerified: true,
        dryRun: true,
        syncRemote: false,
      },
      agyInterfaceVerifier: async () => ({ ok: true }),
      agyModelsGetter: async () => ({ ok: true, models: ['gemini-3.8-flash'] }),
    });

    const result = await bridge.run();
    expect(result.success).toBe(true);

    const logs = await readAuditLogs(tempAuditFile);
    const dryRunLog = logs.find((l) => l.eventType === 'DRY_RUN');
    expect(dryRunLog).toBeDefined();
    expect(dryRunLog?.provider).toBe('antigravity');
    expect(dryRunLog?.launcher).toBe('antigravity');
    expect(dryRunLog?.model).toBe('gemini-3.8-flash');
    expect(dryRunLog?.costPolicy).toBe('subscription_with_zero_overage');
    expect(dryRunLog?.zeroOverageVerificationState).toBe('HUMAN_VERIFIED');
    expect(dryRunLog?.modelRuntimeVerification).toBe('verified_in_cli');
  });

  // ─── Task state distinction ───────────────────────────────────────────

  it('distinguishes LOCAL READY and allows execution', async () => {
    await fs.writeFile(tempTaskFile, sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** LOCAL READY'), 'utf-8');
    const bridge = makeBridge();
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(true);
    expect(pre.task?.status).toBe('LOCAL READY');
  });

  it('distinguishes REMOTE READY and allows execution', async () => {
    await fs.writeFile(tempTaskFile, sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** REMOTE READY'), 'utf-8');
    const bridge = makeBridge();
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(true);
    expect(pre.task?.status).toBe('REMOTE READY');
  });

  it('distinguishes QA_REVIEW and stops execution (waiting for QA)', async () => {
    await fs.writeFile(tempTaskFile, sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** QA_REVIEW'), 'utf-8');
    const bridge = makeBridge();
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('INVALID_TASK_STATE');
    expect(pre.reason).toContain('awaiting ChatGPT QA review');
  });

  it('distinguishes APPROVED and stops execution (task completed)', async () => {
    await fs.writeFile(tempTaskFile, sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** APPROVED'), 'utf-8');
    const bridge = makeBridge();
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('INVALID_TASK_STATE');
    expect(pre.reason).toContain('approved');
  });

  it('distinguishes BLOCKED and stops execution', async () => {
    await fs.writeFile(tempTaskFile, sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** BLOCKED'), 'utf-8');
    const bridge = makeBridge();
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('INVALID_TASK_STATE');
    expect(pre.reason).toContain('blocked');
  });

  it('distinguishes IMPLEMENTING and stops execution (already in progress)', async () => {
    await fs.writeFile(tempTaskFile, sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** IMPLEMENTING'), 'utf-8');
    const bridge = makeBridge();
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('INVALID_TASK_STATE');
    expect(pre.reason).toContain('in progress');
  });

  // ─── Remote Authority & Offline Safety Guards ────────────────────────

  it('detects remote task synchronization in bridge preconditions', async () => {
    const mockSync: GitSyncResult = {
      synced: true,
      state: 'REMOTE_FETCHED',
      localTask: {
        id: 'TASK-002',
        status: 'REMOTE READY',
        title: 'Authoritative remote task',
        source: 'Issue #6',
        objective: 'Objective',
        requiredWork: [],
        hardConstraints: [],
        rawText: '',
      },
    };

    const bridge = makeBridge({
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: false,
        syncRemote: true,
      },
      remoteSyncResolver: async () => mockSync,
    });

    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(true);
    expect(pre.syncResult?.state).toBe('REMOTE_FETCHED');
  });

  it('remote fetch failure halts with REMOTE_SYNC_FAILED and blocks execution', async () => {
    const mockSync: GitSyncResult = {
      synced: false,
      state: 'FAILED',
      code: 'REMOTE_SYNC_FAILED',
      reason: 'Cannot fetch or verify remote authority from origin/main. Execution halted.',
    };

    const bridge = makeBridge({
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: false,
        syncRemote: true,
      },
      remoteSyncResolver: async () => mockSync,
    });

    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('REMOTE_SYNC_FAILED');

    const result = await bridge.run();
    expect(result.success).toBe(false);
    expect(result.code).toBe('REMOTE_SYNC_FAILED');
  });

  it('stale local READY cannot execute when remote authority cannot be verified', async () => {
    // Local file has STATUS: READY
    await fs.writeFile(tempTaskFile, sampleTaskDoc, 'utf-8');

    const mockSync: GitSyncResult = {
      synced: false,
      state: 'FAILED',
      code: 'REMOTE_SYNC_FAILED',
      reason: 'Network failure during fetch origin/main. Unattended execution blocked.',
    };

    const bridge = makeBridge({
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: false,
        syncRemote: true,
      },
      remoteSyncResolver: async () => mockSync,
    });

    // Bridge refuses to execute stale local READY
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('REMOTE_SYNC_FAILED');
  });

  it('halts safely on SYNC_CONFLICT and never overwrites local work', async () => {
    const mockSync: GitSyncResult = {
      synced: false,
      state: 'CONFLICT',
      code: 'SYNC_CONFLICT',
      reason: 'Remote origin/main has updated task state, but local working tree has uncommitted changes (packages/domain/src/work.ts). Halting to prevent overwriting local work.',
    };

    const bridge = makeBridge({
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: false,
        syncRemote: true,
      },
      remoteSyncResolver: async () => mockSync,
    });

    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('SYNC_CONFLICT');
    expect(pre.reason).toContain('uncommitted changes');

    const runResult = await bridge.run();
    expect(runResult.success).toBe(false);
    expect(runResult.code).toBe('SYNC_CONFLICT');

    // Local task file was NOT modified
    const content = await fs.readFile(tempTaskFile, 'utf-8');
    expect(content).toBe(sampleTaskDoc);
  });

  // ─── Quota / Billing immediate STOP ───────────────────────────────────

  it('billing / quota 402/429 output causes immediate STOP to BLOCKED', () => {
    const billingCheck = detectQuotaOrBillingError('Error: 402 Payment Required. Credit balance is too low.');
    expect(billingCheck.allowed).toBe(false);
    expect(billingCheck.code).toBe('FREE_QUOTA_EXHAUSTED');

    const rateLimitCheck = detectQuotaOrBillingError('HTTP 429 Too Many Requests: Rate limit exceeded.');
    expect(rateLimitCheck.allowed).toBe(false);
    expect(rateLimitCheck.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  // ─── Dry-run mode ─────────────────────────────────────────────────────

  it('dry-run does not modify task file or launch process', async () => {
    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: true,
        syncRemote: false,
      },
    });

    const result = await bridge.run();
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);

    const taskContent = await fs.readFile(tempTaskFile, 'utf-8');
    expect(taskContent).toContain('**STATUS:** READY');

    const logs = await readAuditLogs(tempAuditFile);
    expect(logs.some((l) => l.eventType === 'DRY_RUN')).toBe(true);
  });

  // ─── Duplicate instance blocking ──────────────────────────────────────

  it('blocks a second bridge instance from acquiring the lock', async () => {
    const lockResult1 = await acquireLock(tempLockFile);
    expect(lockResult1.acquired).toBe(true);

    const lockResult2 = await acquireLock(tempLockFile);
    expect(lockResult2.acquired).toBe(false);

    await releaseLock(tempLockFile);
  });

  it('cleans stale lock from dead PID and allows new instance', async () => {
    await fs.writeFile(tempLockFile, JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }), 'utf-8');

    const lockResult = await acquireLock(tempLockFile);
    expect(lockResult.acquired).toBe(true);
    await releaseLock(tempLockFile);
  });

  // ─── Watch mode: no automatic task chaining ───────────────────────────

  it('watch mode stops at QA_REVIEW and does not auto-chain tasks', async () => {
    const ticks: string[] = [];
    const results: string[] = [];

    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      testRunner: async () => ({ ok: true, output: 'all pass' }),
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: true,
        watchMode: true,
        syncRemote: false,
        pollIntervalMs: 50,
      },
    });

    await bridge.watch(
      (s) => ticks.push(s),
      (r) => results.push(r.finalStatus)
    );

    expect(ticks.length).toBeGreaterThan(0);
    const taskContent = await fs.readFile(tempTaskFile, 'utf-8');
    expect(taskContent).toContain('**STATUS:** READY');
  });

  it('watch mode does not start TASK-003 automatically', async () => {
    await fs.writeFile(tempTaskFile, sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** QA_REVIEW'), 'utf-8');

    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: true,
        watchMode: true,
        syncRemote: false,
        pollIntervalMs: 50,
      },
    });

    bridge.stop();
    await bridge.watch();

    const taskContent = await fs.readFile(tempTaskFile, 'utf-8');
    expect(taskContent).toContain('**STATUS:** QA_REVIEW');
    expect(taskContent).not.toContain('TASK-003');
  });

  // ─── Graceful shutdown ────────────────────────────────────────────────

  it('bridge.stop() causes watch loop to exit gracefully', async () => {
    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: true,
        watchMode: true,
        syncRemote: false,
        pollIntervalMs: 100,
      },
    });

    let tickCount = 0;
    const watchPromise = bridge.watch(() => {
      tickCount++;
      if (tickCount >= 2) {
        bridge.stop();
      }
    });

    await watchPromise;

    const logs = await readAuditLogs(tempAuditFile);
    const stopLog = logs.find((l) => l.eventType === 'WATCH_STOP' && l.stopReason?.includes('Graceful shutdown'));
    expect(stopLog).toBeDefined();
  });

  // ─── Kill switch abort ────────────────────────────────────────────────

  it('kill switch active causes run() to abort before launch', async () => {
    await triggerKillSwitch(tempKillFile, 'Safety test');
    const bridge = makeBridge();
    const result = await bridge.run();
    expect(result.success).toBe(false);
    expect(result.code).toBe('KILL_SWITCH_ACTIVE');
    const taskContent = await fs.readFile(tempTaskFile, 'utf-8');
    expect(taskContent).toContain('**STATUS:** READY');
  });
});
