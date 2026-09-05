import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AIBridge } from '../src/bridge.ts';
import { triggerKillSwitch } from '../src/kill-switch.ts';
import { readAuditLogs } from '../src/audit-logger.ts';
import type { GitContext } from '../src/git-utils.ts';

describe('AIBridge engine', () => {
  const tempDir = path.resolve(process.cwd(), 'scratch-bridge-test');
  const tempTaskFile = path.resolve(tempDir, 'AI_TASK.md');
  const tempAuditFile = path.resolve(tempDir, 'AUDIT.log');
  const tempKillFile = path.resolve(tempDir, '.bridge-stop');

  const mockGitContext: GitContext = {
    remoteUrl: 'git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git',
    branch: 'main',
    commitSha: '2c98a0e8b955a3f3a60fdd44c49cfef5e726812b',
    isClean: true,
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

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(tempTaskFile, sampleTaskDoc, 'utf-8');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  it('passes preconditions for valid configuration and state', async () => {
    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
      },
    });

    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(true);
    expect(pre.task?.id).toBe('TASK-002');
  });

  it('stops immediately if kill switch is active', async () => {
    await triggerKillSwitch(tempKillFile, 'Operator stop request');

    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
      },
    });

    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('KILL_SWITCH_ACTIVE');

    const runResult = await bridge.run();
    expect(runResult.success).toBe(false);
    expect(runResult.code).toBe('KILL_SWITCH_ACTIVE');
  });

  it('rejects unauthorized git repository', async () => {
    const unauthorizedGit: GitContext = {
      ...mockGitContext,
      remoteUrl: 'git@github.com:other-user/other-repo.git',
    };

    const bridge = new AIBridge({
      gitContextResolver: async () => unauthorizedGit,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
      },
    });

    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('REPO_NOT_ALLOWED');
  });

  it('rejects non-main branch', async () => {
    const wrongBranchGit: GitContext = {
      ...mockGitContext,
      branch: 'feature/unapproved',
    };

    const bridge = new AIBridge({
      gitContextResolver: async () => wrongBranchGit,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
      },
    });

    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('BRANCH_NOT_ALLOWED');
  });

  it('rejects paid model configuration', async () => {
    const bridge = new AIBridge({
      model: 'anthropic/claude-3-5-sonnet',
      gitContextResolver: async () => mockGitContext,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
      },
    });

    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('PAID_MODEL_BLOCKED');
  });

  it('rejects execution if task status is not READY', async () => {
    await fs.writeFile(
      tempTaskFile,
      sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** QA_REVIEW'),
      'utf-8'
    );

    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
      },
    });

    const pre = await bridge.checkPreconditions();
    expect(pre.allowed).toBe(false);
    expect(pre.code).toBe('INVALID_TASK_STATE');
  });

  it('performs safe dry-run without altering files or running commands', async () => {
    let launcherCalled = false;
    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      launcherRunner: async () => {
        launcherCalled = true;
        return { code: 0, stdout: '', stderr: '' };
      },
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        dryRun: true,
      },
    });

    const result = await bridge.run();
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(launcherCalled).toBe(false);

    // Verify task file remained in READY status
    const taskContent = await fs.readFile(tempTaskFile, 'utf-8');
    expect(taskContent).toContain('**STATUS:** READY');

    // Verify audit log has DRY_RUN entry
    const logs = await readAuditLogs(tempAuditFile);
    expect(logs.some((l) => l.eventType === 'DRY_RUN')).toBe(true);
  });

  it('halts and transitions to BLOCKED on free quota exhaustion during execution', async () => {
    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      launcherRunner: async () => ({
        code: 1,
        stdout: '',
        stderr: 'Error: free quota exhausted for model nvidia/nemotron-3.5-lightning:free',
      }),
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        dryRun: false,
      },
    });

    const result = await bridge.run();
    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe('BLOCKED');
    expect(result.code).toBe('FREE_QUOTA_EXHAUSTED');

    // Verify task file was updated to BLOCKED
    const taskContent = await fs.readFile(tempTaskFile, 'utf-8');
    expect(taskContent).toContain('**STATUS:** BLOCKED');

    // Verify audit log recorded failure
    const logs = await readAuditLogs(tempAuditFile);
    expect(logs.some((l) => l.eventType === 'TASK_BLOCKED' && l.code === 'FREE_QUOTA_EXHAUSTED')).toBe(true);
  });

  it('halts and refuses QA_REVIEW transition if verification tests fail', async () => {
    const bridge = new AIBridge({
      gitContextResolver: async () => mockGitContext,
      launcherRunner: async () => ({ code: 0, stdout: 'Code written', stderr: '' }),
      testRunner: async () => ({ ok: false, output: '1 test failed in bridge.test.ts' }),
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        dryRun: false,
      },
    });

    const result = await bridge.run();
    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe('BLOCKED');
    expect(result.code).toBe('TESTS_FAILED');

    const taskContent = await fs.readFile(tempTaskFile, 'utf-8');
    expect(taskContent).toContain('**STATUS:** BLOCKED');
  });

  it('completes successfully and transitions to QA_REVIEW when tests pass', async () => {
    let launcherInvoked = false;
    let testsInvoked = false;

    const updatedGitContext: GitContext = {
      ...mockGitContext,
      commitSha: '9f8e7d6c5b4a',
    };

    const bridge = new AIBridge({
      gitContextResolver: async () => updatedGitContext,
      launcherRunner: async () => {
        launcherInvoked = true;
        return { code: 0, stdout: 'Implemented', stderr: '' };
      },
      testRunner: async () => {
        testsInvoked = true;
        return { ok: true, output: 'All tests passed' };
      },
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        dryRun: false,
      },
    });

    const result = await bridge.run();
    expect(result.success).toBe(true);
    expect(result.finalStatus).toBe('QA_REVIEW');
    expect(result.commitSha).toBe('9f8e7d6c5b4a');
    expect(launcherInvoked).toBe(true);
    expect(testsInvoked).toBe(true);

    const taskContent = await fs.readFile(tempTaskFile, 'utf-8');
    expect(taskContent).toContain('**STATUS:** QA_REVIEW');

    const logs = await readAuditLogs(tempAuditFile);
    expect(logs.some((l) => l.eventType === 'TASK_COMPLETE' && l.status === 'QA_REVIEW')).toBe(true);
  });
});
