/**
 * Deterministic execution-integrity gate.
 *
 * A successful launcher/test run is not sufficient evidence of implementation.
 * The gate requires:
 *   1. HEAD to advance from the execution baseline; and
 *   2. at least one implementation file to have changed in the resulting range.
 *
 * Documentation-only, metadata-only, and runtime-only changes are not evidence
 * that the approved task was actually implemented.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecutionIntegrityResult {
  ok: boolean;
  baselineSha: string;
  afterSha: string;
  changedFiles: string[];
  implementationFiles: string[];
  reason?: string;
}

const FULL_SHA_REGEX = /^[a-fA-F0-9]{40}$/;

/**
 * Files that are implementation evidence for the autonomous software tasks.
 * Documentation, CI metadata, and local/runtime state are deliberately excluded.
 */
function isImplementationFile(file: string): boolean {
  const normalized = file.replace(/^\.\//, '');

  if (
    normalized.startsWith('docs/') ||
    normalized.startsWith('.github/') ||
    normalized.startsWith('.husky/') ||
    normalized === 'README.md' ||
    normalized === 'STATUS.md' ||
    normalized === 'AI_AGENT_HANDOFF.md' ||
    normalized.endsWith('.log') ||
    normalized === '.bridge-lock' ||
    normalized === '.bridge-stop'
  ) {
    return false;
  }

  // Source, worker, package, migration, and utility script changes are implementation evidence.
  return (
    normalized.startsWith('packages/') ||
    normalized.startsWith('workers/') ||
    normalized.startsWith('tools/') ||
    normalized.startsWith('migrations/') ||
    normalized.startsWith('scripts/') ||
    /\.(ts|tsx|js|jsx|mjs|cjs|sql)$/.test(normalized)
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/**
 * Verifies that execution produced a real implementation commit after baselineSha.
 */
export async function verifyExecutionIntegrity(
  cwd: string,
  baselineSha: string
): Promise<ExecutionIntegrityResult> {
  const empty: ExecutionIntegrityResult = {
    ok: false,
    baselineSha,
    afterSha: '',
    changedFiles: [],
    implementationFiles: [],
  };

  if (!FULL_SHA_REGEX.test(baselineSha)) {
    return {
      ...empty,
      reason: `Invalid execution baseline SHA: ${baselineSha}`,
    };
  }

  let afterSha = '';
  try {
    afterSha = await git(cwd, ['rev-parse', 'HEAD']);
  } catch (error) {
    return {
      ...empty,
      reason: `Unable to read post-execution HEAD: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!FULL_SHA_REGEX.test(afterSha)) {
    return {
      ...empty,
      afterSha,
      reason: `Invalid post-execution HEAD SHA: ${afterSha}`,
    };
  }

  if (afterSha.toLowerCase() === baselineSha.toLowerCase()) {
    return {
      ...empty,
      afterSha,
      reason: 'Execution produced no new commit; refusing to enter QA_REVIEW.',
    };
  }

  let changedFiles: string[];
  try {
    const raw = await git(cwd, ['diff', '--name-only', `${baselineSha}..${afterSha}`]);
    changedFiles = raw ? raw.split('\n').map((file) => file.trim()).filter(Boolean) : [];
  } catch (error) {
    return {
      ...empty,
      afterSha,
      reason: `Unable to determine execution diff ${baselineSha}..${afterSha}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const implementationFiles = changedFiles.filter(isImplementationFile);

  if (implementationFiles.length === 0) {
    return {
      ok: false,
      baselineSha,
      afterSha,
      changedFiles,
      implementationFiles,
      reason: `Execution commit range contains no implementation changes; changed files: ${changedFiles.join(', ') || '(none)'}. Refusing to enter QA_REVIEW.`,
    };
  }

  return {
    ok: true,
    baselineSha,
    afterSha,
    changedFiles,
    implementationFiles,
  };
}
