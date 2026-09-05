import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  isKillSwitchActive,
  isKillSwitchActiveSync,
  triggerKillSwitch,
  clearKillSwitch,
} from '../src/kill-switch.ts';

describe('kill-switch module', () => {
  const testStopFile = path.resolve(process.cwd(), 'scratch-test.bridge-stop');

  afterEach(async () => {
    try {
      await fs.unlink(testStopFile);
    } catch {
      // Ignored
    }
  });

  it('reports inactive when stop file does not exist', async () => {
    const status = await isKillSwitchActive(testStopFile);
    expect(status.active).toBe(false);
    expect(isKillSwitchActiveSync(testStopFile).active).toBe(false);
  });

  it('triggers kill switch and records reason', async () => {
    await triggerKillSwitch(testStopFile, 'Emergency operator halt');
    const status = await isKillSwitchActive(testStopFile);
    expect(status.active).toBe(true);
    expect(status.reason).toBe('Emergency operator halt');
    expect(status.timestamp).toBeDefined();

    const syncStatus = isKillSwitchActiveSync(testStopFile);
    expect(syncStatus.active).toBe(true);
    expect(syncStatus.reason).toBe('Emergency operator halt');
  });

  it('clears kill switch successfully', async () => {
    await triggerKillSwitch(testStopFile, 'Temporary pause');
    expect((await isKillSwitchActive(testStopFile)).active).toBe(true);

    const cleared = await clearKillSwitch(testStopFile);
    expect(cleared).toBe(true);
    expect((await isKillSwitchActive(testStopFile)).active).toBe(false);
  });

  it('clearing non-existent kill switch returns false without error', async () => {
    const cleared = await clearKillSwitch(testStopFile);
    expect(cleared).toBe(false);
  });
});
