#!/usr/bin/env -S node --experimental-strip-types
import { AIBridge } from './bridge.ts';
import { triggerKillSwitch, clearKillSwitch, isKillSwitchActive } from './kill-switch.ts';
import { getGitContext } from './git-utils.ts';
import { readCurrentTask } from './task-parser.ts';
import {
  DEFAULT_TASK_FILE,
  DEFAULT_KILL_SWITCH_FILE,
  DEFAULT_LAUNCHER_NAME,
  DEFAULT_FREE_MODEL,
  APPROVED_FREE_MODELS,
  LAUNCHER_ADAPTERS,
} from './constants.ts';

function printHelp(): void {
  const modelList = APPROVED_FREE_MODELS.map((m) => `  - ${m}`).join('\n');
  const launcherList = LAUNCHER_ADAPTERS.map((a) => `  - ${a.name} (${a.binary} ${a.prefixArgs.join(' ')})`).join('\n');

  console.log(`
AI Bridge — Phase B Local Bridge for ChatGPT ↔ Claude Code

Usage:
  npm run bridge -- [command] [options]
  node --experimental-strip-types tools/ai-bridge/src/cli.ts [command] [options]

Commands:
  --run                 Execute exactly one READY task (single cycle)
  --watch               Persistent watch mode: polls docs/AI_TASK.md and runs one READY task
  --check               Check preconditions and current task status (read-only)
  --dry-run             Simulate a full bridge cycle without side effects
  --status              Print current repository, task, kill-switch, and lock state
  --stop [reason]       Trigger the human kill-switch immediately
  --resume, --clear     Clear the kill-switch
  --help, -h            Show this help text

Options:
  --model <model-name>  Approved free model (default: ${DEFAULT_FREE_MODEL})
  --launcher <name>     Launcher adapter name (default: ${DEFAULT_LAUNCHER_NAME})
  --interval <ms>       Watch mode poll interval in ms (default: 30000)

Approved free models (explicit allowlist — suffix matching is NOT sufficient):
${modelList}

Approved launcher adapters:
${launcherList}

IMPORTANT:
  MAX_ALLOWED_COST = 0. ALLOW_PAID_API = false.
  Free quota/rate-limit/billing error => STOP.
  Do not start TASK-003. Do not auto-approve tasks.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
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
  if (args.includes('--status')) {
    const git = await getGitContext();
    const killSwitch = await isKillSwitchActive(DEFAULT_KILL_SWITCH_FILE);
    const taskResult = await readCurrentTask(DEFAULT_TASK_FILE);

    console.log('\n--- AI BRIDGE STATUS ---');
    console.log(`Repository:   ${git.remoteUrl || '(unknown)'}`);
    console.log(`Branch:       ${git.branch || '(unknown)'}`);
    console.log(`HEAD Commit:  ${git.commitSha || '(unknown)'}`);
    console.log(`Clean Tree:   ${git.isClean}`);
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

  const dryRun = args.includes('--dry-run');
  const checkOnly = args.includes('--check');
  const watchMode = args.includes('--watch');

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
      console.log(`[AI BRIDGE] Preconditions PASSED. Task ${result.task?.id} (${result.task?.title}) is READY.`);
      process.exit(0);
    } else {
      console.error(`[AI BRIDGE] Preconditions FAILED: ${result.reason} (code: ${result.code})`);
      process.exit(1);
    }
  }

  // --- Watch mode ---
  if (watchMode) {
    console.log('[AI BRIDGE] Starting watch mode...');
    console.log(`  Launcher:  ${launcherName || DEFAULT_LAUNCHER_NAME}`);
    console.log(`  Model:     ${model || DEFAULT_FREE_MODEL}`);
    console.log(`  Interval:  ${pollIntervalMs ?? 30000}ms`);
    console.log('  Press Ctrl+C or create .bridge-stop to stop.\n');

    try {
      await bridge.watch(
        (status) => console.log(`[AI BRIDGE WATCH] ${new Date().toISOString()} ${status}`),
        (result) => {
          if (result.success) {
            console.log(`[AI BRIDGE WATCH] Task ${result.taskId}: ${result.initialStatus} -> ${result.finalStatus}`);
          } else {
            console.error(`[AI BRIDGE WATCH] Task ${result.taskId} FAILED/BLOCKED: ${result.stopReason} (${result.code})`);
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
