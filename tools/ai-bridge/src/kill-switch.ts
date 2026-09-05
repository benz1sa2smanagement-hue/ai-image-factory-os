import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { DEFAULT_KILL_SWITCH_FILE } from './constants.ts';

export interface KillSwitchStatus {
  active: boolean;
  reason?: string;
  timestamp?: string;
}

/**
 * Checks if the human kill switch is active.
 */
export async function isKillSwitchActive(
  filePath: string = DEFAULT_KILL_SWITCH_FILE
): Promise<KillSwitchStatus> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    let reason = 'Kill switch file present';
    let timestamp: string | undefined;

    try {
      const parsed = JSON.parse(content);
      reason = parsed.reason || reason;
      timestamp = parsed.timestamp;
    } catch {
      if (content.trim()) {
        reason = content.trim();
      }
    }

    return {
      active: true,
      reason,
      timestamp,
    };
  } catch {
    return { active: false };
  }
}

/**
 * Synchronous check for kill switch.
 */
export function isKillSwitchActiveSync(
  filePath: string = DEFAULT_KILL_SWITCH_FILE
): KillSwitchStatus {
  try {
    if (!fsSync.existsSync(filePath)) {
      return { active: false };
    }
    const content = fsSync.readFileSync(filePath, 'utf-8');
    let reason = 'Kill switch file present';
    let timestamp: string | undefined;

    try {
      const parsed = JSON.parse(content);
      reason = parsed.reason || reason;
      timestamp = parsed.timestamp;
    } catch {
      if (content.trim()) {
        reason = content.trim();
      }
    }

    return {
      active: true,
      reason,
      timestamp,
    };
  } catch {
    return { active: false };
  }
}

/**
 * Triggers the kill switch by creating the stop file.
 */
export async function triggerKillSwitch(
  filePath: string = DEFAULT_KILL_SWITCH_FILE,
  reason: string = 'Stopped by human operator'
): Promise<void> {
  const data = JSON.stringify(
    {
      active: true,
      reason,
      timestamp: new Date().toISOString(),
    },
    null,
    2
  );
  await fs.writeFile(filePath, data, 'utf-8');
}

/**
 * Clears the kill switch by removing the stop file.
 */
export async function clearKillSwitch(
  filePath: string = DEFAULT_KILL_SWITCH_FILE
): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
