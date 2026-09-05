import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  BridgeConfig,
  BridgeExecutionResult,
  TaskDefinition,
  HandoffState,
  SafetyCheckResult,
} from './types.ts';
import {
  ALLOWED_REPOSITORIES,
  ALLOWED_BRANCHES,
  DEFAULT_TASK_FILE,
  DEFAULT_REPORT_FILE,
  DEFAULT_HANDOFF_FILE,
  DEFAULT_AUDIT_LOG_FILE,
  DEFAULT_KILL_SWITCH_FILE,
  DEFAULT_LAUNCHER,
  APPROVED_FREE_MODELS,
} from './constants.ts';
import { readCurrentTask, writeTaskStatus } from './task-parser.ts';
import {
  validateRepository,
  validateBranch,
  validateModel,
  detectQuotaOrBillingError,
  detectHumanOnlyAction,
} from './safety.ts';
import { isKillSwitchActive } from './kill-switch.ts';
import { appendAuditLog } from './audit-logger.ts';
import { getGitContext, type GitContext } from './git-utils.ts';

const execFileAsync = promisify(execFile);

export interface BridgeOptions {
  cwd?: string;
  config?: Partial<BridgeConfig>;
  model?: string;
  gitContextResolver?: (cwd: string) => Promise<GitContext>;
  launcherRunner?: (
    command: string,
    args: string[],
    cwd: string
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  testRunner?: (cwd: string) => Promise<{ ok: boolean; output: string }>;
}

export class AIBridge {
  private cwd: string;
  private config: BridgeConfig;
  private model: string;
  private resolveGitContext: (cwd: string) => Promise<GitContext>;
  private runLauncher: (
    command: string,
    args: string[],
    cwd: string
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  private runTests: (cwd: string) => Promise<{ ok: boolean; output: string }>;

  constructor(options: BridgeOptions = {}) {
    this.cwd = options.cwd || process.cwd();
    this.model = options.model || 'nvidia/nemotron-3.5-lightning:free';
    this.config = {
      repoAllowlist: options.config?.repoAllowlist || [...ALLOWED_REPOSITORIES],
      branchAllowlist: options.config?.branchAllowlist || [...ALLOWED_BRANCHES],
      taskFilePath: options.config?.taskFilePath || path.resolve(this.cwd, DEFAULT_TASK_FILE),
      reportFilePath: options.config?.reportFilePath || path.resolve(this.cwd, DEFAULT_REPORT_FILE),
      handoffFilePath: options.config?.handoffFilePath || path.resolve(this.cwd, DEFAULT_HANDOFF_FILE),
      auditLogPath: options.config?.auditLogPath || path.resolve(this.cwd, DEFAULT_AUDIT_LOG_FILE),
      killSwitchFilePath: options.config?.killSwitchFilePath || path.resolve(this.cwd, DEFAULT_KILL_SWITCH_FILE),
      freeModelAllowlist: options.config?.freeModelAllowlist || [...APPROVED_FREE_MODELS],
      launcherCommand: options.config?.launcherCommand || DEFAULT_LAUNCHER,
      dryRun: options.config?.dryRun ?? false,
    };

    this.resolveGitContext = options.gitContextResolver || getGitContext;
    this.runLauncher = options.launcherRunner || this.defaultLauncherRunner;
    this.runTests = options.testRunner || this.defaultTestRunner;
  }

  private async defaultLauncherRunner(
    command: string,
    args: string[],
    cwd: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const parts = command.split(' ');
      const bin = parts[0];
      const cmdArgs = [...parts.slice(1), ...args];
      const { stdout, stderr } = await execFileAsync(bin, cmdArgs, { cwd });
      return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: String(e.stdout || ''),
        stderr: String(e.stderr || e.message || ''),
      };
    }
  }

  private async defaultTestRunner(cwd: string): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout: testOut } = await execFileAsync('npm', ['test'], { cwd });
      const { stdout: typeOut } = await execFileAsync('npm', ['run', 'typecheck'], { cwd });
      return { ok: true, output: `${testOut}\n${typeOut}` };
    } catch (err: unknown) {
      const e = err as { message: string; stdout?: string; stderr?: string };
      return {
        ok: false,
        output: `${e.stdout || ''}\n${e.stderr || ''}\n${e.message}`,
      };
    }
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
    // 1. Check Kill Switch
    const killSwitch = await isKillSwitchActive(this.config.killSwitchFilePath);
    if (killSwitch.active) {
      return {
        allowed: false,
        reason: `Kill switch active: ${killSwitch.reason}`,
        code: 'KILL_SWITCH_ACTIVE',
      };
    }

    // 2. Validate Git remote and branch
    const git = await this.resolveGitContext(this.cwd);
    const repoCheck = validateRepository(git.remoteUrl);
    if (!repoCheck.allowed) {
      return {
        allowed: false,
        gitContext: git,
        reason: repoCheck.reason,
        code: repoCheck.code,
      };
    }

    const branchCheck = validateBranch(git.branch);
    if (!branchCheck.allowed) {
      return {
        allowed: false,
        gitContext: git,
        reason: branchCheck.reason,
        code: branchCheck.code,
      };
    }

    // 3. Validate free-only model
    const modelCheck = validateModel(this.model);
    if (!modelCheck.allowed) {
      return {
        allowed: false,
        gitContext: git,
        reason: modelCheck.reason,
        code: modelCheck.code,
      };
    }

    // 4. Read single approved task
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

    // 5. Check task status
    if (task.status !== 'READY') {
      return {
        allowed: false,
        task,
        gitContext: git,
        reason: `Task ${task.id} status is "${task.status}". Bridge only consumes tasks with STATUS: READY.`,
        code: 'INVALID_TASK_STATE',
      };
    }

    // 6. Check for human-only actions in task definition
    const taskTextToScan = `${task.title} ${task.objective} ${task.requiredWork.join(' ')} ${task.hardConstraints.join(' ')}`;
    const humanOnlyCheck = detectHumanOnlyAction(taskTextToScan);
    if (!humanOnlyCheck.allowed) {
      return {
        allowed: false,
        task,
        gitContext: git,
        reason: humanOnlyCheck.reason,
        code: humanOnlyCheck.code,
      };
    }

    return {
      allowed: true,
      task,
      gitContext: git,
    };
  }

  /**
   * Runs the bridge loop for the single approved task.
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

      // If human-only action detected, set task to BLOCKED in AI_TASK.md
      if (code === 'HUMAN_ONLY_ACTION' && preconditions.task) {
        await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
        await appendAuditLog(
          {
            timestamp: new Date().toISOString(),
            eventType: 'TASK_BLOCKED',
            taskId: preconditions.task.id,
            status: 'BLOCKED',
            stopReason,
            code,
          },
          this.config.auditLogPath
        );
      }

      return {
        success: false,
        taskId: preconditions.task?.id || 'UNKNOWN',
        initialStatus: preconditions.task?.status || 'READY',
        finalStatus: (code === 'HUMAN_ONLY_ACTION' ? 'BLOCKED' : preconditions.task?.status || 'READY'),
        commitSha: preconditions.gitContext?.commitSha,
        stopReason,
        code,
        dryRun: this.config.dryRun,
      };
    }

    const task = preconditions.task!;
    const git = preconditions.gitContext!;

    // DRY RUN MODE
    if (this.config.dryRun) {
      await appendAuditLog(
        {
          timestamp: new Date().toISOString(),
          eventType: 'DRY_RUN',
          taskId: task.id,
          status: task.status,
          model: this.model,
          commitSha: git.commitSha,
          metadata: {
            title: task.title,
            launcher: this.config.launcherCommand,
          },
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
    // Audit task start
    await appendAuditLog(
      {
        timestamp: new Date().toISOString(),
        eventType: 'TASK_START',
        taskId: task.id,
        status: 'IMPLEMENTING',
        model: this.model,
        commitSha: git.commitSha,
      },
      this.config.auditLogPath
    );

    // Update status to IMPLEMENTING
    await writeTaskStatus(this.config.taskFilePath, 'IMPLEMENTING');

    // Run the launcher
    const launcherResult = await this.runLauncher(
      this.config.launcherCommand,
      ['--model', this.model],
      this.cwd
    );

    const combinedOutput = `${launcherResult.stdout}\n${launcherResult.stderr}`;

    // Check for quota / billing errors in launcher output
    const quotaCheck = detectQuotaOrBillingError(combinedOutput);
    if (!quotaCheck.allowed) {
      await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
      await appendAuditLog(
        {
          timestamp: new Date().toISOString(),
          eventType: 'TASK_BLOCKED',
          taskId: task.id,
          status: 'BLOCKED',
          stopReason: quotaCheck.reason,
          code: quotaCheck.code,
          model: this.model,
          commitSha: git.commitSha,
        },
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
        {
          timestamp: new Date().toISOString(),
          eventType: 'TASK_STOP',
          taskId: task.id,
          status: 'BLOCKED',
          stopReason: 'Verification tests failed. Refusing to transition to QA_REVIEW.',
          code: 'TESTS_FAILED',
          model: this.model,
          commitSha: git.commitSha,
        },
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

    // Transition to QA_REVIEW
    await writeTaskStatus(this.config.taskFilePath, 'QA_REVIEW');

    // Re-query git for new commit SHA
    const updatedGit = await this.resolveGitContext(this.cwd);

    await appendAuditLog(
      {
        timestamp: new Date().toISOString(),
        eventType: 'TASK_COMPLETE',
        taskId: task.id,
        status: 'QA_REVIEW',
        model: this.model,
        commitSha: updatedGit.commitSha || git.commitSha,
      },
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
}
