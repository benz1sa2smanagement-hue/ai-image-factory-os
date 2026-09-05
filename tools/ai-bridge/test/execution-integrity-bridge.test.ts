import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AIBridge } from '../src/bridge.ts';
import type { GitContext } from '../src/git-utils.ts';

const gitContext: GitContext = {
  remoteUrl: 'git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git',
  branch: 'main',
  commitSha: '1111111111111111111111111111111111111111',
  isClean: true,
  uncommittedFiles: [],
};

const taskDoc = `
# AI TASK

## Current Task

**TASK ID:** TASK-004
**STATUS:** READY
**TITLE:** Phase D
**SOURCE:** GitHub

### Objective
Build Phase D.

### Required work
1. Implement the task.

### Hard constraints
- MAX_ALLOWED_COST = 0
- ALLOW_PAID_API = false
`;

describe('AIBridge execution integrity integration', () => {
  it('blocks a successful/no-op executor before QA_REVIEW', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-bridge-noop-'));
    const taskFilePath = path.join(dir, 'AI_TASK.md');
    const auditLogPath = path.join(dir, 'AUDIT.log');
    const killSwitchFilePath = path.join(dir, '.bridge-stop');
    const lockFilePath = path.join(dir, '.bridge-lock');
    await fs.writeFile(taskFilePath, taskDoc, 'utf8');

    try {
      const bridge = new AIBridge({
        cwd: dir,
        config: {
          taskFilePath,
          auditLogPath,
          killSwitchFilePath,
          lockFilePath,
          launcherName: 'ori-claude',
          syncRemote: false,
          dryRun: false,
        },
        gitContextResolver: async () => gitContext,
        launcherRunner: async () => ({ code: 0, stdout: '', stderr: '', killedBySwitch: false }),
        testRunner: async () => ({ ok: true, output: 'tests passed' }),
        executionIntegrityResolver: async () => ({
          ok: false,
          baselineSha: gitContext.commitSha,
          afterSha: gitContext.commitSha,
          changedFiles: [],
          implementationFiles: [],
          reason: 'Execution produced no new commit.',
        }),
      });

      const result = await bridge.run();
      expect(result.success).toBe(false);
      expect(result.finalStatus).toBe('BLOCKED');
      expect(result.code).toBe('EXECUTION_NOOP');
      expect(result.stopReason).toContain('Execution integrity gate failed');

      const finalDoc = await fs.readFile(taskFilePath, 'utf8');
      expect(finalDoc).toContain('**STATUS:** BLOCKED');
      expect(finalDoc).not.toContain('**STATUS:** QA_REVIEW');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
