import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { acquireLock, releaseLock, releaseLockSync } from '../src/lock.ts';

describe('lock module', () => {
  const testLockFile = path.resolve(process.cwd(), 'scratch-test.bridge-lock');

  afterEach(async () => {
    try { await fs.unlink(testLockFile); } catch { /* ok */ }
  });

  it('acquires lock when file does not exist', async () => {
    const result = await acquireLock(testLockFile);
    expect(result.acquired).toBe(true);
    await releaseLock(testLockFile);
  });

  it('blocks second acquisition when first is held', async () => {
    const r1 = await acquireLock(testLockFile);
    expect(r1.acquired).toBe(true);

    const r2 = await acquireLock(testLockFile);
    expect(r2.acquired).toBe(false);
    expect(r2.existingPid).toBe(process.pid);

    await releaseLock(testLockFile);
  });

  it('releases lock successfully', async () => {
    await acquireLock(testLockFile);
    const released = await releaseLock(testLockFile);
    expect(released).toBe(true);

    // Should be acquirable again
    const r2 = await acquireLock(testLockFile);
    expect(r2.acquired).toBe(true);
    await releaseLock(testLockFile);
  });

  it('releaseLockSync removes own lock file', async () => {
    await acquireLock(testLockFile);
    releaseLockSync(testLockFile);
    const r = await acquireLock(testLockFile);
    expect(r.acquired).toBe(true);
    await releaseLock(testLockFile);
  });

  it('does not release a lock held by another PID', async () => {
    // Write a lock with a different PID
    const fakeLock = JSON.stringify({ pid: process.pid + 1000, startedAt: new Date().toISOString() });
    await fs.writeFile(testLockFile, fakeLock, 'utf-8');
    const released = await releaseLock(testLockFile);
    expect(released).toBe(false);
    // Verify file still exists
    await expect(fs.readFile(testLockFile)).resolves.toBeDefined();
    await fs.unlink(testLockFile);
  });

  it('cleans stale lock from dead PID and acquires new lock', async () => {
    // Use a very high PID that will never be alive on any real system
    const staleLock = JSON.stringify({ pid: 999999999, startedAt: '2020-01-01T00:00:00Z' });
    await fs.writeFile(testLockFile, staleLock, 'utf-8');

    const r = await acquireLock(testLockFile);
    expect(r.acquired).toBe(true);
    await releaseLock(testLockFile);
  });
});
