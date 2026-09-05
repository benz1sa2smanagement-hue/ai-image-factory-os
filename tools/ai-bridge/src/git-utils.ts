import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitContext {
  remoteUrl: string;
  branch: string;
  commitSha: string;
  isClean: boolean;
}

/**
 * Reads the current git state from the repository.
 */
export async function getGitContext(cwd: string = process.cwd()): Promise<GitContext> {
  let remoteUrl = '';
  let branch = '';
  let commitSha = '';
  let isClean = true;

  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd });
    remoteUrl = stdout.trim();
  } catch {
    // Remote origin might not exist or fallback to git remote -v
    try {
      const { stdout } = await execFileAsync('git', ['remote', '-v'], { cwd });
      const firstLine = stdout.split('\n')[0] || '';
      const parts = firstLine.split(/\s+/);
      if (parts.length >= 2) {
        remoteUrl = parts[1];
      }
    } catch {
      remoteUrl = '';
    }
  }

  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd });
    branch = stdout.trim();
  } catch {
    branch = '';
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    commitSha = stdout.trim();
  } catch {
    commitSha = '';
  }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    isClean = stdout.trim().length === 0;
  } catch {
    isClean = false;
  }

  return {
    remoteUrl,
    branch,
    commitSha,
    isClean,
  };
}
