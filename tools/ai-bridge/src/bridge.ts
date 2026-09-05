import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  BridgeConfig,
  BridgeExecutionResult,
  TaskDefinition,
  HandoffState,
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
  DEFAULT_LAUNCHER_NAME,
  DEFAULT_FREE_MODEL,
  APPROVED_FREE_MODELS,
  DEFAULT_POLL_INTERVAL_MS,
} from './constants.ts';
import { readCurrentTask, writeTaskStatus } from './task-parser.ts';
import {
  validateRepository,
  validateBranch,
  validateModel,
  resolveLauncherAdapter,
  detectQuotaOrBillingError,
  detectHumanOnlyAction,
} from './safety.ts';
import { isKillSwitchActive, isKillSwitchActiveSync } from './kill-switch.ts';
import { appendAuditLog } from './audit-logger.ts';
import { getGitContext, type GitContext } from './git-utils.ts';
import { acquireLock, releaseLock, releaseLockSync } from './lock.ts';

const execFileAsync = promisify(execFile);

export interface BridgeOptions {
  cwd?: string;
  config?: Partial<BridgeConfig>;
  model?: string;
  gitContextResolver?: (cwd: string) => Promise<GitContext>;
  testRunner?: (cwd: string) => Promise<{ ok: boolean; output: string }>;
}

/**
 * Resolves the full BridgeConfig from options, applying defaults.
 */
function resolveConfig(options: BridgeOptions): BridgeConfig {
  const cwd = options.cwd || process.cwd();
  return {
    repoAllowlist: options.config?.repoAllowlist || [...ALLOWED_REPOSITORIES],
    branchAllowlist: options.config?.branchAllowlist || [...ALLOWED_BRANCHES],
    taskFilePath: options.config?.taskFilePath || path.resolve(cwd, DEFAULT_TASK_FILE),
    reportFilePath: options.config?.reportFilePath || path.resolve(cwd, DEFAULT_REPORT_FILE),
    handoffFilePath: options.config?.handoffFilePath || path.resolve(cwd, DEFAULT_HANDOFF_FILE),
    auditLogPath: options.config?.auditLogPath || path.resolve(cwd, DEFAULT_AUDIT_LOG_FILE),
    killSwitchFilePath: options.config?.killSwitchFilePath || path.resolve(cwd, DEFAULT_KILL_SWITCH_FILE),
    lockFilePath: options.config?.lockFilePath || path.resolve(cwd, DEFAULT_LOCK_FILE),
    freeModelAllowlist: options.config?.freeModelAllowlist || [...APPROVED_FREE_MODELS],
    launcherName: options.config?.launcherName || DEFAULT_LAUNCHER_NAME,
    dryRun: options.config?.dryRun ?? false,
    watchMode: options.config?.watchMode ?? false,
    pollIntervalMs: options.config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  };
}

export class AIBridge {
  private cwd: string;
  private config: BridgeConfig;
  private model: string;
  private resolveGitContext: (cwd: string) => Promise<GitContext>;
  private runTests: (cwd: string) => Promise<{ ok: boolean; output: string }>;
  private _stopped = false;

  constructor(options: BridgeOptions = {}) {
    this.cwd = options.cwd || process.cwd();
    this.model = options.model || DEFAULT_FREE_MODEL;
    this.config = resolveConfig(options);
    this.resolveGitContext = options.gitContextResolver || getGitContext;
    this.runTests = options.testRunner || this.defaultTestRunner.bind(this);
  }

  private async defaultTestRunner(cwd: string): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout: testOut, stderr: testErr } = await execFileAsync('npm', ['test'], { cwd });
      const { stdout: typeOut, stderr: typeErr } = await execFileAsync('npm', ['run', 'typecheck'], { cwd });
      return { ok: true, output: `${testOut}${testErr}\n${typeOut}${typeErr}` };
    } catch (err: unknown) {
      const e = err as { message: string; stdout?: string; stderr?: string };
      return {
        ok: false,
        output: `${e.stdout || ''}\n${e.stderr || ''}\n${e.message}`,
      };
    }
  }

  /**
   * Signal graceful stop (used by SIGINT/SIGTERM handlers in watch mode).
   */
  public stop(): void {
    this._stopped = true;
  }

  /**
   * Evaluates all preconditions before executing a task.
   */
  public async checkPreconditions(): Promise<{
    allowed: boolean;
    task?: TaskDefinition;
    gitContext?: GitContext;
    reason?: string;
    code?: string;
  }> {
    // 1. Kill switch
    const killSwitch = await isKillSwitchActive(this.config.killSwitchFilePath);
    if (killSwitch.active) {
      return { allowed: false, reason: `Kill switch active: ${killSwitch.reason}`, code: 'KILL_SWITCH_ACTIVE' };
    }

    // 2. Git remote & branch
    const git = await this.resolveGitContext(this.cwd);
    const repoCheck = validateRepository(git.remoteUrl);
    if (!repoCheck.allowed) {
      return { allowed: false, gitContext: git, reason: repoCheck.reason, code: repoCheck.code };
    }
    const branchCheck = validateBranch(git.branch);
    if (!branchCheck.allowed) {
      return { allowed: false, gitContext: git, reason: branchCheck.reason, code: branchCheck.code };
    }

    // 3. Free-only explicit model allowlist
    const modelCheck = validateModel(this.model, this.config.freeModelAllowlist);
    if (!modelCheck.allowed) {
      return { allowed: false, gitContext: git, reason: modelCheck.reason, code: modelCheck.code };
    }

    // 4. Launcher adapter must be in explicit allowlist
    const launcherResolution = resolveLauncherAdapter(this.config.launcherName);
    if (!launcherResolution.adapter) {
      return {
        allowed: false,
        gitContext: git,
        reason: launcherResolution.error,
        code: launcherResolution.code,
      };
    }

    // 5. Single approved task
    const taskResult = await readCurrentTask(this.config.taskFilePath);
    if (!taskResult.ok || !taskResult.task) {
      return {
        allowed: false,
        gitContext: git,
        reason: taskResult.error || 'No valid task found',
        code: taskResult.code || 'TASK_NOT_FOUND',
      };
    }

    const task = taskResult.task;

    // 6. Task status must be READY
    if (task.status !== 'READY') {
      return {
        allowed: false,
        task,
        gitContext: git,
        reason: `Task ${task.id} status is "${task.status}". Bridge only consumes tasks with STATUS: READY.`,
        code: 'INVALID_TASK_STATE',
      };
    }

    // 7. Human-only action scan
    const taskTextToScan = `${task.title}\n${task.objective}\n${task.requiredWork.join('\n')}\n${task.hardConstraints.join('\n')}`;
    const humanOnlyCheck = detectHumanOnlyAction(taskTextToScan);
    if (!humanOnlyCheck.allowed) {
      return { allowed: false, task, gitContext: git, reason: humanOnlyCheck.reason, code: humanOnlyCheck.code };
    }

    return { allowed: true, task, gitContext: git };
  }

  /**
   * Spawns the developer launcher as a child process.
   * Monitors the kill switch while the child runs.
   * Terminates the child immediately if the kill switch is activated.
   * Returns combined output and exit code.
   */
  private async spawnWithKillSwitchMonitor(
    launcherName: string,
    extraArgs: string[],
    cwd: string
  ): Promise<{ code: number; stdout: string; stderr: string; killedBySwitch: boolean }> {
    const { adapter } = resolveLauncherAdapter(launcherName);
    // Adapter is guaranteed to exist at this point (validated in checkPreconditions)
    const binary = adapter!.binary;
    const args = [...adapter!.prefixArgs, '--model', this.model, ...extraArgs];

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killedBySwitch = false;

      const child = spawn(binary, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Poll kill switch while child is running (every 1 second)
      const killPollInterval = setInterval(() => {
        const ks = isKillSwitchActiveSync(this.config.killSwitchFilePath);
        if (ks.active && !killedBySwitch) {
          killedBySwitch = true;
          clearInterval(killPollInterval);
          try {
            // Send SIGTERM first, then SIGKILL if it doesn't die
            child.kill('SIGTERM');
            setTimeout(() => {
              try {
                if (!child.killed) {
                  child.kill('SIGKILL');
                }
              } catch {
                // Process may already be gone
              }
            }, 2000);
          } catch {
            // Child may already be gone
          }
        }
      }, 1000);

      child.on('error', (err) => {
        clearInterval(killPollInterval);
        stderr += `\nProcess error: ${err.message}`;
        resolve({ code: 1, stdout, stderr, killedBySwitch });
      });

      child.on('close', (exitCode) => {
        clearInterval(killPollInterval);
        resolve({
          code: killedBySwitch ? 130 : (exitCode ?? 1),
          stdout,
          stderr,
          killedBySwitch,
        });
      });
    });
  }

  /**
   * Runs one single-task bridge execution cycle.
   */
  public async run(): Promise<BridgeExecutionResult> {
    const preconditions = await this.checkPreconditions();

    if (!preconditions.allowed) {
      const code = (preconditions.code || 'SAFETY_VIOLATION') as any;
      const stopReason = preconditions.reason || 'Precondition check failed';

      await appendAuditLog(
        {
          timestamp: new Date().toISOString(),
          eventType: 'SAFETY_VIOLATION',
          taskId: preconditions.task?.id,
          status: preconditions.task?.status,
          stopReason,
          code,
          model: this.model,
          commitSha: preconditions.gitContext?.commitSha,
        },
        this.config.auditLogPath
      );

      if (code === 'HUMAN_ONLY_ACTION' && preconditions.task) {
        await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
        await appendAuditLog(
          { timestamp: new Date().toISOString(), eventType: 'TASK_BLOCKED', taskId: preconditions.task.id, status: 'BLOCKED', stopReason, code },
          this.config.auditLogPath
        );
      }

      return {
        success: false,
        taskId: preconditions.task?.id || 'UNKNOWN',
        initialStatus: preconditions.task?.status || 'READY',
        finalStatus: code === 'HUMAN_ONLY_ACTION' ? 'BLOCKED' : (preconditions.task?.status || 'READY'),
        commitSha: preconditions.gitContext?.commitSha,
        stopReason,
        code,
        dryRun: this.config.dryRun,
      };
    }

    const task = preconditions.task!;
    const git = preconditions.gitContext!;

    // DRY RUN MODE — no state changes, no process spawns
    if (this.config.dryRun) {
      await appendAuditLog(
        {
          timestamp: new Date().toISOString(),
          eventType: 'DRY_RUN',
          taskId: task.id,
          status: task.status,
          model: this.model,
          commitSha: git.commitSha,
          metadata: { title: task.title, launcher: this.config.launcherName },
        },
        this.config.auditLogPath
      );
      return {
        success: true,
        taskId: task.id,
        initialStatus: task.status,
        finalStatus: task.status,
        commitSha: git.commitSha,
        dryRun: true,
      };
    }

    // LIVE EXECUTION
    await appendAuditLog(
      { timestamp: new Date().toISOString(), eventType: 'TASK_START', taskId: task.id, status: 'IMPLEMENTING', model: this.model, commitSha: git.commitSha },
      this.config.auditLogPath
    );
    await writeTaskStatus(this.config.taskFilePath, 'IMPLEMENTING');

    // Spawn launcher with kill-switch monitoring
    const launcherResult = await this.spawnWithKillSwitchMonitor(
      this.config.launcherName,
      [],
      this.cwd
    );

    // If the child was killed by our kill switch, transition to BLOCKED
    if (launcherResult.killedBySwitch) {
      await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
      await appendAuditLog(
        {
          timestamp: new Date().toISOString(),
          eventType: 'KILL_SWITCH_ACTIVE',
          taskId: task.id,
          status: 'BLOCKED',
          stopReason: 'Child process terminated by kill switch while running',
          code: 'KILL_SWITCH_ACTIVE',
          model: this.model,
          commitSha: git.commitSha,
        },
        this.config.auditLogPath
      );
      await appendAuditLog(
        { timestamp: new Date().toISOString(), eventType: 'CHILD_KILLED', taskId: task.id, status: 'BLOCKED' },
        this.config.auditLogPath
      );
      return {
        success: false,
        taskId: task.id,
        initialStatus: task.status,
        finalStatus: 'BLOCKED',
        commitSha: git.commitSha,
        stopReason: 'Kill switch activated while child process was running',
        code: 'KILL_SWITCH_ACTIVE',
        dryRun: false,
      };
    }

    const combinedOutput = `${launcherResult.stdout}\n${launcherResult.stderr}`;

    // Quota / billing scan on child output
    const quotaCheck = detectQuotaOrBillingError(combinedOutput);
    if (!quotaCheck.allowed) {
      await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
      await appendAuditLog(
        { timestamp: new Date().toISOString(), eventType: 'TASK_BLOCKED', taskId: task.id, status: 'BLOCKED', stopReason: quotaCheck.reason, code: quotaCheck.code, model: this.model, commitSha: git.commitSha },
        this.config.auditLogPath
      );
      return {
        success: false,
        taskId: task.id,
        initialStatus: task.status,
        finalStatus: 'BLOCKED',
        commitSha: git.commitSha,
        stopReason: quotaCheck.reason,
        code: quotaCheck.code,
        dryRun: false,
      };
    }

    // Run verification tests
    await writeTaskStatus(this.config.taskFilePath, 'TESTING');
    const testResult = await this.runTests(this.cwd);

    if (!testResult.ok) {
      await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
      await appendAuditLog(
        { timestamp: new Date().toISOString(), eventType: 'TASK_STOP', taskId: task.id, status: 'BLOCKED', stopReason: 'Verification tests failed. Refusing to transition to QA_REVIEW.', code: 'TESTS_FAILED', model: this.model, commitSha: git.commitSha },
        this.config.auditLogPath
      );
      return {
        success: false,
        taskId: task.id,
        initialStatus: task.status,
        finalStatus: 'BLOCKED',
        commitSha: git.commitSha,
        stopReason: 'Verification tests failed',
        code: 'TESTS_FAILED',
        dryRun: false,
      };
    }

    // Transition to QA_REVIEW — the bridge stops here and waits for external QA
    await writeTaskStatus(this.config.taskFilePath, 'QA_REVIEW');
    const updatedGit = await this.resolveGitContext(this.cwd);
    await appendAuditLog(
      { timestamp: new Date().toISOString(), eventType: 'TASK_COMPLETE', taskId: task.id, status: 'QA_REVIEW', model: this.model, commitSha: updatedGit.commitSha || git.commitSha },
      this.config.auditLogPath
    );

    return {
      success: true,
      taskId: task.id,
      initialStatus: task.status,
      finalStatus: 'QA_REVIEW',
      commitSha: updatedGit.commitSha || git.commitSha,
      dryRun: false,
    };
  }

  /**
   * Watch mode: periodically polls docs/AI_TASK.md.
   * When it finds STATUS: READY, executes exactly one task, transitions to QA_REVIEW, then stops.
   * Does NOT auto-approve or auto-chain to TASK-003.
   * Respects kill switch, lock, and graceful shutdown signals.
   */
  public async watch(
    onTick?: (status: string) => void,
    onResult?: (result: BridgeExecutionResult) => void
  ): Promise<void> {
    // Acquire single-instance lock
    const lockResult = await acquireLock(this.config.lockFilePath);
    if (!lockResult.acquired) {
      await appendAuditLog(
        {
          timestamp: new Date().toISOString(),
          eventType: 'DUPLICATE_INSTANCE',
          stopReason: `Another bridge instance is already running (PID: ${lockResult.existingPid ?? 'unknown'})`,
          code: 'DUPLICATE_INSTANCE',
        },
        this.config.auditLogPath
      );
      throw new Error(
        `DUPLICATE_INSTANCE: Another bridge instance is already running (PID: ${lockResult.existingPid ?? 'unknown'}). Exiting.`
      );
    }

    // Register cleanup for lock on process exit
    const cleanupLock = () => releaseLockSync(this.config.lockFilePath);
    process.on('exit', cleanupLock);

    await appendAuditLog(
      { timestamp: new Date().toISOString(), eventType: 'WATCH_START', metadata: { pollIntervalMs: this.config.pollIntervalMs, launcher: this.config.launcherName, model: this.model } },
      this.config.auditLogPath
    );

    try {
      while (!this._stopped) {
        // Check kill switch at every tick
        const ks = await isKillSwitchActive(this.config.killSwitchFilePath);
        if (ks.active) {
          await appendAuditLog(
            { timestamp: new Date().toISOString(), eventType: 'KILL_SWITCH_ACTIVE', stopReason: ks.reason, code: 'KILL_SWITCH_ACTIVE' },
            this.config.auditLogPath
          );
          onTick?.(`STOPPED: Kill switch active — ${ks.reason}`);
          break;
        }

        // Read task status
        const taskResult = await readCurrentTask(this.config.taskFilePath);
        const taskStatus = taskResult.ok ? taskResult.task?.status : 'ERROR';

        await appendAuditLog(
          { timestamp: new Date().toISOString(), eventType: 'WATCH_TICK', metadata: { taskId: taskResult.task?.id, taskStatus } },
          this.config.auditLogPath
        );

        onTick?.(`WATCH: Task ${taskResult.task?.id ?? 'unknown'} STATUS=${taskStatus}`);

        if (taskResult.ok && taskResult.task?.status === 'READY') {
          // Execute the single ready task
          const result = await this.run();
          onResult?.(result);

          if (result.finalStatus === 'QA_REVIEW') {
            // Success: transition to QA_REVIEW. Stop watch — wait for external QA.
            // DO NOT auto-approve. DO NOT auto-chain to TASK-003.
            await appendAuditLog(
              { timestamp: new Date().toISOString(), eventType: 'WATCH_STOP', stopReason: 'Task transitioned to QA_REVIEW. Waiting for external QA gate. Bridge stopped.', taskId: result.taskId },
              this.config.auditLogPath
            );
            onTick?.(`WATCH_STOP: Task ${result.taskId} is QA_REVIEW. Waiting for ChatGPT QA. No automatic chaining.`);
            break;
          }

          if (result.finalStatus === 'BLOCKED') {
            // A blocking error: stop and let the human review.
            await appendAuditLog(
              { timestamp: new Date().toISOString(), eventType: 'WATCH_STOP', stopReason: `Task BLOCKED: ${result.stopReason}`, code: result.code },
              this.config.auditLogPath
            );
            onTick?.(`WATCH_STOP: Task ${result.taskId} BLOCKED — ${result.stopReason}`);
            break;
          }

          if (result.dryRun) {
            // Dry-run completed one simulation cycle — stop the watch.
            await appendAuditLog(
              { timestamp: new Date().toISOString(), eventType: 'WATCH_STOP', stopReason: 'Dry-run cycle complete. No live changes made.' },
              this.config.auditLogPath
            );
            onTick?.(`WATCH_STOP: Dry-run complete. No state changes.`);
            break;
          }
        }

        // Wait before next poll (with break-out check for _stopped)
        await this.sleep(this.config.pollIntervalMs);
      }
    } finally {
      await releaseLock(this.config.lockFilePath);
      process.off('exit', cleanupLock);

      await appendAuditLog(
        { timestamp: new Date().toISOString(), eventType: 'WATCH_STOP', stopReason: this._stopped ? 'Graceful shutdown requested' : 'Watch loop exited' },
        this.config.auditLogPath
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(); }
      }, ms);
      // Check _stopped every 100ms for early break
      const check = setInterval(() => {
        if (this._stopped && !resolved) {
          resolved = true;
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 100);
      // Ensure the interval is always cleared when timer fires
      timer.unref?.();
    });
  }
}
