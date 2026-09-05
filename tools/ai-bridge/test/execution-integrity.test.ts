import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyExecutionIntegrity } from '../src/execution-integrity.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-bridge-integrity-'));
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.name', 'Integrity Test']);
  await git(dir, ['config', 'user.email', 'integrity@example.invalid']);
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n', 'utf8');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-qm', 'baseline']);
  return dir;
}

describe('execution integrity gate', () => {
  it('blocks when executor exits without creating a new commit', async () => {
    const dir = await initRepo();
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
      const result = await verifyExecutionIntegrity(dir, stdout.trim());
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('no new commit');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks a documentation-only commit', async () => {
    const dir = await initRepo();
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
      const baseline = stdout.trim();
      await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
      await fs.writeFile(path.join(dir, 'docs', 'note.md'), 'documentation only\n', 'utf8');
      await git(dir, ['add', 'docs/note.md']);
      await git(dir, ['commit', '-qm', 'docs only']);

      const result = await verifyExecutionIntegrity(dir, baseline);
      expect(result.ok).toBe(false);
      expect(result.implementationFiles).toHaveLength(0);
      expect(result.reason).toContain('contains no implementation changes');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts a commit containing real implementation changes', async () => {
    const dir = await initRepo();
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
      const baseline = stdout.trim();
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
      await git(dir, ['add', 'src/app.ts']);
      await git(dir, ['commit', '-qm', 'implementation']);

      const result = await verifyExecutionIntegrity(dir, baseline);
      expect(result.ok).toBe(true);
      expect(result.afterSha).not.toBe(baseline);
      expect(result.implementationFiles).toContain('src/app.ts');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
