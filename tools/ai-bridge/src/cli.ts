#!/usr/bin/env -S node --experimental-strip-types
import * as fs from 'node:fs';
import { AIBridge } from './bridge.ts';
import { AutonomousSupervisor } from './supervisor.ts';
import { triggerKillSwitch, clearKillSwitch, isKillSwitchActive } from './kill-switch.ts';
import { getGitContext } from './git-utils.ts';
import { readCurrentTask, parseApprovalSignal } from './task-parser.ts';
import {
  DEFAULT_TASK_FILE,
  DEFAULT_KILL_SWITCH_FILE,
  DEFAULT_LOCK_FILE,
  DEFAULT_OPERATOR_ZERO_OVERAGE_FILE,
  DEFAULT_OPERATOR_TRUST_ANCHOR_FILE,
  DEFAULT_LAUNCHER_NAME,
  APPROVED_OPENROUTER_FREE_MODELS,
  APPROVED_ANTIGRAVITY_MODELS,
  LAUNCHER_ADAPTERS,
} from './constants.ts';
import { loadProtectedTrustAnchor } from './crypto.ts';

function printHelp(): void {
  const openrouterModels = APPROVED_OPENROUTER_FREE_MODELS.map((m) => `    - ${m}`).join('\n');
  const antigravityModels = APPROVED_ANTIGRAVITY_MODELS.map((m) => `    - ${m}`).join('\n');
  const launcherList = LAUNCHER_ADAPTERS.map(
    (a) => `  - ${a.name.padEnd(16)} [${a.provider}] (${a.costPolicy}) — ${a.description || ''}`
  ).join('\n');

  console.log(`
AI Bridge — Phase B Local Bridge for ChatGPT ↔ Claude Code / Antigravity

Usage:
  npm run bridge -- [command] [options]
  node --experimental-strip-types tools/ai-bridge/src/cli.ts [command] [options]

Commands:
  --loop, --supervisor      Start Phase C autonomous supervisor (runs continuous loop with approval gate)
  --loop-status             Print autonomous loop state, approval status, and supervisor locks
  --run                     Execute exactly one approved task (remote authority verified)
  --watch                   Persistent watch mode: polls origin/main and runs one verified READY task
  --check                   Check preconditions and current task status (read-only)
  --dry-run                 Simulate a full bridge cycle without side effects
  --status                  Print current repository, task, kill-switch, and lock state
  --stop [reason]           Trigger the human kill-switch immediately
  --resume, --clear         Clear the kill-switch
  --help, -h                Show this help text

Options:
  --model <model-name>      Model slug approved for the chosen launcher/provider
  --launcher <name>         Launcher adapter name (default: ${DEFAULT_LAUNCHER_NAME})
  --interval <ms>           Watch mode poll interval in ms (default: 30000)
  --max-cycles <N>          Maximum supervisor cycles before exiting (default: infinite)

Approved Launcher Adapters:
${launcherList}

Approved Model Slugs by Provider:
  Provider: openrouter (cost_policy: free-tier)
${openrouterModels}

  Provider: antigravity (cost_policy: subscription_with_zero_overage)
${antigravityModels}

Mandatory Zero-Cost & Antigravity Policies:
  1. Google AI Pro subscription entitlement alone does NOT prevent charges.
     Human owner MUST confirm: Antigravity Settings -> AI Credit Overages -> Never.
     Verification proof MUST reside at an operator-controlled location OUTSIDE the repository:
       ${DEFAULT_OPERATOR_ZERO_OVERAGE_FILE}
     Repository-local files or CLI flags CANNOT self-authorize execution.
  2. Antigravity AI Credit Overages / useG1Credits setting must be disabled.
  3. Antigravity uses official headless interface: agy -p "<prompt>" --model <slug>
  4. Installed CLI models are dynamically verified using "agy models".
  5. Remote synchronization with origin/main is MANDATORY (halts with REMOTE_SYNC_FAILED).
  6. Zero-cost policy: MAX_ALLOWED_COST = 0, ALLOW_PAID_API = false.
  7. Quota, billing, or rate-limit errors cause immediate STOP to BLOCKED.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // --- Strict Trust Boundary: Reject unauthorized self-approval or trust-anchor injection flags ---
  if (
    args.includes('--public-key') ||
    args.includes('--trust-anchor') ||
    args.includes('--trusted-key') ||
    args.includes('--approve')
  ) {
    console.error('[TRUST BOUNDARY ERROR] Self-authorization and trust anchor overrides via CLI are prohibited.');
    console.error('The verification key must be provisioned by the human operator at the protected external OS path:');
    console.error(`  ${DEFAULT_OPERATOR_TRUST_ANCHOR_FILE}`);
    process.exit(1);
  }

  // --- Kill switch management ---
  if (args.includes('--stop')) {
    const idx = args.indexOf('--stop');
    const reason =
      args[idx + 1] && !args[idx + 1].startsWith('--')
        ? args[idx + 1]
        : 'Stopped by operator via CLI';
    await triggerKillSwitch(DEFAULT_KILL_SWITCH_FILE, reason);
    console.log(`[KILL SWITCH] Activated: "${reason}" (.bridge-stop created)`);
    process.exit(0);
  }

  if (args.includes('--resume') || args.includes('--clear')) {
    const cleared = await clearKillSwitch(DEFAULT_KILL_SWITCH_FILE);
    console.log(cleared ? '[KILL SWITCH] Cleared (.bridge-stop removed)' : '[KILL SWITCH] Not currently active');
    process.exit(0);
  }

  // --- Status report ---
  if (args.includes('--loop-status')) {
    const git = await getGitContext();
    const killSwitch = await isKillSwitchActive(DEFAULT_KILL_SWITCH_FILE);
    const taskResult = await readCurrentTask(DEFAULT_TASK_FILE);
    const isLocked = fs.existsSync(DEFAULT_LOCK_FILE);
    const taskContent = fs.existsSync(DEFAULT_TASK_FILE)
      ? fs.readFileSync(DEFAULT_TASK_FILE, 'utf-8')
      : '';
    const approval = parseApprovalSignal(taskContent);
    const trustAnchorStatus = loadProtectedTrustAnchor();

    console.log('\n--- PHASE C AUTONOMOUS LOOP STATUS ---');
    console.log(`Repository:      ${git.remoteUrl || '(unknown)'}`);
    console.log(`Branch:          ${git.branch || '(unknown)'}`);
    console.log(`HEAD Commit:     ${git.commitSha || '(unknown)'}`);
    console.log(`Working Tree:    ${git.isClean ? 'CLEAN' : 'DIRTY (' + git.uncommittedFiles.join(', ') + ')'}`);
    console.log(`Kill Switch:     ${killSwitch.active ? `ACTIVE (${killSwitch.reason})` : 'INACTIVE'}`);
    console.log(`Supervisor Lock: ${isLocked ? `HELD (${DEFAULT_LOCK_FILE})` : 'FREE'}`);
    if (taskResult.ok && taskResult.task) {
      console.log(`Current Task:    ${taskResult.task.id} (${taskResult.task.title})`);
      console.log(`Task Status:     ${taskResult.task.status}`);
    } else {
      console.log(`Current Task:    ERROR (${taskResult.error})`);
    }
    console.log(
      `Approval Signal: ${
        approval.approved
          ? `APPROVED (${approval.approvedBy}, commit: ${approval.approvedCommit})`
          : `PENDING/NONE (${approval.reason || 'No approval'})`
      }`
    );
    console.log(
      `Trust Anchor:    ${
        trustAnchorStatus.protected
          ? `PROTECTED (${trustAnchorStatus.keyFingerprint})`
          : `NOT PROTECTED (${trustAnchorStatus.protectionState}: ${trustAnchorStatus.reason})`
      }`
    );
    console.log(`Zero-Overage:    ${fs.existsSync(DEFAULT_OPERATOR_ZERO_OVERAGE_FILE) ? 'OPERATOR VERIFIED' : 'UNVERIFIED'}`);
    console.log('-------------------------------------\n');
    process.exit(0);
  }

  if (args.includes('--status')) {
    const git = await getGitContext();
    const killSwitch = await isKillSwitchActive(DEFAULT_KILL_SWITCH_FILE);
    const taskResult = await readCurrentTask(DEFAULT_TASK_FILE);

    console.log('\n--- AI BRIDGE STATUS ---');
    console.log(`Repository:   ${git.remoteUrl || '(unknown)'}`);
    console.log(`Branch:       ${git.branch || '(unknown)'}`);
    console.log(`HEAD Commit:  ${git.commitSha || '(unknown)'}`);
    console.log(`Clean Tree:   ${git.isClean}`);
    if (!git.isClean) {
      console.log(`Dirty Files:  ${git.uncommittedFiles.join(', ')}`);
    }
    console.log(`Kill Switch:  ${killSwitch.active ? `ACTIVE (${killSwitch.reason})` : 'INACTIVE'}`);
    if (taskResult.ok && taskResult.task) {
      console.log(`Current Task: ${taskResult.task.id}`);
      console.log(`Task Status:  ${taskResult.task.status}`);
      console.log(`Task Title:   ${taskResult.task.title}`);
    } else {
      console.log(`Current Task: ERROR (${taskResult.error})`);
    }
    console.log('------------------------\n');
    process.exit(0);
  }

  // --- Self-authorization prevention ---
  if (args.includes('--record-zero-overage')) {
    console.error('[TRUST BOUNDARY ERROR] Autonomous self-authorization is prohibited.');
    console.error('The Bridge CLI cannot record zero-overage verification records inside the repository workspace.');
    console.error('A human operator must verify account settings ("AI Credit Overages = Never") and create:');
    console.error(`  ${DEFAULT_OPERATOR_ZERO_OVERAGE_FILE}`);
    process.exit(1);
  }

  if (
    args.includes('--verify-zero-overage') &&
    !args.includes('--run') &&
    !args.includes('--check') &&
    !args.includes('--watch') &&
    !args.includes('--dry-run')
  ) {
    console.log('[TRUST BOUNDARY] Human Operator Zero-Overage Verification:');
    console.log(`  Expected path: ${DEFAULT_OPERATOR_ZERO_OVERAGE_FILE}`);
    if (fs.existsSync(DEFAULT_OPERATOR_ZERO_OVERAGE_FILE)) {
      console.log('  Status on disk: FOUND');
    } else {
      console.log('  Status on disk: NOT FOUND (Antigravity execution will remain BLOCKED)');
    }
    process.exit(0);
  }

  // --- Parse shared options ---
  let model: string | undefined;
  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    model = args[modelIdx + 1];
  }

  let launcherName: string | undefined;
  const launcherIdx = args.indexOf('--launcher');
  if (launcherIdx !== -1 && args[launcherIdx + 1]) {
    launcherName = args[launcherIdx + 1];
  }

  let pollIntervalMs: number | undefined;
  const intervalIdx = args.indexOf('--interval');
  if (intervalIdx !== -1 && args[intervalIdx + 1]) {
    const parsed = parseInt(args[intervalIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      pollIntervalMs = parsed;
    }
  }

  let maxCycles: number | undefined;
  const maxCyclesIdx = args.indexOf('--max-cycles');
  if (maxCyclesIdx !== -1 && args[maxCyclesIdx + 1]) {
    const parsed = parseInt(args[maxCyclesIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      maxCycles = parsed;
    }
  }

  const dryRun = args.includes('--dry-run');
  const checkOnly = args.includes('--check');
  const watchMode = args.includes('--watch');
  const loopMode = args.includes('--loop') || args.includes('--supervisor');

  // --- Phase C Autonomous Supervisor Mode ---
  if (loopMode) {
    console.log('[AI SUPERVISOR] Starting Phase C Autonomous Task Loop...');
    console.log(`  Launcher:     ${launcherName || DEFAULT_LAUNCHER_NAME}`);
    console.log(`  Interval:     ${pollIntervalMs ?? 10000}ms`);
    console.log(`  Max Cycles:   ${maxCycles !== undefined ? maxCycles : 'unlimited'}`);
    console.log(`  Zero-Overage: ${fs.existsSync(DEFAULT_OPERATOR_ZERO_OVERAGE_FILE) ? 'OPERATOR VERIFIED' : 'UNVERIFIED'}`);
    console.log('  Press Ctrl+C or create .bridge-stop to stop.\n');

    const supervisor = new AutonomousSupervisor({
      model,
      maxCycles,
      pollIntervalMs,
      config: {
        dryRun,
        launcherName,
      },
    });

    function gracefulSupervisorShutdown(signal: string): void {
      console.log(`\n[AI SUPERVISOR] Received ${signal}. Initiating graceful shutdown...`);
      supervisor.stop();
    }
    process.on('SIGINT', () => gracefulSupervisorShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulSupervisorShutdown('SIGTERM'));

    const result = await supervisor.run({
      onTick: (msg) => console.log(`[AI SUPERVISOR] ${new Date().toISOString()} ${msg}`),
      onStateChange: (st) => console.log(`[AI SUPERVISOR STATE] -> ${st}`),
    });

    console.log(`\n[AI SUPERVISOR] Loop finished with state: ${result.state}`);
    console.log(`  Cycles Completed: ${result.cyclesCompleted}`);
    console.log(`  Tasks Completed:  ${result.tasksCompleted.join(', ') || 'none'}`);
    if (result.stopReason) {
      console.log(`  Stop Reason:      ${result.stopReason}`);
    }
    process.exit(result.state === 'LOOP_BLOCKED' ? 1 : 0);
  }

  const bridge = new AIBridge({
    model,
    config: {
      dryRun,
      watchMode,
      launcherName: launcherName,
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    },
  });

  // Register graceful shutdown handlers
  function gracefulShutdown(signal: string): void {
    console.log(`\n[AI BRIDGE] Received ${signal}. Initiating graceful shutdown...`);
    bridge.stop();
  }
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // --- Check mode ---
  if (checkOnly) {
    console.log('[AI BRIDGE] Running precondition checks...');
    const result = await bridge.checkPreconditions();
    if (result.allowed) {
      console.log(
        `[AI BRIDGE] Preconditions PASSED. Task ${result.task?.id} (${result.task?.title}) is ${result.task?.status}.`
      );
      console.log(`  Provider:        ${result.provider}`);
      console.log(`  Launcher:        ${result.adapter?.name}`);
      console.log(`  Model:           ${result.selectedModel}`);
      console.log(`  Cost Policy:     ${result.costPolicy}`);
      console.log(`  Zero-Overage:    ${result.zeroOverageVerificationState}`);
      console.log(`  Credit Fallback: ${result.creditFallbackState}`);
      console.log(`  Model Runtime:   ${result.modelRuntimeVerification}`);
      process.exit(0);
    } else {
      console.error(`[AI BRIDGE] Preconditions FAILED: ${result.reason} (code: ${result.code})`);
      process.exit(1);
    }
  }

  // --- Watch mode ---
  if (watchMode) {
    console.log('[AI BRIDGE] Starting watch mode...');
    console.log(`  Launcher:     ${launcherName || DEFAULT_LAUNCHER_NAME}`);
    console.log(`  Interval:     ${pollIntervalMs ?? 30000}ms`);
    console.log(`  Zero-Overage: ${fs.existsSync(DEFAULT_OPERATOR_ZERO_OVERAGE_FILE) ? 'OPERATOR VERIFIED' : 'UNVERIFIED'}`);
    console.log('  Press Ctrl+C or create .bridge-stop to stop.\n');

    try {
      await bridge.watch(
        (status) => console.log(`[AI BRIDGE WATCH] ${new Date().toISOString()} ${status}`),
        (result) => {
          if (result.success) {
            console.log(`[AI BRIDGE WATCH] Task ${result.taskId}: ${result.initialStatus} -> ${result.finalStatus}`);
          } else {
            console.error(
              `[AI BRIDGE WATCH] Task ${result.taskId} FAILED/BLOCKED: ${result.stopReason} (${result.code})`
            );
          }
        }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('DUPLICATE_INSTANCE')) {
        console.error(`[AI BRIDGE] ERROR: ${msg}`);
        process.exit(2);
      }
      throw err;
    }

    console.log('[AI BRIDGE] Watch mode stopped. Waiting for ChatGPT QA before next task.');
    process.exit(0);
  }

  // --- Dry-run or single-cycle run ---
  console.log(`[AI BRIDGE] Initializing bridge cycle (${dryRun ? 'DRY-RUN' : 'LIVE'})...`);
  const execution = await bridge.run();

  if (execution.success) {
    console.log('[AI BRIDGE] Execution succeeded!');
    console.log(`  Task:   ${execution.taskId}`);
    console.log(`  Status: ${execution.initialStatus} -> ${execution.finalStatus}`);
    console.log(`  Commit: ${execution.commitSha || 'N/A'}`);
    console.log(`  DryRun: ${execution.dryRun}`);
    process.exit(0);
  } else {
    console.error('[AI BRIDGE] Execution HALTED/FAILED:');
    console.error(`  Task:   ${execution.taskId}`);
    console.error(`  Code:   ${execution.code}`);
    console.error(`  Reason: ${execution.stopReason}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[AI BRIDGE] Fatal error:', err);
  process.exit(1);
});
