import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  BridgeConfig,
  BridgeExecutionResult,
  TaskDefinition,
  HandoffState,
  SafetyErrorCode,
  LauncherAdapter,
  ProviderType,
  CostPolicy,
  ZeroOverageVerificationState,
  CreditFallbackState,
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
  DEFAULT_EXTERNAL_QA_APPROVAL_FILE,
  DEFAULT_ANTIGRAVITY_SETTINGS_FILE,
  DEFAULT_ZERO_OVERAGE_FILE,
  DEFAULT_LAUNCHER_NAME,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REMOTE_NAME,
  DEFAULT_REMOTE_BRANCH,
  APPROVED_PROVIDERS,
} from './constants.ts';
import { readCurrentTask, writeTaskStatus } from './task-parser.ts';
import {
  validateRepository,
  validateBranch,
  validateProviderAndModel,
  checkZeroOverageVerification,
  checkCreditFallbackSetting,
  detectQuotaOrBillingError,
  detectHumanOnlyAction,
} from './safety.ts';
import { isKillSwitchActive, isKillSwitchActiveSync } from './kill-switch.ts';
import { appendAuditLog } from './audit-logger.ts';
import { getGitContext, syncRemoteTask, type GitContext, type GitSyncResult } from './git-utils.ts';
import { verifyExecutionIntegrity, type ExecutionIntegrityResult } from './execution-integrity.ts';
import { acquireLock, releaseLock, releaseLockSync } from './lock.ts';

const execFileAsync = promisify(execFile);

export interface BridgeOptions {
  cwd?: string;
  config?: Partial<BridgeConfig>;
  model?: string;
  gitContextResolver?: (cwd: string) => Promise<GitContext>;
  testRunner?: (cwd: string) => Promise<{ ok: boolean; output: string }>;
  remoteSyncResolver?: (cwd: string, taskPath: string) => Promise<GitSyncResult>;
  agyInterfaceVerifier?: (cwd: string) => Promise<{ ok: boolean; reason?: string; code?: SafetyErrorCode }>;
  agyModelsGetter?: (cwd: string) => Promise<{ ok: boolean; models: string[]; rawOutput?: string; error?: string }>;
  executionIntegrityResolver?: (cwd: string, baselineSha: string) => Promise<ExecutionIntegrityResult>;
  onStatusTransition?: (status: HandoffState, task: TaskDefinition) => Promise<void> | void;
  launcherRunner?: (
    adapter: LauncherAdapter,
    selectedModel: string,
    task: TaskDefinition,
    cwd: string,
    extraArgs?: string[]
  ) => Promise<{ code: number; stdout: string; stderr: string; killedBySwitch: boolean }>;
}

export function constructTaskPrompt(task: TaskDefinition): string {
  const parts: string[] = [
    `Execute approved task ${task.id}: ${task.title}`,
    `Objective: ${task.objective}`,
  ];
  if (task.requiredWork && task.requiredWork.length > 0) {
    parts.push('Required work:');
    task.requiredWork.forEach((w, i) => parts.push(`${i + 1}. ${w}`));
  }
  if (task.hardConstraints && task.hardConstraints.length > 0) {
    parts.push('Hard constraints:');
    task.hardConstraints.forEach((c) => parts.push(`- ${c}`));
  }
  return parts.join('\n');
}

export function buildLauncherArgs(
  adapter: LauncherAdapter,
  selectedModel: string,
  task: TaskDefinition,
  extraArgs: string[] = []
): { binary: string; args: string[] } {
  let args: string[];
  if (adapter.isHeadlessPrompt) {
    const prompt = constructTaskPrompt(task);
    args = [...adapter.prefixArgs, prompt];
    if (adapter.modelArgFlag && selectedModel) args.push(adapter.modelArgFlag, selectedModel);
    args.push(...extraArgs);
  } else {
    args = [...adapter.prefixArgs];
    if (adapter.modelArgFlag && selectedModel) args.push(adapter.modelArgFlag, selectedModel);
    args.push(...extraArgs);
  }
  return { binary: adapter.binary, args };
}

export async function defaultVerifyAgyInterface(
  cwd: string = process.cwd()
): Promise<{ ok: boolean; reason?: string; code?: SafetyErrorCode }> {
  try {
    const { stdout, stderr } = await execFileAsync('agy', ['--help'], { cwd });
    const output = `${stdout}\n${stderr}`;
    if (!/-p\b|--prompt\b/.test(output)) return { ok: false, code: 'LAUNCHER_NOT_ALLOWED', reason: `Installed "agy" CLI differs from documented headless interface (does not support -p): detected help output:\n${output.slice(0, 300)}` };
    if (!/--model\b/.test(output)) return { ok: false, code: 'LAUNCHER_NOT_ALLOWED', reason: `Installed "agy" CLI does not support the required --model flag: detected help output:\n${output.slice(0, 300)}` };
    return { ok: true };
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string };
    return { ok: false, code: 'LAUNCHER_NOT_ALLOWED', reason: `Antigravity CLI binary "agy" is not installed or not in PATH: ${e.stderr || e.message || 'Command not found'}` };
  }
}

export async function defaultGetAgyModels(
  cwd: string = process.cwd()
): Promise<{ ok: boolean; models: string[]; rawOutput?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('agy', ['models'], { cwd });
    const rawOutput = `${stdout}\n${stderr}`;
    const matches = [...rawOutput.matchAll(/\b(gemini-[a-zA-Z0-9.-]+)\b/gi)];
    return { ok: true, models: [...new Set(matches.map((m) => m[1].toLowerCase()))], rawOutput };
  } catch (err: unknown) {
    const e = err as { message: string; stderr?: string };
    return { ok: false, models: [], error: `Failed to query "agy models": ${e.stderr || e.message}` };
  }
}

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
    operatorVerificationFilePath: options.config?.operatorVerificationFilePath || options.config?.zeroOverageVerificationFilePath || DEFAULT_OPERATOR_ZERO_OVERAGE_FILE,
    zeroOverageVerificationFilePath: options.config?.operatorVerificationFilePath || options.config?.zeroOverageVerificationFilePath || DEFAULT_OPERATOR_ZERO_OVERAGE_FILE,
    qaApprovalFilePath: options.config?.qaApprovalFilePath || DEFAULT_EXTERNAL_QA_APPROVAL_FILE,
    antigravitySettingsPath: options.config?.antigravitySettingsPath || DEFAULT_ANTIGRAVITY_SETTINGS_FILE,
    launcherName: options.config?.launcherName || DEFAULT_LAUNCHER_NAME,
    model: options.model || options.config?.model,
    dryRun: options.config?.dryRun ?? false,
    watchMode: options.config?.watchMode ?? false,
    pollIntervalMs: options.config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    syncRemote: options.config?.syncRemote ?? true,
    remoteName: options.config?.remoteName || DEFAULT_REMOTE_NAME,
    remoteBranch: options.config?.remoteBranch || DEFAULT_REMOTE_BRANCH,
    allowedProviders: options.config?.allowedProviders || [...APPROVED_PROVIDERS],
  };
}

export class AIBridge {
  private cwd: string;
  private config: BridgeConfig;
  private resolveGitContext: (cwd: string) => Promise<GitContext>;
  private runTests: (cwd: string) => Promise<{ ok: boolean; output: string }>;
  private runRemoteSync: (cwd: string, taskPath: string) => Promise<GitSyncResult>;
  private verifyAgy: (cwd: string) => Promise<{ ok: boolean; reason?: string; code?: SafetyErrorCode }>;
  private getAgyModels: (cwd: string) => Promise<{ ok: boolean; models: string[]; rawOutput?: string; error?: string }>;
  private verifyExecutionIntegrity: (cwd: string, baselineSha: string) => Promise<ExecutionIntegrityResult>;
  private onStatusTransition?: (status: HandoffState, task: TaskDefinition) => Promise<void> | void;
  private customLauncherRunner?: (
    adapter: LauncherAdapter,
    selectedModel: string,
    task: TaskDefinition,
    cwd: string,
    extraArgs?: string[]
  ) => Promise<{ code: number; stdout: string; stderr: string; killedBySwitch: boolean }>;
  private _stopped = false;

  constructor(options: BridgeOptions = {}) {
    this.cwd = options.cwd || process.cwd();
    this.config = resolveConfig(options);
    this.resolveGitContext = options.gitContextResolver || getGitContext;
    this.runTests = options.testRunner || this.defaultTestRunner.bind(this);
    this.verifyAgy = options.agyInterfaceVerifier || defaultVerifyAgyInterface;
    this.getAgyModels = options.agyModelsGetter || defaultGetAgyModels;
    this.verifyExecutionIntegrity = options.executionIntegrityResolver || verifyExecutionIntegrity;
    this.onStatusTransition = options.onStatusTransition;
    this.customLauncherRunner = options.launcherRunner;
    this.runRemoteSync = options.remoteSyncResolver || ((dir, file) => syncRemoteTask({ cwd: dir, taskFilePath: file, remote: this.config.remoteName, branch: this.config.remoteBranch, gitContextResolver: this.resolveGitContext }));
  }

  private async defaultTestRunner(cwd: string): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout: testOut, stderr: testErr } = await execFileAsync('npm', ['test'], { cwd });
      const { stdout: typeOut, stderr: typeErr } = await execFileAsync('npm', ['run', 'typecheck'], { cwd });
      return { ok: true, output: `${testOut}${testErr}\n${typeOut}${typeErr}` };
    } catch (err: unknown) {
      const e = err as { message: string; stdout?: string; stderr?: string };
      return { ok: false, output: `${e.stdout || ''}\n${e.stderr || ''}\n${e.message}` };
    }
  }

  public stop(): void { this._stopped = true; }

  public async checkPreconditions(): Promise<{
    allowed: boolean;
    task?: TaskDefinition;
    gitContext?: GitContext;
    syncResult?: GitSyncResult;
    adapter?: LauncherAdapter;
    selectedModel?: string;
    provider?: ProviderType;
    costPolicy?: CostPolicy;
    zeroOverageVerificationState?: ZeroOverageVerificationState;
    creditFallbackState?: CreditFallbackState;
    modelRuntimeVerification?: string;
    reason?: string;
    code?: string;
  }> {
    const killSwitch = await isKillSwitchActive(this.config.killSwitchFilePath);
    if (killSwitch.active) return { allowed: false, reason: `Kill switch active: ${killSwitch.reason}`, code: 'KILL_SWITCH_ACTIVE' };
    const git = await this.resolveGitContext(this.cwd);
    const repoCheck = validateRepository(git.remoteUrl);
    if (!repoCheck.allowed) return { allowed: false, gitContext: git, reason: repoCheck.reason, code: repoCheck.code };
    const branchCheck = validateBranch(git.branch);
    if (!branchCheck.allowed) return { allowed: false, gitContext: git, reason: branchCheck.reason, code: branchCheck.code };
    if (!git.isClean) {
      const uncommitted = git.uncommittedFiles.filter((f) => !f.endsWith('.bridge-lock') && !f.endsWith('.bridge-stop') && !f.endsWith('.log'));
      if (uncommitted.length > 0) return { allowed: false, gitContext: git, reason: `Working tree contains uncommitted local changes (${uncommitted.join(', ')}). Execution halted to preserve local work (LOCAL_CHANGES_PRESENT).`, code: 'LOCAL_CHANGES_PRESENT' };
    }
    const providerModelCheck = validateProviderAndModel(this.config.launcherName, this.config.model, this.config.allowedProviders);
    if (!providerModelCheck.allowed) return { allowed: false, gitContext: git, reason: providerModelCheck.reason, code: providerModelCheck.code };
    const adapter = providerModelCheck.adapter!;
    const selectedModel = providerModelCheck.model!;
    const provider = providerModelCheck.provider!;
    const costPolicy = providerModelCheck.costPolicy!;
    let zeroOverageVerificationState: ZeroOverageVerificationState = 'NOT_APPLICABLE';
    let creditFallbackState: CreditFallbackState = 'DISABLED';
    let modelRuntimeVerification = 'not_applicable';
    if (adapter.provider === 'antigravity') {
      const fallbackCheck = checkCreditFallbackSetting({ settingsPath: this.config.antigravitySettingsPath || DEFAULT_ANTIGRAVITY_SETTINGS_FILE });
      creditFallbackState = fallbackCheck.fallbackState;
      if (!fallbackCheck.allowed) return { allowed: false, gitContext: git, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState: 'UNVERIFIED', creditFallbackState, modelRuntimeVerification: 'unverified', reason: fallbackCheck.reason, code: fallbackCheck.code || 'ANTIGRAVITY_CREDIT_FALLBACK_ENABLED' };
      const overageCheck = checkZeroOverageVerification({ filePath: this.config.operatorVerificationFilePath || this.config.zeroOverageVerificationFilePath || DEFAULT_OPERATOR_ZERO_OVERAGE_FILE, workspaceDir: this.cwd });
      zeroOverageVerificationState = overageCheck.state;
      if (!overageCheck.verified || zeroOverageVerificationState !== 'HUMAN_VERIFIED') return { allowed: false, gitContext: git, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState: 'UNVERIFIED', creditFallbackState, modelRuntimeVerification: 'unverified', reason: overageCheck.reason, code: overageCheck.code || 'ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED' };
      const agyCheck = await this.verifyAgy(this.cwd);
      if (!agyCheck.ok) return { allowed: false, gitContext: git, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification: 'unverified', reason: agyCheck.reason, code: agyCheck.code };
      const modelsRes = await this.getAgyModels(this.cwd);
      if (!modelsRes.ok) return { allowed: false, gitContext: git, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification: 'failed', reason: `Failed to query Antigravity CLI models: ${modelsRes.error || 'Unknown error'}. Execution blocked.`, code: 'MODEL_NOT_IN_CLI' };
      const normalizedRequested = selectedModel.trim().toLowerCase();
      if (!modelsRes.models.map((m) => m.toLowerCase()).includes(normalizedRequested)) return { allowed: false, gitContext: git, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification: 'not_in_cli', reason: `Model "${selectedModel}" is not supported by installed Antigravity CLI. Available models: ${modelsRes.models.join(', ')}`, code: 'MODEL_NOT_IN_CLI' };
      if (!adapter.approvedModels.map((m) => m.toLowerCase()).includes(normalizedRequested)) return { allowed: false, gitContext: git, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification: 'policy_mismatch', reason: `Model "${selectedModel}" is available in CLI but is NOT approved by repository policy. Approved: ${adapter.approvedModels.join(', ')}`, code: 'ANTIGRAVITY_MODEL_POLICY_MISMATCH' };
      modelRuntimeVerification = 'verified_in_cli';
    }
    let syncResult: GitSyncResult | undefined;
    if (this.config.syncRemote) {
      syncResult = await this.runRemoteSync(this.cwd, this.config.taskFilePath);
      if (!syncResult.synced) return { allowed: false, gitContext: git, syncResult, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState, modelRuntimeVerification, reason: syncResult.reason || 'Remote synchronization failed. Cannot verify authoritative task from origin/main.', code: syncResult.code || 'REMOTE_SYNC_FAILED' };
    }
    const taskResult = await readCurrentTask(this.config.taskFilePath);
    if (!taskResult.ok || !taskResult.task) return { allowed: false, gitContext: git, syncResult, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState, reason: taskResult.error || 'No valid task found', code: taskResult.code || 'TASK_NOT_FOUND' };
    const task = taskResult.task;
    const isReady = task.status === 'READY' || task.status === 'LOCAL READY' || task.status === 'REMOTE READY';
    if (!isReady) {
      let reasonMsg = `Task ${task.id} status is "${task.status}".`;
      if (task.status === 'QA_REVIEW') reasonMsg += ' Task is awaiting ChatGPT QA review. Bridge stopped (no automatic task chaining).';
      else if (task.status === 'APPROVED') reasonMsg += ' Task is approved. Waiting for next task to be issued as READY.';
      else if (task.status === 'BLOCKED') reasonMsg += ' Task is blocked. Manual intervention or unblocking required.';
      else if (task.status === 'IMPLEMENTING' || task.status === 'TESTING') reasonMsg += ' Task is already in progress.';
      else reasonMsg += ' Bridge only consumes tasks with STATUS: READY, LOCAL READY, or REMOTE READY.';
      return { allowed: false, task, gitContext: git, syncResult, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState, reason: reasonMsg, code: 'INVALID_TASK_STATE' };
    }
    const taskTextToScan = `${task.title}\n${task.objective}\n${task.requiredWork.join('\n')}\n${task.hardConstraints.join('\n')}`;
    const humanOnlyCheck = detectHumanOnlyAction(taskTextToScan);
    if (!humanOnlyCheck.allowed) return { allowed: false, task, gitContext: git, syncResult, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification, reason: humanOnlyCheck.reason, code: humanOnlyCheck.code };
    return { allowed: true, task, gitContext: git, syncResult, adapter, selectedModel, provider, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification };
  }

  private async spawnWithKillSwitchMonitor(adapter: LauncherAdapter, selectedModel: string, task: TaskDefinition, extraArgs: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string; killedBySwitch: boolean }> {
    if (this.customLauncherRunner) return this.customLauncherRunner(adapter, selectedModel, task, cwd, extraArgs);
    const { binary, args } = buildLauncherArgs(adapter, selectedModel, task, extraArgs);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killedBySwitch = false;
      let child: ReturnType<typeof spawn>;
      try { child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: false }); }
      catch (err: unknown) { const e = err as Error; resolve({ code: 1, stdout: '', stderr: `Spawn error: ${e.message}`, killedBySwitch: false }); return; }
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const killPollInterval = setInterval(() => {
        const ks = isKillSwitchActiveSync(this.config.killSwitchFilePath);
        if (ks.active && !killedBySwitch) {
          killedBySwitch = true;
          clearInterval(killPollInterval);
          try {
            child.kill('SIGTERM');
            setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch { /* child gone */ } }, 2000);
          } catch { /* child gone */ }
        }
      }, 1000);
      child.on('error', (err) => { clearInterval(killPollInterval); stderr += `\nProcess error: ${err.message}`; resolve({ code: 1, stdout, stderr, killedBySwitch }); });
      child.on('close', (exitCode) => { clearInterval(killPollInterval); resolve({ code: killedBySwitch ? 130 : (exitCode ?? 1), stdout, stderr, killedBySwitch }); });
    });
  }

  public async run(): Promise<BridgeExecutionResult> {
    const preconditions = await this.checkPreconditions();
    if (!preconditions.allowed) {
      const code = (preconditions.code || 'SAFETY_VIOLATION') as SafetyErrorCode;
      const stopReason = preconditions.reason || 'Precondition check failed';
      await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'SAFETY_VIOLATION', taskId: preconditions.task?.id, status: preconditions.task?.status, provider: preconditions.provider, launcher: preconditions.adapter?.name || this.config.launcherName, model: preconditions.selectedModel || this.config.model, costPolicy: preconditions.costPolicy, zeroOverageVerificationState: preconditions.zeroOverageVerificationState || 'UNVERIFIED', creditFallbackState: preconditions.creditFallbackState, modelRuntimeVerification: preconditions.modelRuntimeVerification, stopReason, code, commitSha: preconditions.gitContext?.commitSha }, this.config.auditLogPath);
      if (code === 'HUMAN_ONLY_ACTION' && preconditions.task) {
        await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
        await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'TASK_BLOCKED', taskId: preconditions.task.id, status: 'BLOCKED', provider: preconditions.provider, launcher: preconditions.adapter?.name, model: preconditions.selectedModel, costPolicy: preconditions.costPolicy, zeroOverageVerificationState: preconditions.zeroOverageVerificationState || 'UNVERIFIED', creditFallbackState: preconditions.creditFallbackState, modelRuntimeVerification: preconditions.modelRuntimeVerification, stopReason, code }, this.config.auditLogPath);
      }
      return { success: false, taskId: preconditions.task?.id || 'UNKNOWN', initialStatus: preconditions.task?.status || 'READY', finalStatus: code === 'HUMAN_ONLY_ACTION' ? 'BLOCKED' : (preconditions.task?.status || 'READY'), commitSha: preconditions.gitContext?.commitSha, stopReason, code, dryRun: this.config.dryRun };
    }

    const task = preconditions.task!;
    const git = preconditions.gitContext!;
    const adapter = preconditions.adapter!;
    const selectedModel = preconditions.selectedModel!;
    const provider = preconditions.provider!;
    const costPolicy = preconditions.costPolicy!;
    const zeroOverageVerificationState = preconditions.zeroOverageVerificationState!;
    const creditFallbackState = preconditions.creditFallbackState;
    const modelRuntimeVerification = preconditions.modelRuntimeVerification;
    const initialStatus = preconditions.syncResult?.state === 'REMOTE_FETCHED' ? ('REMOTE READY' as HandoffState) : task.status;

    if (this.config.dryRun) {
      await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'DRY_RUN', taskId: task.id, status: initialStatus, provider, launcher: adapter.name, model: selectedModel, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification, commitSha: git.commitSha, metadata: { title: task.title, syncState: preconditions.syncResult?.state } }, this.config.auditLogPath);
      return { success: true, taskId: task.id, initialStatus, finalStatus: initialStatus, commitSha: git.commitSha, dryRun: true };
    }

    await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'TASK_START', taskId: task.id, status: 'IMPLEMENTING', provider, launcher: adapter.name, model: selectedModel, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification, commitSha: git.commitSha, metadata: { initialStatus } }, this.config.auditLogPath);
    await writeTaskStatus(this.config.taskFilePath, 'IMPLEMENTING');
    await this.onStatusTransition?.('IMPLEMENTING', task);

    const launcherResult = await this.spawnWithKillSwitchMonitor(adapter, selectedModel, task, [], this.cwd);

    if (launcherResult.killedBySwitch) {
      await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
      await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'KILL_SWITCH_ACTIVE', taskId: task.id, status: 'BLOCKED', provider, launcher: adapter.name, model: selectedModel, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification, stopReason: 'Child process terminated by kill switch while running', code: 'KILL_SWITCH_ACTIVE', commitSha: git.commitSha }, this.config.auditLogPath);
      await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'CHILD_KILLED', taskId: task.id, status: 'BLOCKED', provider, launcher: adapter.name, model: selectedModel, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification }, this.config.auditLogPath);
      return { success: false, taskId: task.id, initialStatus, finalStatus: 'BLOCKED', commitSha: git.commitSha, stopReason: 'Kill switch activated while child process was running', code: 'KILL_SWITCH_ACTIVE', dryRun: false };
    }

    const combinedOutput = `${launcherResult.stdout}\n${launcherResult.stderr}`;
    const quotaCheck = detectQuotaOrBillingError(combinedOutput);
    if (!quotaCheck.allowed) {
      await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
      await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'TASK_BLOCKED', taskId: task.id, status: 'BLOCKED', provider, launcher: adapter.name, model: selectedModel, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification, stopReason: quotaCheck.reason, code: quotaCheck.code, commitSha: git.commitSha }, this.config.auditLogPath);
      return { success: false, taskId: task.id, initialStatus, finalStatus: 'BLOCKED', commitSha: git.commitSha, stopReason: quotaCheck.reason, code: quotaCheck.code, dryRun: false };
    }

    const integrity = await this.verifyExecutionIntegrity(this.cwd, git.commitSha);
    if (!integrity.ok) {
      await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
      await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'TASK_BLOCKED', taskId: task.id, status: 'BLOCKED', provider, launcher: adapter.name, model: selectedModel, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification, stopReason: `Execution integrity gate failed: ${integrity.reason || 'No verified implementation change'}`, code: 'EXECUTION_NOOP', commitSha: integrity.afterSha || git.commitSha, metadata: { baselineSha: integrity.baselineSha, afterSha: integrity.afterSha, changedFiles: integrity.changedFiles, implementationFiles: integrity.implementationFiles } }, this.config.auditLogPath);
      return { success: false, taskId: task.id, initialStatus, finalStatus: 'BLOCKED', commitSha: integrity.afterSha || git.commitSha, stopReason: `Execution integrity gate failed: ${integrity.reason || 'No verified implementation change'}`, code: 'EXECUTION_NOOP', dryRun: false };
    }

    await writeTaskStatus(this.config.taskFilePath, 'TESTING');
    await this.onStatusTransition?.('TESTING', task);
    const testResult = await this.runTests(this.cwd);
    if (!testResult.ok) {
      await writeTaskStatus(this.config.taskFilePath, 'BLOCKED');
      await this.onStatusTransition?.('BLOCKED', task);
      await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'TASK_STOP', taskId: task.id, status: 'BLOCKED', provider, launcher: adapter.name, model: selectedModel, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification, stopReason: 'Verification tests failed. Refusing to transition to QA_REVIEW.', code: 'TESTS_FAILED', commitSha: integrity.afterSha }, this.config.auditLogPath);
      return { success: false, taskId: task.id, initialStatus, finalStatus: 'BLOCKED', commitSha: integrity.afterSha, stopReason: 'Verification tests failed', code: 'TESTS_FAILED', dryRun: false };
    }

    await writeTaskStatus(this.config.taskFilePath, 'QA_REVIEW');
    await this.onStatusTransition?.('QA_REVIEW', task);
    const updatedGit = await this.resolveGitContext(this.cwd);
    await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'TASK_COMPLETE', taskId: task.id, status: 'QA_REVIEW', provider, launcher: adapter.name, model: selectedModel, costPolicy, zeroOverageVerificationState, creditFallbackState, modelRuntimeVerification, commitSha: updatedGit.commitSha || integrity.afterSha }, this.config.auditLogPath);
    return { success: true, taskId: task.id, initialStatus, finalStatus: 'QA_REVIEW', commitSha: updatedGit.commitSha || integrity.afterSha, dryRun: false };
  }

  public async watch(onTick?: (status: string) => void, onResult?: (result: BridgeExecutionResult) => void): Promise<void> {
    const lockResult = await acquireLock(this.config.lockFilePath);
    if (!lockResult.acquired) {
      await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'DUPLICATE_INSTANCE', stopReason: `Another bridge instance is already running (PID: ${lockResult.existingPid ?? 'unknown'})`, code: 'DUPLICATE_INSTANCE' }, this.config.auditLogPath);
      throw new Error(`DUPLICATE_INSTANCE: Another bridge instance is already running (PID: ${lockResult.existingPid ?? 'unknown'}). Exiting.`);
    }
    const cleanupLock = () => releaseLockSync(this.config.lockFilePath);
    process.on('exit', cleanupLock);
    await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'WATCH_START', launcher: this.config.launcherName, model: this.config.model, metadata: { pollIntervalMs: this.config.pollIntervalMs, syncRemote: this.config.syncRemote } }, this.config.auditLogPath);
    try {
      while (!this._stopped) {
        const ks = await isKillSwitchActive(this.config.killSwitchFilePath);
        if (ks.active) { await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'KILL_SWITCH_ACTIVE', stopReason: ks.reason, code: 'KILL_SWITCH_ACTIVE' }, this.config.auditLogPath); onTick?.(`STOPPED: Kill switch active — ${ks.reason}`); break; }
        const pre = await this.checkPreconditions();
        if (pre.code === 'SYNC_CONFLICT' || pre.code === 'REMOTE_SYNC_FAILED' || pre.code === 'ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED' || pre.code === 'MODEL_NOT_IN_CLI' || pre.code === 'CLI_MODEL_POLICY_MISMATCH') {
          await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'SYNC_FAILED', provider: pre.provider, launcher: pre.adapter?.name, model: pre.selectedModel, costPolicy: pre.costPolicy, zeroOverageVerificationState: pre.zeroOverageVerificationState || 'N/A', stopReason: pre.reason, code: pre.code }, this.config.auditLogPath);
          onTick?.(`HALTED: ${pre.reason}`);
          break;
        }
        const taskStatus = pre.task?.status ?? 'UNKNOWN';
        await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'WATCH_TICK', provider: pre.provider, launcher: pre.adapter?.name, model: pre.selectedModel, costPolicy: pre.costPolicy, zeroOverageVerificationState: pre.zeroOverageVerificationState || 'N/A', metadata: { taskId: pre.task?.id, taskStatus } }, this.config.auditLogPath);
        onTick?.(`WATCH: Task ${pre.task?.id ?? 'unknown'} STATUS=${taskStatus}`);
        if (pre.allowed) {
          const result = await this.run();
          onResult?.(result);
          if (result.finalStatus === 'QA_REVIEW') { await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'WATCH_STOP', stopReason: 'Task transitioned to QA_REVIEW. Waiting for external QA gate. Bridge stopped.', taskId: result.taskId }, this.config.auditLogPath); onTick?.(`WATCH_STOP: Task ${result.taskId} is QA_REVIEW. Waiting for ChatGPT QA. No automatic chaining.`); break; }
          if (result.finalStatus === 'BLOCKED') { await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'WATCH_STOP', stopReason: `Task BLOCKED: ${result.stopReason}`, code: result.code }, this.config.auditLogPath); onTick?.(`WATCH_STOP: Task ${result.taskId} BLOCKED — ${result.stopReason}`); break; }
          if (result.dryRun) { await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'WATCH_STOP', stopReason: 'Dry-run cycle complete. No live changes made.' }, this.config.auditLogPath); onTick?.('WATCH_STOP: Dry-run complete. No state changes.'); break; }
        }
        await this.sleep(this.config.pollIntervalMs);
      }
    } finally {
      await releaseLock(this.config.lockFilePath);
      process.off('exit', cleanupLock);
      await appendAuditLog({ timestamp: new Date().toISOString(), eventType: 'WATCH_STOP', stopReason: this._stopped ? 'Graceful shutdown requested' : 'Watch loop exited' }, this.config.auditLogPath);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, ms);
      const check = setInterval(() => { if (this._stopped && !resolved) { resolved = true; clearInterval(check); clearTimeout(timer); resolve(); } }, 100);
      timer.unref?.();
    });
  }
}
