/**
 * Phase C Autonomous Task Loop Supervisor
 *
 * Coordinates continuous, unattended execution between ChatGPT (Technical Lead / QA)
 * and local developer environments (Antigravity and Claude Code).
 *
 * Key safety invariants:
 * - GitHub origin/main is authoritative.
 * - QA_REVIEW is NOT approval.
 * - Explicit durable ChatGPT approval on origin/main is required before next task.
 * - No task invention (never creates TASK-004 or synthetic work).
 * - Zero-cost constitution: MAX_ALLOWED_COST = 0, ALLOW_PAID_API = false.
 * - Quota/billing/overage exhaustion = immediate hard stop (LOOP_BLOCKED).
 * - External human operator trust boundary is strictly enforced.
 * - Single-instance lock held throughout supervisor lifetime.
 * - Kill-switch immediately terminates active child process and supervisor.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  BridgeConfig,
  BridgeExecutionResult,
  TaskDefinition,
  HandoffState,
  SafetyErrorCode,
  SupervisorState,
  ApprovalSignal,
} from './types.ts';
import {
  ALLOWED_REPOSITORIES,
  ALLOWED_BRANCHES,
  DEFAULT_TASK_FILE,
  DEFAULT_REPORT_FILE,
  DEFAULT_HANDOFF_FILE,
  DEFAULT_AUDIT_LOG_FILE,
  DEFAULT_KILL_SWITCH_FILE,
  DEFAULT_LOCK_FILE,
  DEFAULT_OPERATOR_ZERO_OVERAGE_FILE,
  DEFAULT_ANTIGRAVITY_SETTINGS_FILE,
  DEFAULT_LAUNCHER_NAME,
  DEFAULT_SUPERVISOR_POLL_INTERVAL_MS,
  DEFAULT_REMOTE_NAME,
  DEFAULT_REMOTE_BRANCH,
  APPROVED_PROVIDERS,
  QUOTA_ERROR_PATTERNS,
} from './constants.ts';
import {
  readCurrentTask,
  parseApprovalSignal,
  discoverNextTask,
  checkExternalQAApproval,
  type ExternalApprovalOptions,
  type ExternalApprovalResult,
} from './task-parser.ts';
import {
  validateRepository,
  validateBranch,
} from './safety.ts';
import { isKillSwitchActive, isKillSwitchActiveSync } from './kill-switch.ts';
import { appendAuditLog } from './audit-logger.ts';
import {
  getGitContext,
  syncRemoteTask,
  type GitContext,
  type GitSyncResult,
} from './git-utils.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { AIBridge, type BridgeOptions } from './bridge.ts';
import { DEFAULT_EXTERNAL_QA_APPROVAL_FILE } from './constants.ts';

export interface SupervisorOptions {
  cwd?: string;
  config?: Partial<BridgeConfig>;
  model?: string;
  bridge?: AIBridge;
  gitContextResolver?: (cwd: string) => Promise<GitContext>;
  testRunner?: (cwd: string) => Promise<{ ok: boolean; output: string }>;
  remoteSyncResolver?: (cwd: string, taskPath: string) => Promise<GitSyncResult>;
  agyInterfaceVerifier?: (cwd: string) => Promise<{ ok: boolean; reason?: string; code?: SafetyErrorCode }>;
  agyModelsGetter?: (cwd: string) => Promise<{ ok: boolean; models: string[]; rawOutput?: string; error?: string }>;
  launcherRunner?: (
    adapter: any,
    selectedModel: string,
    task: TaskDefinition,
    cwd: string,
    extraArgs?: string[]
  ) => Promise<{ code: number; stdout: string; stderr: string; killedBySwitch: boolean }>;
  qaApprovalResolver?: (
    options: ExternalApprovalOptions
  ) => Promise<ExternalApprovalResult> | ExternalApprovalResult;
  maxCycles?: number;
  pollIntervalMs?: number;
}

export interface SupervisorResult {
  state: SupervisorState;
  cyclesCompleted: number;
  tasksCompleted: string[];
  stopReason?: string;
  code?: SafetyErrorCode | string;
}

export class AutonomousSupervisor {
  private cwd: string;
  private config: BridgeConfig;
  private state: SupervisorState = 'LOOP_START';
  private _stopped = false;
  private cyclesCompleted = 0;
  private tasksCompleted: string[] = [];
  private lastCompletedTaskId?: string;
  private lastCompletedCommitSha?: string;
  private maxCycles?: number;
  private stopReason?: string;
  private failureCode?: SafetyErrorCode | string;
  private onStateChangeCallback?: (state: SupervisorState) => void;

  private bridge: AIBridge;
  private resolveGitContext: (cwd: string) => Promise<GitContext>;
  private runRemoteSync: (cwd: string, taskPath: string) => Promise<GitSyncResult>;
  private resolveQAApproval: (
    options: ExternalApprovalOptions
  ) => Promise<ExternalApprovalResult> | ExternalApprovalResult;

  constructor(options: SupervisorOptions = {}) {
    this.cwd = options.cwd || process.cwd();
    const pollInterval =
      options.pollIntervalMs ??
      options.config?.pollIntervalMs ??
      DEFAULT_SUPERVISOR_POLL_INTERVAL_MS;

    this.config = {
      repoAllowlist: options.config?.repoAllowlist || [...ALLOWED_REPOSITORIES],
      branchAllowlist: options.config?.branchAllowlist || [...ALLOWED_BRANCHES],
      taskFilePath: options.config?.taskFilePath || path.resolve(this.cwd, DEFAULT_TASK_FILE),
      reportFilePath: options.config?.reportFilePath || path.resolve(this.cwd, DEFAULT_REPORT_FILE),
      handoffFilePath: options.config?.handoffFilePath || path.resolve(this.cwd, DEFAULT_HANDOFF_FILE),
      auditLogPath: options.config?.auditLogPath || path.resolve(this.cwd, DEFAULT_AUDIT_LOG_FILE),
      killSwitchFilePath: options.config?.killSwitchFilePath || path.resolve(this.cwd, DEFAULT_KILL_SWITCH_FILE),
      lockFilePath: options.config?.lockFilePath || path.resolve(this.cwd, DEFAULT_LOCK_FILE),
      operatorVerificationFilePath:
        options.config?.operatorVerificationFilePath ||
        options.config?.zeroOverageVerificationFilePath ||
        DEFAULT_OPERATOR_ZERO_OVERAGE_FILE,
      qaApprovalFilePath:
        options.config?.qaApprovalFilePath ||
        DEFAULT_EXTERNAL_QA_APPROVAL_FILE,
      antigravitySettingsPath:
        options.config?.antigravitySettingsPath ||
        DEFAULT_ANTIGRAVITY_SETTINGS_FILE,
      launcherName: options.config?.launcherName || DEFAULT_LAUNCHER_NAME,
      model: options.model || options.config?.model,
      dryRun: options.config?.dryRun ?? false,
      watchMode: true,
      pollIntervalMs: pollInterval,
      syncRemote: options.config?.syncRemote ?? true,
      remoteName: options.config?.remoteName || DEFAULT_REMOTE_NAME,
      remoteBranch: options.config?.remoteBranch || DEFAULT_REMOTE_BRANCH,
      allowedProviders: options.config?.allowedProviders || [...APPROVED_PROVIDERS],
    };

    this.maxCycles = options.maxCycles;
    this.resolveGitContext = options.gitContextResolver || getGitContext;
    this.resolveQAApproval = options.qaApprovalResolver || checkExternalQAApproval;
    this.runRemoteSync =
      options.remoteSyncResolver ||
      ((dir, file) =>
        syncRemoteTask({
          cwd: dir,
          taskFilePath: file,
          remote: this.config.remoteName,
          branch: this.config.remoteBranch,
          gitContextResolver: this.resolveGitContext,
        }));

    // Instantiate or reuse bridge
    this.bridge =
      options.bridge ||
      new AIBridge({
        cwd: this.cwd,
        model: this.config.model,
        config: {
          ...this.config,
          syncRemote: false, // AutonomousSupervisor handles authoritative remote sync
        },
        gitContextResolver: this.resolveGitContext,
        testRunner: options.testRunner,
        remoteSyncResolver: this.runRemoteSync,
        agyInterfaceVerifier: options.agyInterfaceVerifier,
        agyModelsGetter: options.agyModelsGetter,
        launcherRunner: options.launcherRunner,
        onStatusTransition: async (status: HandoffState, task: TaskDefinition) => {
          if (status === 'IMPLEMENTING') {
            await this.transitionState('TASK_EXECUTING', {
              taskId: task.id,
              status: 'IMPLEMENTING',
            });
          } else if (status === 'TESTING') {
            await this.transitionState('TASK_TESTING', {
              taskId: task.id,
              status: 'TESTING',
            });
          }
        },
      });
  }

  /**
   * Returns current supervisor lifecycle state.
   */
  public getState(): SupervisorState {
    return this.state;
  }

  /**
   * Signals graceful termination (used by SIGINT/SIGTERM).
   */
  public stop(): void {
    this._stopped = true;
    this.bridge.stop();
  }

  /**
   * Transitions to a new lifecycle state, records audit log entry, and updates internal state.
   */
  private async transitionState(
    newState: SupervisorState,
    details: {
      taskId?: string;
      status?: HandoffState;
      commitSha?: string;
      stopReason?: string;
      code?: SafetyErrorCode | string;
      approvalState?: 'APPROVED' | 'REJECTED' | 'PENDING' | string;
      approvalTaskId?: string;
      approvalCommitSha?: string;
      approvalSource?: string;
      signatureVerification?: string;
      approvalPublicKeyId?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    this.state = newState;
    if (details.stopReason !== undefined) {
      this.stopReason = details.stopReason;
    }
    if (details.code !== undefined) {
      this.failureCode = details.code;
    }
    this.onStateChangeCallback?.(newState);

    await appendAuditLog(
      {
        timestamp: new Date().toISOString(),
        eventType: newState,
        supervisorState: newState,
        taskId: details.taskId,
        status: details.status,
        commitSha: details.commitSha,
        stopReason: details.stopReason,
        code: details.code,
        safetyCode: details.code,
        approvalState: details.approvalState,
        approvalTaskId: details.approvalTaskId,
        approvalCommitSha: details.approvalCommitSha,
        approvalSource: details.approvalSource,
        signatureVerification: details.signatureVerification,
        approvalPublicKeyId: details.approvalPublicKeyId,
        metadata: details.metadata,
      },
      this.config.auditLogPath
    );
  }

  /**
   * Main supervisor execution loop.
   * Runs continuously across multiple approved tasks until explicitly stopped,
   * blocked by safety/quota failure, or maxCycles reached.
   */
  public async run(options: {
    onTick?: (message: string) => void;
    onStateChange?: (state: SupervisorState) => void;
  } = {}): Promise<SupervisorResult> {
    const { onTick, onStateChange } = options;
    this.onStateChangeCallback = onStateChange;

    // Acquire single-instance lock across entire supervisor lifetime
    const lockResult = await acquireLock(this.config.lockFilePath);
    if (!lockResult.acquired) {
      this.stopReason = 'Duplicate supervisor instance blocked';
      this.failureCode = 'DUPLICATE_INSTANCE';
      await appendAuditLog(
        {
          timestamp: new Date().toISOString(),
          eventType: 'DUPLICATE_INSTANCE',
          supervisorState: 'LOOP_BLOCKED',
          stopReason: `Duplicate supervisor instance detected: lock file held at ${this.config.lockFilePath}`,
          code: 'DUPLICATE_INSTANCE',
        },
        this.config.auditLogPath
      );
      this.state = 'LOOP_BLOCKED';
      this.onStateChangeCallback?.(this.state);
      return {
        state: 'LOOP_BLOCKED',
        cyclesCompleted: this.cyclesCompleted,
        tasksCompleted: this.tasksCompleted,
        stopReason: this.stopReason,
        code: this.failureCode,
      };
    }

    // Register process exit handler to ensure lock release
    const cleanupLock = () => {
      try {
        const { releaseLockSync } = require('./lock.ts');
        releaseLockSync(this.config.lockFilePath);
      } catch {
        /* best effort */
      }
    };
    process.once('exit', cleanupLock);

    try {
      await this.transitionState('LOOP_START');
      onTick?.('Phase C Autonomous Task Loop Supervisor started');

      while (!this._stopped) {

        // 1. Check Kill Switch
        const killCheck = await isKillSwitchActive(this.config.killSwitchFilePath);
        if (killCheck.active) {
          await this.transitionState('LOOP_STOP', {
            stopReason: `Kill switch active: ${killCheck.reason}`,
            code: 'KILL_SWITCH_ACTIVE',
          });
          onTick?.(`Kill switch active: ${killCheck.reason}. Halting supervisor.`);
          break;
        }

        // 2. Git Repository and Branch Verification
        const git = await this.resolveGitContext(this.cwd);
        const repoCheck = validateRepository(git.remoteUrl);
        if (!repoCheck.allowed) {
          await this.transitionState('LOOP_BLOCKED', {
            stopReason: repoCheck.reason,
            code: repoCheck.code,
            commitSha: git.commitSha,
          });
          onTick?.(`Repository not allowed: ${repoCheck.reason}. Halting.`);
          break;
        }

        const branchCheck = validateBranch(git.branch);
        if (!branchCheck.allowed) {
          await this.transitionState('LOOP_BLOCKED', {
            stopReason: branchCheck.reason,
            code: branchCheck.code,
            commitSha: git.commitSha,
          });
          onTick?.(`Branch not allowed: ${branchCheck.reason}. Halting.`);
          break;
        }

        // 3. Worktree Safety: Check for uncommitted local changes
        if (!git.isClean) {
          const uncommitted = git.uncommittedFiles.filter(
            (f) =>
              !f.endsWith('.bridge-lock') &&
              !f.endsWith('.bridge-stop') &&
              !f.endsWith('.log')
          );
          if (uncommitted.length > 0) {
            await this.transitionState('LOOP_BLOCKED', {
              stopReason: `LOCAL_CHANGES_PRESENT: Working tree contains uncommitted local changes (${uncommitted.join(', ')}). Execution halted.`,
              code: 'LOCAL_CHANGES_PRESENT',
              commitSha: git.commitSha,
            });
            onTick?.('Uncommitted local changes present. Preserving local work.');
            break;
          }
        }

        // 4. Mandatory Remote Synchronization with origin/main
        if (this.config.syncRemote) {
          const syncResult = await this.runRemoteSync(this.cwd, this.config.taskFilePath);
          if (syncResult.state === 'FAILED' || syncResult.state === 'CONFLICT') {
            await this.transitionState('LOOP_BLOCKED', {
              stopReason: `Mandatory remote synchronization failed: ${syncResult.reason || 'Sync failed'}. Halting.`,
              code: syncResult.code || 'REMOTE_SYNC_FAILED',
              commitSha: git.commitSha,
            });
            onTick?.(`Remote sync failed: ${syncResult.reason}`);
            break;
          }
        }

        // 5. Inspect authoritative task document
        let fileContent: string;
        try {
          fileContent = await fs.readFile(this.config.taskFilePath, 'utf-8');
        } catch (err) {
          await this.transitionState('LOOP_BLOCKED', {
            stopReason: `Failed to read task document: ${err instanceof Error ? err.message : String(err)}`,
            code: 'TASK_NOT_FOUND',
          });
          break;
        }

        const currentTaskRes = await readCurrentTask(this.config.taskFilePath);
        if (!currentTaskRes.ok || !currentTaskRes.task) {
          await this.transitionState('LOOP_BLOCKED', {
            stopReason: currentTaskRes.error || 'No valid task found in authoritative document',
            code: currentTaskRes.code || 'TASK_NOT_FOUND',
          });
          break;
        }

        let currentTask = currentTaskRes.task;

        // 6. Approval Gate Handling: If supervisor is WAITING_FOR_APPROVAL
        if (this.state === 'WAITING_FOR_APPROVAL') {
          // Check external durable ChatGPT approval record outside repository workspace
          const approvalSignal = await this.resolveQAApproval({
            filePath: this.config.qaApprovalFilePath,
            workspaceDir: this.cwd,
            expectedTaskId: this.lastCompletedTaskId,
            expectedCommitSha: this.lastCompletedCommitSha,
          });

          if (!approvalSignal.approved) {
            // Still waiting for approval. Do NOT auto-approve. Do NOT start another task.
            await appendAuditLog(
              {
                timestamp: new Date().toISOString(),
                eventType: 'WAITING_FOR_APPROVAL',
                supervisorState: 'WAITING_FOR_APPROVAL',
                taskId: this.lastCompletedTaskId,
                status: 'QA_REVIEW',
                commitSha: this.lastCompletedCommitSha,
                approvalState: approvalSignal.approvalStatus || 'PENDING',
                approvalTaskId: approvalSignal.approvedTaskId,
                approvalCommitSha: approvalSignal.approvedCommit,
                approvalSource: approvalSignal.approvalSource || 'external_record',
                signatureVerification: approvalSignal.signatureVerification || 'MISSING',
                approvalPublicKeyId: approvalSignal.approvalPublicKeyId,
                code: approvalSignal.code,
                safetyCode: approvalSignal.code,
                metadata: { reason: approvalSignal.reason },
              },
              this.config.auditLogPath
            );
            onTick?.(
              `WAITING_FOR_APPROVAL: Task ${this.lastCompletedTaskId} pending durable external ChatGPT approval (${approvalSignal.reason})`
            );

            this.cyclesCompleted++;
            if (this.maxCycles && this.cyclesCompleted >= this.maxCycles) {
              break;
            }
            await this.sleep(this.config.pollIntervalMs);
            continue;
          }

          // External ChatGPT approval verified!
          await this.transitionState('TASK_APPROVED', {
            taskId: this.lastCompletedTaskId,
            commitSha: this.lastCompletedCommitSha,
            approvalState: 'APPROVED',
            approvalTaskId: approvalSignal.approvedTaskId,
            approvalCommitSha: approvalSignal.approvedCommit,
            approvalSource: approvalSignal.approvalSource,
            signatureVerification: approvalSignal.signatureVerification || 'VALID',
            approvalPublicKeyId: approvalSignal.approvalPublicKeyId,
            metadata: {
              approvedBy: approvalSignal.approvedBy,
              approvedCommit: approvalSignal.approvedCommit,
              approvalSource: approvalSignal.approvalSource,
              signatureVerification: approvalSignal.signatureVerification,
              approvalPublicKeyId: approvalSignal.approvalPublicKeyId,
            },
          });
          onTick?.(
            `TASK_APPROVED: Task ${this.lastCompletedTaskId} approved by ${approvalSignal.approvedBy} for commit ${approvalSignal.approvedCommit}`
          );

          // Authoritative Remote Synchronization with origin/main AGAIN after approval
          if (this.config.syncRemote) {
            const postSyncResult = await this.runRemoteSync(this.cwd, this.config.taskFilePath);
            if (postSyncResult.state === 'FAILED' || postSyncResult.state === 'CONFLICT') {
              await this.transitionState('LOOP_BLOCKED', {
                stopReason: `Mandatory remote synchronization failed after approval: ${postSyncResult.reason || 'Sync failed'}. Halting.`,
                code: postSyncResult.code || 'REMOTE_SYNC_FAILED',
                commitSha: git.commitSha,
              });
              onTick?.(`Remote sync failed after approval: ${postSyncResult.reason}`);
              break;
            }
          }

          // Re-read authoritative task document from origin/main after sync
          try {
            fileContent = await fs.readFile(this.config.taskFilePath, 'utf-8');
          } catch (err) {
            await this.transitionState('LOOP_BLOCKED', {
              stopReason: `Failed to read task document after approval: ${err instanceof Error ? err.message : String(err)}`,
              code: 'TASK_NOT_FOUND',
            });
            break;
          }

          // Discover whether an explicitly-issued next task exists on origin/main
          const nextDiscovery = discoverNextTask(fileContent, this.lastCompletedTaskId);

          if (!nextDiscovery.hasNext || !nextDiscovery.task) {
            // No next READY task explicitly issued yet. Do NOT invent work! Do NOT create TASK-004!
            await this.transitionState('WAITING_FOR_TASK', {
              metadata: {
                reason: nextDiscovery.reason || 'No next task explicitly issued in READY state',
              },
            });
            onTick?.(
              `WAITING_FOR_TASK: ${nextDiscovery.reason || 'No next task issued. Waiting safely.'}`
            );

            this.cyclesCompleted++;
            if (this.maxCycles && this.cyclesCompleted >= this.maxCycles) {
              break;
            }
            await this.sleep(this.config.pollIntervalMs);
            continue;
          }

          // Next task explicitly discovered!
          await this.transitionState('NEXT_TASK_DETECTED', {
            taskId: nextDiscovery.task.id,
            status: nextDiscovery.task.status,
            metadata: { title: nextDiscovery.task.title },
          });
          onTick?.(
            `NEXT_TASK_DETECTED: Explicit task ${nextDiscovery.task.id} (${nextDiscovery.task.title}) detected`
          );

          currentTask = nextDiscovery.task;
          this.lastCompletedTaskId = undefined;
          this.lastCompletedCommitSha = undefined;
          // Fall through to accept and execute this next task
        }

        // 7. Check if task is in READY state
        const isReady =
          currentTask.status === 'READY' ||
          currentTask.status === 'LOCAL READY' ||
          currentTask.status === 'REMOTE READY';

        if (!isReady) {
          // If task is not READY (e.g. QA_REVIEW from a previous cycle, or HOLD, or BLOCKED)
          if (currentTask.status === 'QA_REVIEW' && !this.lastCompletedTaskId) {
            // Document already has QA_REVIEW from prior run: enter WAITING_FOR_APPROVAL
            this.lastCompletedTaskId = currentTask.id;
            this.lastCompletedCommitSha = git.commitSha;
            await this.transitionState('WAITING_FOR_APPROVAL', {
              taskId: currentTask.id,
              status: 'QA_REVIEW',
              commitSha: git.commitSha,
            });
            onTick?.(`Task ${currentTask.id} is in QA_REVIEW. Entering WAITING_FOR_APPROVAL.`);
          } else {
            await this.transitionState('WAITING_FOR_TASK', {
              taskId: currentTask.id,
              status: currentTask.status,
              metadata: {
                reason: `Current task ${currentTask.id} has status ${currentTask.status}, waiting for READY`,
              },
            });
            onTick?.(`WAITING_FOR_TASK: Task ${currentTask.id} has status ${currentTask.status}`);
          }

          this.cyclesCompleted++;
          if (this.maxCycles && this.cyclesCompleted >= this.maxCycles) {
            break;
          }
          await this.sleep(this.config.pollIntervalMs);
          continue;
        }

        // 8. Accept task and execute
        await this.transitionState('TASK_ACCEPTED', {
          taskId: currentTask.id,
          status: currentTask.status,
        });
        onTick?.(`TASK_ACCEPTED: Starting execution of task ${currentTask.id}`);

        // Execute single task via AIBridge
        const execResult: BridgeExecutionResult = await this.bridge.run();

        // 9. Process Execution Results
        if (!execResult.success) {
          // Check for quota/billing errors
          const isQuota =
            execResult.code === 'FREE_QUOTA_EXHAUSTED' ||
            execResult.code === 'RATE_LIMIT_EXCEEDED' ||
            (execResult.stopReason &&
              QUOTA_ERROR_PATTERNS.some((p) => p.test(execResult.stopReason!)));

          const failureCode = isQuota
            ? 'FREE_QUOTA_EXHAUSTED'
            : execResult.code || 'SAFETY_VIOLATION';

          await this.transitionState('LOOP_BLOCKED', {
            taskId: execResult.taskId,
            status: execResult.finalStatus,
            stopReason: execResult.stopReason,
            code: failureCode,
            commitSha: execResult.commitSha,
          });
          onTick?.(
            `LOOP_BLOCKED: Task ${execResult.taskId} failed (${failureCode}): ${execResult.stopReason}`
          );
          break;
        }

        // 10. Handle Successful Execution
        if (execResult.finalStatus === 'QA_REVIEW') {
          this.tasksCompleted.push(execResult.taskId);
          this.lastCompletedTaskId = execResult.taskId;
          this.lastCompletedCommitSha = execResult.commitSha;

          await this.transitionState('TASK_QA_REVIEW', {
            taskId: execResult.taskId,
            status: 'QA_REVIEW',
            commitSha: execResult.commitSha,
          });
          onTick?.(
            `TASK_QA_REVIEW: Task ${execResult.taskId} finished implementation. Commit: ${execResult.commitSha}`
          );

          // Immediately transition to WAITING_FOR_APPROVAL (never self-approve!)
          await this.transitionState('WAITING_FOR_APPROVAL', {
            taskId: execResult.taskId,
            status: 'QA_REVIEW',
            commitSha: execResult.commitSha,
          });
          onTick?.(
            `WAITING_FOR_APPROVAL: Task ${execResult.taskId} waiting for ChatGPT approval on GitHub.`
          );
        } else if (execResult.finalStatus === 'BLOCKED') {
          await this.transitionState('LOOP_BLOCKED', {
            taskId: execResult.taskId,
            status: 'BLOCKED',
            stopReason: execResult.stopReason,
            code: execResult.code,
          });
          onTick?.(`LOOP_BLOCKED: Task ${execResult.taskId} was BLOCKED: ${execResult.stopReason}`);
          break;
        }

        this.cyclesCompleted++;
        if (this.maxCycles && this.cyclesCompleted >= this.maxCycles) {
          break;
        }

        await this.sleep(this.config.pollIntervalMs);
      }
    } finally {
      await releaseLock(this.config.lockFilePath);
      process.off('exit', cleanupLock);

      if (this._stopped && this.state !== 'LOOP_BLOCKED') {
        await this.transitionState('LOOP_STOP', {
          stopReason: 'Graceful supervisor shutdown',
        });
      }
    }

    return {
      state: this.state,
      cyclesCompleted: this.cyclesCompleted,
      tasksCompleted: this.tasksCompleted,
      stopReason: this.stopReason,
      code: this.failureCode,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, ms);
      const check = setInterval(() => {
        if (this._stopped && !resolved) {
          resolved = true;
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
      timer.unref?.();
    });
  }
}
