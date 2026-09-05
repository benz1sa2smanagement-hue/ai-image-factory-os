#!/usr/bin/env -S node --experimental-strip-types
import { AIBridge } from './bridge.ts';
import { triggerKillSwitch, clearKillSwitch, isKillSwitchActive } from './kill-switch.ts';
import { getGitContext } from './git-utils.ts';
import { readCurrentTask } from './task-parser.ts';
import { DEFAULT_TASK_FILE, DEFAULT_KILL_SWITCH_FILE } from './constants.ts';

function printHelp(): void {
  console.log(`
AI Bridge — Phase B Local Bridge for ChatGPT ↔ Claude Code

Usage:
  node --experimental-strip-types tools/ai-bridge/src/cli.ts [options]
  npm run bridge -- [options]

Commands:
  --check               Check preconditions and current task status without executing
  --dry-run             Simulate the bridge cycle without running commands or altering state
  --status              Print current repository, branch, task status, and kill-switch state
  --stop [reason]       Trigger the local human kill-switch immediately
  --resume, --clear     Clear the human kill-switch
  --help, -h            Show this help text

Options:
  --model <model-name>  Approved free OpenRouter model (default: nvidia/nemotron-3.5-lightning:free)
  --run                 Execute the single approved task through the bridge
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Handle kill switch actions
  if (args.includes('--stop')) {
    const idx = args.indexOf('--stop');
    const reason = args[idx + 1] && !args[idx + 1].startsWith('--')
      ? args[idx + 1]
      : 'Stopped by operator via CLI';
    await triggerKillSwitch(DEFAULT_KILL_SWITCH_FILE, reason);
    console.log(`[KILL SWITCH] Activated: "${reason}" (.bridge-stop created)`);
    process.exit(0);
  }

  if (args.includes('--resume') || args.includes('--clear')) {
    const cleared = await clearKillSwitch(DEFAULT_KILL_SWITCH_FILE);
    if (cleared) {
      console.log('[KILL SWITCH] Cleared (.bridge-stop removed)');
    } else {
      console.log('[KILL SWITCH] Not currently active');
    }
    process.exit(0);
  }

  // Handle status report
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

  // Model option
  let model: string | undefined;
  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    model = args[modelIdx + 1];
  }

  const dryRun = args.includes('--dry-run');
  const checkOnly = args.includes('--check');

  const bridge = new AIBridge({
    model,
    config: {
      dryRun,
    },
  });

  if (checkOnly) {
    console.log('[AI BRIDGE] Running precondition checks...');
    const result = await bridge.checkPreconditions();
    if (result.allowed) {
      console.log(`[AI BRIDGE] Preconditions PASSED. Task ${result.task?.id} is READY for execution.`);
      process.exit(0);
    } else {
      console.error(`[AI BRIDGE] Preconditions FAILED: ${result.reason} (code: ${result.code})`);
      process.exit(1);
    }
  }

  // Execute bridge (dry-run or live)
  console.log(`[AI BRIDGE] Initializing bridge cycle (${dryRun ? 'DRY-RUN' : 'LIVE'})...`);
  const execution = await bridge.run();

  if (execution.success) {
    console.log(`[AI BRIDGE] Execution succeeded!`);
    console.log(`  Task:   ${execution.taskId}`);
    console.log(`  Status: ${execution.initialStatus} -> ${execution.finalStatus}`);
    console.log(`  Commit: ${execution.commitSha || 'N/A'}`);
    console.log(`  DryRun: ${execution.dryRun}`);
    process.exit(0);
  } else {
    console.error(`[AI BRIDGE] Execution HALTED/FAILED:`);
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
