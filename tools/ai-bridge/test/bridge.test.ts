import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AIBridge } from '../src/bridge.ts';
import { triggerKillSwitch, clearKillSwitch } from '../src/kill-switch.ts';
import { readAuditLogs } from '../src/audit-logger.ts';
import { acquireLock, releaseLock } from '../src/lock.ts';
import type { GitContext, GitSyncResult } from '../src/git-utils.ts';

describe('AIBridge engine', () => {
  const tempDir = path.resolve(process.cwd(), 'scratch-bridge-test-rework2');
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
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'ori-claude',
        dryRun: false,
        syncRemote: false, // by default in unit tests, syncRemote is tested in specific test cases
      },
      ...overrides,
    });
  }

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(tempTaskFile, sampleTaskDoc, 'utf-8');
    // Ensure no stale kill switch or lock
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

  // ─── Antigravity launcher allowlist ───────────────────────────────────

  it('accepts allowlisted antigravity launcher', async () => {
    const bridge = makeBridge({
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        launcherName: 'antigravity',
        syncRemote: false,
      },
    });
    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(true);
  });

  it('accepts allowlisted antigravity-run launcher', async () => {
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
    expect(pre.allowed).toBe(true);
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

  // ─── Remote Synchronization & Conflict Guards ────────────────────────

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

    // Run also halts safely
    const runResult = await bridge.run();
    expect(runResult.success).toBe(false);
    expect(runResult.code).toBe('SYNC_CONFLICT');

    // Local task file was NOT modified
    const content = await fs.readFile(tempTaskFile, 'utf-8');
    expect(content).toBe(sampleTaskDoc);
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
