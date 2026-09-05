import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SECRET_MASK_PATTERNS, DEFAULT_AUDIT_LOG_FILE } from './constants.ts';
import type { AuditLogEntry } from './types.ts';

/**
 * Sanitizes any text by masking potential secrets, tokens, and credentials.
 */
export function maskSecrets(input: string): string {
  let sanitized = input;
  for (const pattern of SECRET_MASK_PATTERNS) {
    sanitized = sanitized.replace(pattern, (_match, prefix) => {
      if (typeof prefix === 'string' && prefix.length < 10 && !prefix.startsWith('sk-')) {
        return `${prefix}[REDACTED]`;
      }
      return '[REDACTED_SECRET]';
    });
  }
  return sanitized;
}

/**
 * Recursively sanitizes any data structure so no secrets are logged.
 */
export function sanitizeData<T>(data: T): T {
  if (typeof data === 'string') {
    return maskSecrets(data) as unknown as T;
  }
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeData(item)) as unknown as T;
  }
  if (data !== null && typeof data === 'object') {
    const res: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (/token|password|secret|key|authorization/i.test(key)) {
        res[key] = '[REDACTED]';
      } else {
        res[key] = sanitizeData(value);
      }
    }
    return res as unknown as T;
  }
  return data;
}

/**
 * Formats an audit log entry as a JSON Line string.
 */
export function formatAuditEntry(entry: AuditLogEntry): string {
  const sanitized = sanitizeData(entry);
  return JSON.stringify(sanitized);
}

/**
 * Appends an audit log entry to the log file.
 */
export async function appendAuditLog(
  entry: AuditLogEntry,
  logPath: string = DEFAULT_AUDIT_LOG_FILE
): Promise<void> {
  const line = formatAuditEntry(entry) + '\n';
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
  } catch {
    // Parent might already exist
  }
  await fs.appendFile(logPath, line, 'utf-8');
}

/**
 * Reads and parses all audit log entries from a file.
 */
export async function readAuditLogs(
  logPath: string = DEFAULT_AUDIT_LOG_FILE
): Promise<AuditLogEntry[]> {
  try {
    const content = await fs.readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map((l) => JSON.parse(l) as AuditLogEntry);
  } catch {
    return [];
  }
}
