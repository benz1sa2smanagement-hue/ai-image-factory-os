import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { TaskDefinition, SafetyErrorCode } from './types.ts';
import { parseTaskDocument, readCurrentTask } from './task-parser.ts';
import { DEFAULT_REMOTE_NAME, DEFAULT_REMOTE_BRANCH, DEFAULT_TASK_FILE } from './constants.ts';

const execFileAsync = promisify(execFile);

export interface GitContext {
  remoteUrl: string;
  branch: string;
  commitSha: string;
  isClean: boolean;
  uncommittedFiles: string[];
}

export interface GitSyncResult {
  synced: boolean;
  state:
    | 'UP_TO_DATE'
    | 'REMOTE_FETCHED'
    | 'CONFLICT'
    | 'LOCAL_DIRTY'
    | 'REMOTE_AHEAD'
    | 'FAILED';
  remoteTask?: TaskDefinition;
  localTask?: TaskDefinition;
  reason?: string;
  code?: SafetyErrorCode;
}

/**
 * Reads the current git state from the repository.
 */
export async function getGitContext(cwd: string = process.cwd()): Promise<GitContext> {
  let remoteUrl = '';
  let branch = '';
  let commitSha = '';
  let isClean = true;
  let uncommittedFiles: string[] = [];

  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd });
    remoteUrl = stdout.trim();
  } catch {
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
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      isClean = true;
      uncommittedFiles = [];
    } else {
      isClean = false;
      uncommittedFiles = trimmed
        .split('\n')
        .map((line) => line.replace(/^[A-Z?! ]{1,2}\s+/, '').trim())
        .filter(Boolean);
    }
  } catch {
    isClean = false;
  }

  return {
    remoteUrl,
    branch,
    commitSha,
    isClean,
    uncommittedFiles,
  };
}

/**
 * Fetches the latest refs from the specified remote and branch.
 */
export async function fetchRemote(
  remote: string = DEFAULT_REMOTE_NAME,
  branch: string = DEFAULT_REMOTE_BRANCH,
  cwd: string = process.cwd()
): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync('git', ['fetch', remote, branch], { cwd });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Retrieves the content of a file from a remote ref without modifying working tree.
 */
export async function getRemoteFileContent(
  filePath: string,
  ref: string = `${DEFAULT_REMOTE_NAME}/${DEFAULT_REMOTE_BRANCH}`,
  cwd: string = process.cwd()
): Promise<{ ok: boolean; content?: string; error?: string }> {
  try {
    const relPath = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${relPath}`], { cwd });
    return { ok: true, content: stdout };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Synchronizes the task definition from GitHub remote origin/main.
 *
 * Safety Rules:
 * 1. REMOTE AUTHORITY MANDATE: If origin/main cannot be fetched or verified,
 *    halt immediately with REMOTE_SYNC_FAILED. Never execute a READY task using stale
 *    local state when remote authority cannot be verified. Do NOT silently continue offline.
 * 2. NO-OVERWRITE GUARANTEE: If local working tree has uncommitted changes in any file,
 *    and remote has an updated task, halt with SYNC_CONFLICT to protect local uncommitted work.
 * 3. FAST-FORWARD: If local working tree is clean and remote has new commits on origin/main,
 *    fast-forward cleanly.
 */
export async function syncRemoteTask(options: {
  cwd?: string;
  taskFilePath?: string;
  remote?: string;
  branch?: string;
  gitContextResolver?: (cwd: string) => Promise<GitContext>;
  fetcher?: (remote: string, branch: string, cwd: string) => Promise<{ ok: boolean; error?: string }>;
  remoteContentGetter?: (filePath: string, ref: string, cwd: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
  fastForwardMerger?: (remote: string, branch: string, cwd: string) => Promise<{ ok: boolean; error?: string }>;
} = {}): Promise<GitSyncResult> {
  const cwd = options.cwd || process.cwd();
  const taskFilePath = options.taskFilePath || path.resolve(cwd, DEFAULT_TASK_FILE);
  const remote = options.remote || DEFAULT_REMOTE_NAME;
  const branch = options.branch || DEFAULT_REMOTE_BRANCH;

  const resolveGit = options.gitContextResolver || getGitContext;
  const doFetch = options.fetcher || fetchRemote;
  const doGetRemote = options.remoteContentGetter || getRemoteFileContent;
  const doMerge =
    options.fastForwardMerger ||
    (async (rem: string, br: string, dir: string) => {
      try {
        await execFileAsync('git', ['merge', '--ff-only', `${rem}/${br}`], { cwd: dir });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

  // 1. Read local task
  const localResult = await readCurrentTask(taskFilePath);
  const localTask = localResult.ok ? localResult.task : undefined;

  // 2. Check git remote configuration (Must have a remote configured)
  const git = await resolveGit(cwd);
  if (!git.remoteUrl) {
    return {
      synced: false,
      state: 'FAILED',
      localTask,
      code: 'REMOTE_SYNC_FAILED',
      reason: 'No git remote configured. Cannot verify authoritative task state from origin/main. Unattended execution blocked.',
    };
  }

  // 3. Fetch from remote origin/main — MANDATORY for remote authority verification
  const fetchRes = await doFetch(remote, branch, cwd);
  if (!fetchRes.ok) {
    return {
      synced: false,
      state: 'FAILED',
      localTask,
      code: 'REMOTE_SYNC_FAILED',
      reason: `Cannot fetch or verify remote authority from ${remote}/${branch}: ${fetchRes.error || 'Network or fetch failure'}. Execution halted to prevent running stale local state.`,
    };
  }

  // 4. Inspect remote task file on origin/main
  const remoteRef = `${remote}/${branch}`;
  const remoteFileRes = await doGetRemote(taskFilePath, remoteRef, cwd);
  if (!remoteFileRes.ok || !remoteFileRes.content) {
    return {
      synced: false,
      state: 'FAILED',
      localTask,
      code: 'REMOTE_SYNC_FAILED',
      reason: `Remote task file cannot be read from ${remoteRef}: ${remoteFileRes.error || 'File missing on remote'}. Execution halted.`,
    };
  }

  const remoteParse = parseTaskDocument(remoteFileRes.content);
  const remoteTask = remoteParse.ok ? remoteParse.task : undefined;

  // 5. Compare local and remote task definitions
  const localContent = localTask ? localTask.rawText.trim() : '';
  const remoteContent = remoteTask ? remoteTask.rawText.trim() : '';
  const tasksMatch = localContent === remoteContent;

  // 6. Handle dirty working tree (CRITICAL NO-OVERWRITE GUARANTEE)
  if (!git.isClean) {
    if (!tasksMatch) {
      // Local changes conflict with remote authoritative state
      return {
        synced: false,
        state: 'CONFLICT',
        localTask,
        remoteTask,
        code: 'SYNC_CONFLICT',
        reason: `Remote origin/main has updated task state, but local working tree has uncommitted changes (${git.uncommittedFiles.join(', ')}). Halting to prevent overwriting local work.`,
      };
    }

    // Local changes exist in code, but task definition already matches remote authoritative state
    return {
      synced: true,
      state: 'LOCAL_DIRTY',
      localTask,
      remoteTask,
      reason: 'Remote authoritative task verified. Local working tree has uncommitted changes.',
    };
  }

  // 7. Clean working tree and tasks differ: fast-forward cleanly
  if (!tasksMatch) {
    const mergeRes = await doMerge(remote, branch, cwd);
    if (!mergeRes.ok) {
      return {
        synced: false,
        state: 'CONFLICT',
        localTask,
        remoteTask,
        code: 'SYNC_CONFLICT',
        reason: `Fast-forward merge with ${remoteRef} failed: ${mergeRes.error}`,
      };
    }

    // Re-read local task after fast-forward
    const reRead = await readCurrentTask(taskFilePath);
    return {
      synced: true,
      state: 'REMOTE_FETCHED',
      localTask: reRead.ok ? reRead.task : remoteTask,
      remoteTask,
      reason: `Successfully fast-forwarded and synchronized authoritative task from ${remoteRef}.`,
    };
  }

  // 8. Clean and tasks match: UP_TO_DATE (Remote authority verified)
  return {
    synced: true,
    state: 'UP_TO_DATE',
    localTask,
    remoteTask,
  };
}
