import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  maskSecrets,
  sanitizeData,
  formatAuditEntry,
  appendAuditLog,
  readAuditLogs,
} from '../src/audit-logger.ts';
import type { AuditLogEntry } from '../src/types.ts';

describe('audit-logger module', () => {
  const testLogFile = path.resolve(process.cwd(), 'scratch-test-audit.log');

  afterEach(async () => {
    try {
      await fs.unlink(testLogFile);
    } catch {
      // Ignored
    }
  });

  describe('secret masking', () => {
    it('masks sk- style OpenAI/Claude API keys', () => {
      const input = 'Using key sk-123456789012345678901234567890 to authenticate';
      const masked = maskSecrets(input);
      expect(masked).not.toContain('sk-123456789012345678901234567890');
      expect(masked).toContain('[REDACTED_SECRET]');
    });

    it('masks Bearer tokens', () => {
      const input = 'Authorization: Bearer mySecretToken1234567890abcdef123';
      const masked = maskSecrets(input);
      expect(masked).not.toContain('mySecretToken1234567890abcdef123');
      expect(masked).toContain('Bearer [REDACTED]');
    });

    it('masks GitHub personal access tokens', () => {
      const input = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
      const masked = maskSecrets(input);
      expect(masked).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
      expect(masked).toContain('[REDACTED_SECRET]');
    });

    it('sanitizes nested object structures with sensitive keys', () => {
      const obj = {
        taskId: 'TASK-002',
        apiKey: 'superSecretKey123',
        nested: {
          password: 'myPassword!',
          safeField: 'hello world',
        },
      };
      const sanitized = sanitizeData(obj) as any;
      expect(sanitized.taskId).toBe('TASK-002');
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.nested.password).toBe('[REDACTED]');
      expect(sanitized.nested.safeField).toBe('hello world');
    });
  });

  describe('log persistence', () => {
    it('appends and reads audit log entries as valid JSON lines', async () => {
      const entry1: AuditLogEntry = {
        timestamp: '2026-09-05T08:00:00.000Z',
        eventType: 'TASK_START',
        taskId: 'TASK-002',
        status: 'READY',
        model: 'nvidia/nemotron-3.5-lightning:free',
        commitSha: '2c98a0e8',
      };

      const entry2: AuditLogEntry = {
        timestamp: '2026-09-05T08:05:00.000Z',
        eventType: 'TASK_COMPLETE',
        taskId: 'TASK-002',
        status: 'QA_REVIEW',
        commitSha: '3d19b1f9',
      };

      await appendAuditLog(entry1, testLogFile);
      await appendAuditLog(entry2, testLogFile);

      const logs = await readAuditLogs(testLogFile);
      expect(logs).toHaveLength(2);
      expect(logs[0].eventType).toBe('TASK_START');
      expect(logs[0].taskId).toBe('TASK-002');
      expect(logs[1].eventType).toBe('TASK_COMPLETE');
      expect(logs[1].commitSha).toBe('3d19b1f9');
    });
  });
});
