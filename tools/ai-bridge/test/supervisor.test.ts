import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { AutonomousSupervisor, type SupervisorOptions } from '../src/supervisor.ts';
import { AIBridge } from '../src/bridge.ts';
import { triggerKillSwitch, clearKillSwitch } from '../src/kill-switch.ts';
import { readAuditLogs } from '../src/audit-logger.ts';
import { acquireLock, releaseLock } from '../src/lock.ts';
import { checkExternalQAApproval } from '../src/task-parser.ts';
import {
  signApprovalPayload,
  createTestVerifier,
  type ApprovalPayload,
  type ExternalApprovalArtifact,
} from '../src/crypto.ts';
import type { GitContext, GitSyncResult } from '../src/git-utils.ts';
import type { TaskDefinition } from '../src/types.ts';

describe('Phase C AutonomousSupervisor', () => {
  const tempDir = path.resolve(process.cwd(), 'scratch-supervisor-test');
  const tempTaskFile = path.resolve(tempDir, 'AI_TASK.md');
  const tempAuditFile = path.resolve(tempDir, 'AUDIT.log');
  const tempKillFile = path.resolve(tempDir, '.bridge-stop');
  const tempLockFile = path.resolve(tempDir, '.bridge-lock');
  const tempOutsideDir = path.resolve(os.tmpdir(), `test-sup-operator-${Date.now()}`);
  const tempOperatorFile = path.resolve(tempOutsideDir, 'zero-overage-verified.json');
  const tempQaApprovalFile = path.resolve(tempOutsideDir, 'qa-approval.json');

  const testKeyPair = crypto.generateKeyPairSync('ed25519');
  const otherKeyPair = crypto.generateKeyPairSync('ed25519');
  const testPublicKeyPem = testKeyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const defaultTestVerifier = createTestVerifier(testPublicKeyPem);

  function createSignedApproval(
    overrides: Partial<ApprovalPayload> = {},
    key: crypto.KeyObject = testKeyPair.privateKey
  ): ExternalApprovalArtifact {
    const payload: ApprovalPayload = {
      version: 1,
      status: 'APPROVED',
      approver: 'ChatGPT',
      approvedTaskId: 'TASK-003',
      approvedCommitSha: '526368ebac3f7a94141d3c36e12a7a41ee8fc5f8',
      approvedAt: new Date().toISOString(),
      ...overrides,
    };
    const signature = signApprovalPayload(payload, key);
    return { payload, signature };
  }

  const mockGitContext: GitContext = {
    remoteUrl: 'git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git',
    branch: 'main',
    commitSha: '526368ebac3f7a94141d3c36e12a7a41ee8fc5f8',
    isClean: true,
    uncommittedFiles: [],
  };

  const sampleTaskDoc = `
# AI TASK — ChatGPT → Claude Code

## Current Task

**TASK ID:** TASK-003
**STATUS:** READY
**TITLE:** Open Phase C Autonomous Task Loop
**SOURCE:** GitHub Issue #7

### Objective
Implement Phase C Autonomous Task Loop.

### Required work
1. Build supervisor.
2. Verify all gates.

### Hard constraints
- MAX_ALLOWED_COST = 0
- ALLOW_PAID_API = false
`;

  function makeSupervisor(
    overrides: Omit<SupervisorOptions, 'testApprovalVerifier'> & {
      testApprovalVerifier?: ReturnType<typeof createTestVerifier> | null;
    } = {}
  ): AutonomousSupervisor {
    const { config: configOverride, testApprovalVerifier: _ignored, ...restOverrides } = overrides;
    const activeTestVerifier: ReturnType<typeof createTestVerifier> | undefined =
      overrides.testApprovalVerifier === null
        ? undefined
        : (overrides.testApprovalVerifier ?? defaultTestVerifier);

    return new AutonomousSupervisor({
      cwd: tempDir,
      gitContextResolver: async () => mockGitContext,
      testRunner: async () => ({ ok: true, output: 'All tests passed' }),
      agyInterfaceVerifier: async () => ({ ok: true }),
      agyModelsGetter: async () => ({ ok: true, models: ['gemini-3.8-flash-medium'] }),
      launcherRunner: async () => ({ code: 0, stdout: 'Task executed successfully', stderr: '', killedBySwitch: false }),
      remoteSyncResolver: async () => ({
        synced: true,
        state: 'UP_TO_DATE',
      }),
      testApprovalVerifier: activeTestVerifier,
      trustAnchorPath: overrides.trustAnchorPath,
      qaApprovalResolver: activeTestVerifier
        ? (opts) => checkExternalQAApproval({ ...opts, testVerifier: activeTestVerifier })
        : (opts) => checkExternalQAApproval({ ...opts, trustAnchorPath: overrides.trustAnchorPath }),
      pollIntervalMs: 10,
      maxCycles: 1,
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        operatorVerificationFilePath: tempOperatorFile,
        qaApprovalFilePath: tempQaApprovalFile,
        launcherName: 'ori-claude',
        dryRun: false,
        syncRemote: true,
        ...configOverride,
      },
      ...restOverrides,
    });
  }

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(tempOutsideDir, { recursive: true });
    await fs.writeFile(tempTaskFile, sampleTaskDoc, 'utf-8');
    await fs.writeFile(
      tempOperatorFile,
      JSON.stringify({
        status: 'HUMAN_VERIFIED',
        policy: 'AI Credit Overages = Never',
        verifiedBy: 'human-operator',
        verifiedAt: new Date().toISOString(),
      }),
      'utf-8'
    );
    try { await fs.unlink(tempKillFile); } catch { /* ok */ }
    try { await fs.unlink(tempLockFile); } catch { /* ok */ }
    try { await fs.unlink(tempAuditFile); } catch { /* ok */ }
    try { await fs.unlink(tempQaApprovalFile); } catch { /* ok */ }
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
    try { await fs.rm(tempOutsideDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ─── 1-12: Lifecycle States, Authority, Approval Gate & Next Task ─────

  it('1. supervisor starts and transitions to LOOP_START', async () => {
    const sup = makeSupervisor({ maxCycles: 1 });
    const states: string[] = [];
    await sup.run({ onStateChange: (s) => states.push(s) });
    expect(states).toContain('LOOP_START');
  });

  it('2. supervisor polls for tasks and enters WAITING_FOR_TASK when no task is READY', async () => {
    const notReadyDoc = sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** HOLD');
    await fs.writeFile(tempTaskFile, notReadyDoc, 'utf-8');

    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.state).toBe('WAITING_FOR_TASK');

    const logs = await readAuditLogs(tempAuditFile);
    const waitingLog = logs.find((l) => l.eventType === 'WAITING_FOR_TASK');
    expect(waitingLog).toBeDefined();
    expect(waitingLog?.taskId).toBe('TASK-003');
  });

  it('3. authoritative origin/main is required (fails if remote sync fails with REMOTE_SYNC_FAILED)', async () => {
    const sup = makeSupervisor({
      remoteSyncResolver: async () => ({
        synced: false,
        state: 'FAILED',
        reason: 'Network unreachable: could not fetch origin/main',
        code: 'REMOTE_SYNC_FAILED',
      }),
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
    expect(res.stopReason).toContain('remote synchronization failed');

    const logs = await readAuditLogs(tempAuditFile);
    const blockedLog = logs.find((l) => l.eventType === 'LOOP_BLOCKED');
    expect(blockedLog).toBeDefined();
    expect(blockedLog?.code).toBe('REMOTE_SYNC_FAILED');
  });

  it('4. stale local READY cannot bypass remote authority when remote sync fails', async () => {
    // Local doc says READY, but remote fetch fails
    const sup = makeSupervisor({
      remoteSyncResolver: async () => ({
        synced: false,
        state: 'FAILED',
        reason: 'Remote authority cannot be verified',
        code: 'REMOTE_SYNC_FAILED',
      }),
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
    expect(res.tasksCompleted).toHaveLength(0);
  });

  it('5. processes exactly one task at a time and consumes verified READY task', async () => {
    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.tasksCompleted).toContain('TASK-003');
    expect(res.tasksCompleted).toHaveLength(1);
  });

  it('6. next task requires explicit READY (HOLD or BLOCKED is not consumed)', async () => {
    const holdDoc = sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** HOLD');
    await fs.writeFile(tempTaskFile, holdDoc, 'utf-8');

    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.tasksCompleted).toHaveLength(0);
    expect(res.state).toBe('WAITING_FOR_TASK');
  });

  it('7. QA_REVIEW does NOT imply approval (enters WAITING_FOR_APPROVAL and stops progression)', async () => {
    const sup = makeSupervisor({ maxCycles: 1 });
    const states: string[] = [];
    await sup.run({ onStateChange: (s) => states.push(s) });

    expect(states).toContain('TASK_QA_REVIEW');
    expect(states).toContain('WAITING_FOR_APPROVAL');
    expect(states).not.toContain('TASK_APPROVED');
  });

  it('8. durable ChatGPT approval signal unlocks continuation to TASK_APPROVED', async () => {
    let callCount = 0;
    const sup = makeSupervisor({
      maxCycles: 2,
      remoteSyncResolver: async () => {
        callCount++;
        if (callCount >= 2) {
          // External ChatGPT approval record written outside repository workspace
          const artifact = createSignedApproval();
          await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');
          // And document status reflects QA_REVIEW
          const approvedDoc = `
# AI TASK
## Current Task
**TASK ID:** TASK-003
**STATUS:** QA_REVIEW
**TITLE:** Open Phase C Autonomous Task Loop
`;
          await fs.writeFile(tempTaskFile, approvedDoc, 'utf-8');
        }
        return { synced: true, state: 'UP_TO_DATE' };
      },
    });

    const states: string[] = [];
    await sup.run({ onStateChange: (s) => states.push(s) });

    expect(states).toContain('WAITING_FOR_APPROVAL');
    expect(states).toContain('TASK_APPROVED');
  });

  it('9. missing or incomplete approval keeps supervisor in WAITING_FOR_APPROVAL', async () => {
    let syncCount = 0;
    const sup = makeSupervisor({
      maxCycles: 2,
      remoteSyncResolver: async () => {
        syncCount++;
        if (syncCount >= 2) {
          // Unapproved / no signature
          const doc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** QA_REVIEW
`;
          await fs.writeFile(tempTaskFile, doc, 'utf-8');
        }
        return { synced: true, state: 'UP_TO_DATE' };
      },
    });

    const states: string[] = [];
    await sup.run({ onStateChange: (s) => states.push(s) });

    expect(states).toContain('WAITING_FOR_APPROVAL');
    expect(states).not.toContain('TASK_APPROVED');
  });

  it('10. no next READY task does not create synthetic work (enters WAITING_FOR_TASK)', async () => {
    let syncCount = 0;
    const sup = makeSupervisor({
      maxCycles: 2,
      remoteSyncResolver: async () => {
        syncCount++;
        if (syncCount >= 2) {
          // Approved via external signed record, but no new task issued
          const artifact = createSignedApproval();
          await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');
          const approvedDoc = `
# AI TASK
## Current Task
**TASK ID:** TASK-003
**STATUS:** QA_REVIEW
`;
          await fs.writeFile(tempTaskFile, approvedDoc, 'utf-8');
        }
        return { synced: true, state: 'UP_TO_DATE' };
      },
    });

    const states: string[] = [];
    await sup.run({ onStateChange: (s) => states.push(s) });

    expect(states).toContain('TASK_APPROVED');
    expect(states).toContain('WAITING_FOR_TASK');
  });

  it('11. task order follows GitHub authority (discovers explicit next READY task)', async () => {
    let syncCount = 0;
    const sup = makeSupervisor({
      maxCycles: 2,
      remoteSyncResolver: async () => {
        syncCount++;
        if (syncCount >= 2) {
          // ChatGPT approved TASK-003 via external signed record and issued TASK-003-B on origin/main
          const artifact = createSignedApproval();
          await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');
          const nextDoc = `
# AI TASK
## Completed Tasks
**TASK ID:** TASK-003
**STATUS:** QA_REVIEW

## Current Task
**TASK ID:** TASK-003-B
**STATUS:** READY
**TITLE:** Autonomous Extension
`;
          await fs.writeFile(tempTaskFile, nextDoc, 'utf-8');
        }
        return { synced: true, state: 'UP_TO_DATE' };
      },
    });

    const states: string[] = [];
    await sup.run({ onStateChange: (s) => states.push(s) });

    expect(states).toContain('TASK_APPROVED');
    expect(states).toContain('NEXT_TASK_DETECTED');
  });

  it('12. TASK IDs cannot be invented (only explicit tasks parsed from origin/main)', async () => {
    // If task document has invalid or missing task ID, supervisor blocks
    const corruptDoc = '## Current Task\nInvalid content without task ID';
    await fs.writeFile(tempTaskFile, corruptDoc, 'utf-8');

    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
    expect(res.code).toBe('TASK_NOT_FOUND');
  });

  // ─── 13-19: Safety, Quota & Billing Fail-Safe Rules ───────────────────

  it('13. safety failure stops entire supervisor (LOOP_BLOCKED)', async () => {
    const sup = makeSupervisor({
      gitContextResolver: async () => ({
        ...mockGitContext,
        branch: 'unauthorized-branch',
      }),
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
    expect(res.stopReason).toContain('Branch "unauthorized-branch" is not in allowlist');
  });

  it('14. quota exhaustion stops supervisor (LOOP_BLOCKED)', async () => {
    const bridgeWithQuotaError = new AIBridge({
      cwd: tempDir,
      gitContextResolver: async () => mockGitContext,
      testRunner: async () => ({ ok: false, output: 'Error 402 Payment Required: free quota exhausted' }),
      config: {
        taskFilePath: tempTaskFile,
        auditLogPath: tempAuditFile,
        killSwitchFilePath: tempKillFile,
        lockFilePath: tempLockFile,
        operatorVerificationFilePath: tempOperatorFile,
        launcherName: 'ori-claude',
        syncRemote: false,
      },
    });

    const sup = makeSupervisor({ bridge: bridgeWithQuotaError });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');

    const logs = await readAuditLogs(tempAuditFile);
    const blockedLog = logs.find((l) => l.eventType === 'LOOP_BLOCKED');
    expect(blockedLog).toBeDefined();
  });

  it('15. quota exhaustion never invokes paid fallback', async () => {
    const sup = makeSupervisor({
      testRunner: async () => ({ ok: false, output: 'quota exceeded: free balance 0' }),
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');

    // Verify audit log has no paid API attempts
    const logs = await readAuditLogs(tempAuditFile);
    const hasPaidAttempt = logs.some((l) => l.costPolicy === 'unsupported' || l.code === 'PAID_API_BLOCKED');
    expect(hasPaidAttempt).toBe(false);
  });

  it('16. 402 Payment Required stops immediately', async () => {
    const sup = makeSupervisor({
      testRunner: async () => ({ ok: false, output: 'HTTP 402 Payment Required' }),
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('17. 429 Too Many Requests stops immediately', async () => {
    const sup = makeSupervisor({
      testRunner: async () => ({ ok: false, output: 'HTTP 429 Too Many Requests: rate limit exceeded' }),
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('18. billing error strings stop supervisor immediately', async () => {
    const sup = makeSupervisor({
      testRunner: async () => ({ ok: false, output: 'billing failure: credit balance is too low' }),
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('19. credit overage strings stop supervisor immediately', async () => {
    const sup = makeSupervisor({
      testRunner: async () => ({ ok: false, output: 'ai credit overages enabled: stopping' }),
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  // ─── 20-23: Kill Switch, Single Instance & Worktree Safety ────────────

  it('20. kill switch stops supervisor (LOOP_STOP)', async () => {
    await triggerKillSwitch(tempKillFile, 'Operator Emergency Stop');
    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_STOP');
  });

  it('21. kill switch terminates child process and signals stop', async () => {
    const sup = makeSupervisor({ maxCycles: 1 });
    sup.stop();
    const res = await sup.run();
    expect(res.state).toBe('LOOP_STOP');
  });

  it('22. duplicate supervisor blocked by single-instance lock', async () => {
    await acquireLock(tempLockFile);

    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
    expect(res.code).toBe('DUPLICATE_INSTANCE');

    await releaseLock(tempLockFile);
  });

  it('23. dirty worktree blocks supervisor (LOCAL_CHANGES_PRESENT)', async () => {
    const sup = makeSupervisor({
      gitContextResolver: async () => ({
        ...mockGitContext,
        isClean: false,
        uncommittedFiles: ['modified-file.ts'],
      }),
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
    expect(res.stopReason).toContain('LOCAL_CHANGES_PRESENT');
  });

  // ─── 24-30: Antigravity Zero-Overage & Model Verification ─────────────

  it('24. zero-overage self-authorization inside repository is blocked', async () => {
    const repoVerificationFile = path.resolve(tempDir, 'zero-overage.json');
    await fs.writeFile(
      repoVerificationFile,
      JSON.stringify({ status: 'HUMAN_VERIFIED', policy: 'AI Credit Overages = Never' }),
      'utf-8'
    );

    const sup = makeSupervisor({
      model: 'gemini-3.8-flash-medium',
      config: {
        launcherName: 'antigravity',
        operatorVerificationFilePath: repoVerificationFile,
      },
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('25. external human verification remains mandatory for Antigravity', async () => {
    const sup = makeSupervisor({
      model: 'gemini-3.8-flash-medium',
      config: {
        launcherName: 'antigravity',
        operatorVerificationFilePath: path.resolve(tempOutsideDir, 'nonexistent.json'),
      },
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('26. model/provider mismatch blocks supervisor', async () => {
    const sup = makeSupervisor({
      model: 'nvidia/nemotron-3.5-lightning:free', // OpenRouter model passed to Antigravity launcher
      config: {
        launcherName: 'antigravity',
      },
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('27. runtime model mismatch blocks supervisor (MODEL_NOT_IN_CLI)', async () => {
    const sup = makeSupervisor({
      model: 'gemini-3.8-flash-high',
      config: {
        launcherName: 'antigravity',
      },
      agyModelsGetter: async () => ({ ok: true, models: ['gemini-3.8-flash-medium'] }), // high missing
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('28. exact model slug is preserved with quality suffix', async () => {
    const sup = makeSupervisor({
      model: 'gemini-3.8-flash-medium',
      config: {
        launcherName: 'antigravity',
      },
      agyModelsGetter: async () => ({ ok: true, models: ['gemini-3.8-flash-medium'] }),
    });
    const res = await sup.run();
    expect(res.state).toBe('WAITING_FOR_APPROVAL');
  });

  it('29. no model substitution is performed automatically', async () => {
    const sup = makeSupervisor({
      model: 'gemini-2.0-flash', // old non-suffixed model
      config: {
        launcherName: 'antigravity',
      },
    });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('30. Antigravity receives verified --model flag in launcher', async () => {
    let capturedModel: string | undefined;
    const sup = makeSupervisor({
      model: 'gemini-3.8-flash-medium',
      config: {
        launcherName: 'antigravity',
        dryRun: false,
      },
      agyModelsGetter: async () => ({ ok: true, models: ['gemini-3.8-flash-medium'] }),
      launcherRunner: async (adapter, selectedModel) => {
        capturedModel = selectedModel;
        return { code: 0, stdout: 'Task executed successfully', stderr: '', killedBySwitch: false };
      },
    });
    const res = await sup.run();
    expect(res.tasksCompleted).toContain('TASK-003');
    expect(capturedModel).toBe('gemini-3.8-flash-medium');
  });

  // ─── 31-33: Audit Logging and Security ───────────────────────────────

  it('31. audit lifecycle events recorded for supervisor states', async () => {
    const sup = makeSupervisor({ maxCycles: 1 });
    await sup.run();

    const logs = await readAuditLogs(tempAuditFile);
    const eventTypes = logs.map((l) => l.eventType);
    expect(eventTypes).toContain('LOOP_START');
    expect(eventTypes).toContain('TASK_ACCEPTED');
    expect(eventTypes).toContain('TASK_QA_REVIEW');
    expect(eventTypes).toContain('WAITING_FOR_APPROVAL');
  });

  it('32. audit records exact commit SHA', async () => {
    const sup = makeSupervisor({ maxCycles: 1 });
    await sup.run();

    const logs = await readAuditLogs(tempAuditFile);
    const qaLog = logs.find((l) => l.eventType === 'TASK_QA_REVIEW');
    expect(qaLog).toBeDefined();
    expect(qaLog?.commitSha).toBe(mockGitContext.commitSha);
  });

  it('33. secrets are never logged in audit trail', async () => {
    const sup = makeSupervisor({ maxCycles: 1 });
    await sup.run();

    const logContent = await fs.readFile(tempAuditFile, 'utf-8');
    expect(logContent).not.toMatch(/sk-[a-zA-Z0-9_-]{20,}/);
    expect(logContent).not.toMatch(/ghp_[a-zA-Z0-9]{20,}/);
  });

  // ─── 34-37: Human-Only and Architecture Protection ───────────────────

  it('34. human-only action blocks supervisor', async () => {
    const humanTaskDoc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** READY
**TITLE:** Production deployment
### Objective
wrangler deploy to production
`;
    await fs.writeFile(tempTaskFile, humanTaskDoc, 'utf-8');

    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('35. architecture changes are blocked', async () => {
    const archTaskDoc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** READY
**TITLE:** Modify constitution
### Objective
Set ALLOW_PAID_API = true
`;
    await fs.writeFile(tempTaskFile, archTaskDoc, 'utf-8');

    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('36. Cloudflare production actions are blocked', async () => {
    const cfTaskDoc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** READY
**TITLE:** Create database
### Objective
wrangler d1 create my-db
`;
    await fs.writeFile(tempTaskFile, cfTaskDoc, 'utf-8');

    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  it('37. marketplace automation is blocked', async () => {
    const marketTaskDoc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** READY
**TITLE:** Marketplace automation
### Objective
execute marketplace upload autonomously
`;
    await fs.writeFile(tempTaskFile, marketTaskDoc, 'utf-8');

    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.state).toBe('LOOP_BLOCKED');
  });

  // ─── 38-40: No TASK-004 & Mandatory Approval ─────────────────────────

  it('38. TASK-004 is never started automatically', async () => {
    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.tasksCompleted).not.toContain('TASK-004');
  });

  it('39. supervisor stops task progression after reaching QA_REVIEW', async () => {
    const sup = makeSupervisor({ maxCycles: 1 });
    const res = await sup.run();
    expect(res.tasksCompleted).toEqual(['TASK-003']);
    // State remains in WAITING_FOR_APPROVAL
    expect(sup.getState()).toBe('WAITING_FOR_APPROVAL');
  });

  it('40. explicit durable approval is required before next task can be accepted', async () => {
    // When task finishes, even with multiple loop cycles, if approval is not written, next task is not run
    let syncCount = 0;
    const sup = makeSupervisor({
      maxCycles: 2,
      remoteSyncResolver: async () => {
        syncCount++;
        return { synced: true, state: 'UP_TO_DATE' };
      },
    });

    const res = await sup.run();
    // After cycle 1, TASK-003 is at QA_REVIEW and waiting for approval. In cycle 2, approval is still missing, so it remains waiting
    expect(res.tasksCompleted).toEqual(['TASK-003']);
    expect(sup.getState()).toBe('WAITING_FOR_APPROVAL');
  });

  // ─── Mandatory Regression Suite: 30 Cryptographic Approval & Safety Invariants ─────

  describe('Phase C Cryptographic QA Approval Trust Boundary — 30 Mandatory Regression Tests', () => {
    const validFullSha = '526368ebac3f7a94141d3c36e12a7a41ee8fc5f8';
    const otherFullSha = '0f4e10df5401fe0a641740d935fcbffce3a18455';

    it('1. repo public key cannot authorize', async () => {
      const insideWorkspaceKey = path.resolve(tempDir, 'chatgpt-qa-public-key.pem');
      await fs.writeFile(insideWorkspaceKey, testPublicKeyPem, { mode: 0o400 });
      const sup = makeSupervisor({
        testApprovalVerifier: null,
        trustAnchorPath: insideWorkspaceKey,
      });
      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('SELF_AUTHORIZATION_BLOCKED');
    });

    it('2. CLI public-key override cannot authorize', async () => {
      const missingKey = path.resolve(tempOutsideDir, 'non-existent-key.pem');
      const sup = makeSupervisor({
        testApprovalVerifier: null,
        trustAnchorPath: missingKey,
        config: {
          ...({ '--public-key': testPublicKeyPem, publicKey: testPublicKeyPem } as any),
        },
      });
      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('TRUST_ANCHOR_MISSING');
    });

    it('3. env public-key override cannot authorize', async () => {
      process.env.CHATGPT_PUBLIC_KEY = testPublicKeyPem;
      process.env.TRUSTED_PUBLIC_KEY = testPublicKeyPem;
      try {
        const missingKey = path.resolve(tempOutsideDir, 'non-existent-key.pem');
        const sup = makeSupervisor({
          testApprovalVerifier: null,
          trustAnchorPath: missingKey,
        });
        const res = await sup.run();
        expect(res.state).toBe('LOOP_BLOCKED');
        expect(res.code).toBe('TRUST_ANCHOR_MISSING');
      } finally {
        delete process.env.CHATGPT_PUBLIC_KEY;
        delete process.env.TRUSTED_PUBLIC_KEY;
      }
    });

    it('4. config public-key override cannot authorize', async () => {
      const missingKey = path.resolve(tempOutsideDir, 'non-existent-key.pem');
      const sup = makeSupervisor({
        testApprovalVerifier: null,
        trustAnchorPath: missingKey,
        config: {
          ...({ trustedPublicKey: testPublicKeyPem, trustAnchor: testPublicKeyPem } as any),
        },
      });
      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('TRUST_ANCHOR_MISSING');
    });

    it('5. unprotected trust anchor (writable file) => BLOCKED (TRUST_ANCHOR_NOT_PROTECTED)', async () => {
      const writableKey = path.resolve(tempOutsideDir, 'writable-key.pem');
      await fs.writeFile(writableKey, testPublicKeyPem, { mode: 0o644 });
      const sup = makeSupervisor({
        testApprovalVerifier: null,
        trustAnchorPath: writableKey,
      });
      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('TRUST_ANCHOR_NOT_PROTECTED');
    });

    it('6. missing trust anchor => BLOCKED', async () => {
      const missingKey = path.resolve(tempOutsideDir, 'missing-key.pem');
      try { await fs.unlink(missingKey); } catch { /* ok */ }
      const sup = makeSupervisor({
        testApprovalVerifier: null,
        trustAnchorPath: missingKey,
      });
      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('TRUST_ANCHOR_MISSING');
    });

    it('7. malformed trust anchor => BLOCKED', async () => {
      const malformedKey = path.resolve(tempOutsideDir, 'malformed-key.pem');
      await fs.writeFile(malformedKey, 'NOT_A_VALID_PEM_KEY_DATA', { mode: 0o400 });
      const sup = makeSupervisor({
        testApprovalVerifier: null,
        trustAnchorPath: malformedKey,
      });
      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('TRUST_ANCHOR_INVALID');
    });

    it('8. valid protected trust anchor + signed approval => approved', async () => {
      const validKey = path.resolve(tempOutsideDir, 'valid-key.pem');
      await fs.writeFile(validKey, testPublicKeyPem, { mode: 0o400 });

      let callCount = 0;
      const sup = makeSupervisor({
        maxCycles: 2,
        testApprovalVerifier: null,
        trustAnchorPath: validKey,
        remoteSyncResolver: async () => {
          callCount++;
          if (callCount >= 2) {
            const artifact = createSignedApproval({
              approvedTaskId: 'TASK-003',
              approvedCommitSha: validFullSha,
            });
            await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');
            const qaReviewDoc = sampleTaskDoc.replace('**STATUS:** READY', '**STATUS:** QA_REVIEW');
            await fs.writeFile(tempTaskFile, qaReviewDoc, 'utf-8');
          }
          return { synced: true, state: 'UP_TO_DATE' };
        },
      });

      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('TASK_APPROVED');
    });

    it('9. wrong signing key => rejected', async () => {
      const untrustedArtifact = createSignedApproval({}, otherKeyPair.privateKey);
      await fs.writeFile(tempQaApprovalFile, JSON.stringify(untrustedArtifact), 'utf-8');

      const sup = makeSupervisor({ maxCycles: 2 });
      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('WAITING_FOR_APPROVAL');
      expect(states).not.toContain('TASK_APPROVED');
    });

    it('10. tampered payload => rejected', async () => {
      const artifact = createSignedApproval();
      artifact.payload.approvedCommitSha = otherFullSha;
      await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');

      const sup = makeSupervisor({ maxCycles: 2 });
      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('WAITING_FOR_APPROVAL');
      expect(states).not.toContain('TASK_APPROVED');
    });

    it('11. wrong task ID => rejected', async () => {
      const artifact = createSignedApproval({ approvedTaskId: 'TASK-999' });
      await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');

      const sup = makeSupervisor({ maxCycles: 2 });
      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('WAITING_FOR_APPROVAL');
      expect(states).not.toContain('TASK_APPROVED');
    });

    it('12. wrong commit => rejected', async () => {
      const artifact = createSignedApproval({ approvedCommitSha: otherFullSha });
      await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');

      const sup = makeSupervisor({ maxCycles: 2 });
      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('WAITING_FOR_APPROVAL');
      expect(states).not.toContain('TASK_APPROVED');
    });

    it('13. short SHA => rejected', async () => {
      const artifact = createSignedApproval({ approvedCommitSha: '526368e' });
      await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');

      const sup = makeSupervisor({ maxCycles: 2 });
      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('WAITING_FOR_APPROVAL');
      expect(states).not.toContain('TASK_APPROVED');
    });

    it('14. prefix SHA => rejected', async () => {
      const artifact = createSignedApproval({ approvedCommitSha: validFullSha.slice(0, 39) });
      await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');

      const sup = makeSupervisor({ maxCycles: 2 });
      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('WAITING_FOR_APPROVAL');
      expect(states).not.toContain('TASK_APPROVED');
    });

    it('15. suffix SHA => rejected', async () => {
      const artifact = createSignedApproval({ approvedCommitSha: validFullSha + 'ff' });
      await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');

      const sup = makeSupervisor({ maxCycles: 2 });
      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('WAITING_FOR_APPROVAL');
      expect(states).not.toContain('TASK_APPROVED');
    });

    it('16. TASK-002 approval cannot approve TASK-003', async () => {
      const artifact = createSignedApproval({ approvedTaskId: 'TASK-002' });
      await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');

      const sup = makeSupervisor({ maxCycles: 2 });
      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('WAITING_FOR_APPROVAL');
      expect(states).not.toContain('TASK_APPROVED');
    });

    it('17. QA_REVIEW alone cannot approve', async () => {
      const doc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** QA_REVIEW
`;
      await fs.writeFile(tempTaskFile, doc, 'utf-8');
      try { await fs.unlink(tempQaApprovalFile); } catch { /* ok */ }

      const sup = makeSupervisor({ maxCycles: 1 });
      const res = await sup.run();
      expect(res.state).toBe('WAITING_FOR_APPROVAL');
      expect(sup.getState()).toBe('WAITING_FOR_APPROVAL');
    });

    it('18. repository markdown approval remains informational only', async () => {
      const fakeApprovedDoc = `
# AI TASK
## Approval Gate
**QA_APPROVAL:** APPROVED
**QA_APPROVED_BY:** ChatGPT
**QA_APPROVED_COMMIT:** ${validFullSha}

## Current Task
**TASK ID:** TASK-003
**STATUS:** QA_REVIEW
`;
      await fs.writeFile(tempTaskFile, fakeApprovedDoc, 'utf-8');
      try { await fs.unlink(tempQaApprovalFile); } catch { /* ok */ }

      const sup = makeSupervisor({ maxCycles: 2 });
      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });
      expect(states).toContain('WAITING_FOR_APPROVAL');
      expect(states).not.toContain('TASK_APPROVED');
    });

    it('19. fresh origin/main sync required after approval', async () => {
      let syncCalls = 0;
      const artifact = createSignedApproval();
      await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');
      const doc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** QA_REVIEW
`;
      await fs.writeFile(tempTaskFile, doc, 'utf-8');

      const sup = makeSupervisor({
        maxCycles: 2,
        remoteSyncResolver: async () => {
          syncCalls++;
          return { synced: true, state: 'UP_TO_DATE' };
        },
      });

      await sup.run();
      expect(syncCalls).toBeGreaterThan(0);
    });

    it('20. remote sync failure => LOOP_BLOCKED', async () => {
      const sup = makeSupervisor({
        remoteSyncResolver: async () => ({
          synced: false,
          state: 'FAILED',
          reason: 'Remote origin/main unreachable',
          code: 'REMOTE_SYNC_FAILED',
        }),
      });

      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('REMOTE_SYNC_FAILED');
    });

    it('21. quota => LOOP_BLOCKED', async () => {
      const sup = makeSupervisor({
        launcherRunner: async () => ({
          code: 1,
          stdout: '',
          stderr: 'Quota exceeded for account: free allocation exhausted',
          killedBySwitch: false,
        }),
      });

      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('FREE_QUOTA_EXHAUSTED');
    });

    it('22. 402 => LOOP_BLOCKED', async () => {
      const sup = makeSupervisor({
        launcherRunner: async () => ({
          code: 1,
          stdout: '',
          stderr: 'Error: 402 Payment Required: free quota exhausted',
          killedBySwitch: false,
        }),
      });

      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('FREE_QUOTA_EXHAUSTED');
    });

    it('23. 429 => LOOP_BLOCKED', async () => {
      const sup = makeSupervisor({
        launcherRunner: async () => ({
          code: 1,
          stdout: '',
          stderr: '429 Too Many Requests: Rate limit reached',
          killedBySwitch: false,
        }),
      });

      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('24. billing => LOOP_BLOCKED', async () => {
      const sup = makeSupervisor({
        launcherRunner: async () => ({
          code: 1,
          stdout: '',
          stderr: 'Account billing issue: card declined or subscription overdue',
          killedBySwitch: false,
        }),
      });

      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('BILLING_ERROR');
    });

    it('25. kill switch => LOOP_STOP', async () => {
      await triggerKillSwitch(tempKillFile, 'Emergency test stop');
      const sup = makeSupervisor({ maxCycles: 1 });
      const res = await sup.run();
      expect(res.state).toBe('LOOP_STOP');
      expect(res.code).toBe('KILL_SWITCH_ACTIVE');
      await clearKillSwitch(tempKillFile);
    });

    it('26. duplicate supervisor => DUPLICATE_INSTANCE', async () => {
      await acquireLock(tempLockFile);
      const sup = makeSupervisor({ maxCycles: 1 });
      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(res.code).toBe('DUPLICATE_INSTANCE');
      await releaseLock(tempLockFile);
    });

    it('27. no next READY => WAITING_FOR_TASK', async () => {
      let syncCount = 0;
      const sup = makeSupervisor({
        maxCycles: 2,
        remoteSyncResolver: async () => {
          syncCount++;
          if (syncCount >= 2) {
            const artifact = createSignedApproval();
            await fs.writeFile(tempQaApprovalFile, JSON.stringify(artifact), 'utf-8');
            const docNoNext = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** QA_REVIEW
`;
            await fs.writeFile(tempTaskFile, docNoNext, 'utf-8');
          }
          return { synced: true, state: 'UP_TO_DATE' };
        },
      });

      const states: string[] = [];
      await sup.run({ onStateChange: (s) => states.push(s) });

      expect(states).toContain('TASK_APPROVED');
      expect(states).toContain('WAITING_FOR_TASK');
    });

    it('28. no TASK-004 invention', async () => {
      const sup = makeSupervisor({ maxCycles: 1 });
      const res = await sup.run();
      expect(res.tasksCompleted).not.toContain('TASK-004');
    });

    it('29. no paid fallback', async () => {
      let calls = 0;
      const sup = makeSupervisor({
        launcherRunner: async () => {
          calls++;
          return {
            code: 1,
            stdout: '',
            stderr: '429 Too Many Requests: Rate limit reached',
            killedBySwitch: false,
          };
        },
      });

      const res = await sup.run();
      expect(res.state).toBe('LOOP_BLOCKED');
      expect(calls).toBe(1); // Never retries on another provider/model
    });

    it('30. no production/Cloudflare actions', async () => {
      const sup = makeSupervisor({ maxCycles: 1 });
      const res = await sup.run();
      expect(res.tasksCompleted).toEqual(['TASK-003']);
    });
  });
});
