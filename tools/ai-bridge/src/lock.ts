import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { DEFAULT_LOCK_FILE } from './constants.ts';

export interface BridgeLockInfo {
  pid: number;
  startedAt: string;
}

/**
 * Attempts to acquire a single-instance lock.
 * Returns true if the lock was acquired, false if another instance holds it.
 * Uses an atomic write-if-not-exists pattern via O_EXCL flag.
 */
export async function acquireLock(
  lockFilePath: string = DEFAULT_LOCK_FILE
): Promise<{ acquired: boolean; existingPid?: number }> {
  const info: BridgeLockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  try {
    // O_EXCL ensures atomic create-if-not-exists
    const fd = await fs.open(lockFilePath, 'ax');
    await fd.writeFile(JSON.stringify(info, null, 2), 'utf-8');
    await fd.close();
    return { acquired: true };
  } catch (err: unknown) {
    // File already exists — another instance holds the lock
    try {
      const existing = await fs.readFile(lockFilePath, 'utf-8');
      const parsed = JSON.parse(existing) as BridgeLockInfo;

      // Check if the PID is still alive
      if (isPidAlive(parsed.pid)) {
        return { acquired: false, existingPid: parsed.pid };
      }

      // Stale lock: PID is gone — clean up and retry
      await fs.unlink(lockFilePath);
      return acquireLock(lockFilePath);
    } catch {
      return { acquired: false };
    }
  }
}

/**
 * Releases the bridge lock by deleting the lock file.
 * Only releases if the lock file contains our own PID.
 */
export async function releaseLock(
  lockFilePath: string = DEFAULT_LOCK_FILE
): Promise<boolean> {
  try {
    const content = await fs.readFile(lockFilePath, 'utf-8');
    const parsed = JSON.parse(content) as BridgeLockInfo;
    if (parsed.pid !== process.pid) {
      // Not our lock — do not remove
      return false;
    }
    await fs.unlink(lockFilePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous release (for process exit handlers).
 */
export function releaseLockSync(
  lockFilePath: string = DEFAULT_LOCK_FILE
): void {
  try {
    if (!fsSync.existsSync(lockFilePath)) return;
    const content = fsSync.readFileSync(lockFilePath, 'utf-8');
    const parsed = JSON.parse(content) as BridgeLockInfo;
    if (parsed.pid === process.pid) {
      fsSync.unlinkSync(lockFilePath);
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Checks if a process with the given PID is alive.
 * On Unix, signal 0 tests existence without sending a real signal.
 * Negative or zero PIDs are treated as dead (invalid).
 */
function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
