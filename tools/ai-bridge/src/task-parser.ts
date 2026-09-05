import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import type { TaskDefinition, HandoffState, SafetyErrorCode, ApprovalSignal } from './types.ts';
import { isPathInsideWorkspace } from './safety.ts';
import { DEFAULT_EXTERNAL_QA_APPROVAL_FILE } from './constants.ts';

const VALID_STATUSES: readonly HandoffState[] = [
  'LOCAL READY',
  'REMOTE READY',
  'LOCAL_READY',
  'REMOTE_READY',
  'READY',
  'HOLD',
  'TASK_ISSUED',
  'IMPLEMENTING',
  'TESTING',
  'REPORT_READY',
  'QA_REVIEW',
  'APPROVED',
  'REJECTED',
  'BLOCKED',
  'FAILED',
];

export interface ParseTaskResult {
  ok: boolean;
  task?: TaskDefinition;
  error?: string;
  code?: SafetyErrorCode;
}

/**
 * Normalizes a status string:
 * 'LOCAL_READY' -> 'LOCAL READY'
 * 'REMOTE_READY' -> 'REMOTE READY'
 */
export function normalizeStatus(raw: string): HandoffState | undefined {
  const upper = raw.trim().toUpperCase();
  if (upper === 'LOCAL_READY') return 'LOCAL READY';
  if (upper === 'REMOTE_READY') return 'REMOTE READY';
  if (VALID_STATUSES.includes(upper as HandoffState)) {
    return upper as HandoffState;
  }
  return undefined;
}

/**
 * Parses docs/AI_TASK.md content and extracts the single current task.
 * Fails if no task is present, or if multiple active tasks are detected.
 */
export function parseTaskDocument(content: string): ParseTaskResult {
  const currentTaskMatch = content.match(/## Current Task\s+([\s\S]*?)(?=\n## [A-Z]|$)/i);
  if (!currentTaskMatch || !currentTaskMatch[1]) {
    return {
      ok: false,
      error: 'Section "## Current Task" not found in task document',
      code: 'TASK_NOT_FOUND',
    };
  }

  const sectionText = currentTaskMatch[1];

  // Count occurrences of TASK ID
  const taskIdMatches = [...sectionText.matchAll(/\*\*TASK ID:\*\*\s*([A-Za-z0-9_-]+)/gi)];
  if (taskIdMatches.length === 0) {
    return {
      ok: false,
      error: 'No TASK ID found in "## Current Task"',
      code: 'TASK_NOT_FOUND',
    };
  }

  if (taskIdMatches.length > 1) {
    return {
      ok: false,
      error: `Multiple tasks detected (${taskIdMatches.length} tasks found). Only 1 active task is permitted.`,
      code: 'MULTIPLE_TASKS_DETECTED',
    };
  }

  const taskId = taskIdMatches[0][1].trim();

  // Extract STATUS (supports multi-word statuses like LOCAL READY, REMOTE READY, QA_REVIEW)
  const statusMatch = sectionText.match(/\*\*STATUS:\*\*\s*([A-Za-z0-9_ ]+)/i);
  if (!statusMatch) {
    return {
      ok: false,
      error: 'No STATUS found in "## Current Task"',
      code: 'INVALID_TASK_STATE',
    };
  }

  const statusRaw = statusMatch[1].trim();
  const normalized = normalizeStatus(statusRaw);
  if (!normalized) {
    return {
      ok: false,
      error: `Invalid status "${statusRaw}" in task document`,
      code: 'INVALID_TASK_STATE',
    };
  }

  // Extract TITLE
  const titleMatch = sectionText.match(/\*\*TITLE:\*\*\s*([^\n]+)/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Extract SOURCE
  const sourceMatch = sectionText.match(/\*\*SOURCE:\*\*\s*([^\n]+)/i);
  const source = sourceMatch ? sourceMatch[1].trim() : '';

  // Extract Objective
  const objectiveMatch = sectionText.match(/### Objective\s+([\s\S]*?)(?=\n### |$)/i);
  const objective = objectiveMatch ? objectiveMatch[1].trim() : '';

  // Extract Required work items
  const requiredWork: string[] = [];
  const requiredWorkMatch = sectionText.match(/### Required work\s+([\s\S]*?)(?=\n### |$)/i);
  if (requiredWorkMatch) {
    const lines = requiredWorkMatch[1].split('\n');
    for (const line of lines) {
      const itemMatch = line.match(/^\s*\d+\.\s*(.+)$/);
      if (itemMatch) {
        requiredWork.push(itemMatch[1].trim());
      }
    }
  }

  // Extract Hard constraints
  const hardConstraints: string[] = [];
  const hardConstraintsMatch = sectionText.match(/### Hard constraints\s+([\s\S]*?)(?=\n### |$)/i);
  if (hardConstraintsMatch) {
    const lines = hardConstraintsMatch[1].split('\n');
    for (const line of lines) {
      const itemMatch = line.match(/^\s*-\s*(.+)$/);
      if (itemMatch) {
        hardConstraints.push(itemMatch[1].trim());
      }
    }
  }

  return {
    ok: true,
    task: {
      id: taskId,
      status: normalized,
      title,
      source,
      objective,
      requiredWork,
      hardConstraints,
      rawText: sectionText,
    },
  };
}

/**
 * Updates the STATUS field in a task document string.
 */
export function updateTaskStatus(content: string, newStatus: HandoffState): string {
  return content.replace(
    /(\*\*STATUS:\*\*\s*)([A-Za-z0-9_ ]+)/i,
    `$1${newStatus}`
  );
}

/**
 * Reads and parses the current task from the filesystem.
 */
export async function readCurrentTask(filePath: string): Promise<ParseTaskResult> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseTaskDocument(content);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read task file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      code: 'TASK_NOT_FOUND',
    };
  }
}

/**
 * Updates the task status in the given file.
 */
export async function writeTaskStatus(filePath: string, newStatus: HandoffState): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const updated = updateTaskStatus(content, newStatus);
    await fs.writeFile(filePath, updated, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

const FULL_SHA_REGEX = /^[a-fA-F0-9]{40}$/;

/**
 * Options for verifying external durable QA approval.
 */
export interface ExternalApprovalOptions {
  filePath?: string;
  workspaceDir?: string;
  expectedTaskId?: string;
  expectedCommitSha?: string;
}

/**
 * Result of checking external durable QA approval.
 */
export interface ExternalApprovalResult {
  approved: boolean;
  approvalStatus?: 'APPROVED' | 'REJECTED' | 'PENDING' | string;
  approvedTaskId?: string;
  approvedBy?: string;
  approvedCommit?: string;
  approvalSource: 'external_record';
  reason?: string;
  code?: SafetyErrorCode;
}

/**
 * Verifies external durable ChatGPT QA approval record outside the repository workspace.
 *
 * Requirements:
 * 1. MUST reside at an operator/QA-controlled location outside the repository workspace.
 *    Any record located inside the workspace is rejected as self-authorization (SELF_AUTHORIZATION_BLOCKED).
 * 2. Record must be valid JSON explicitly identifying:
 *    - taskId (must match expectedTaskId exactly)
 *    - approvalStatus (must be 'APPROVED')
 *    - approvedBy (must specify 'ChatGPT' or 'Technical Lead')
 *    - approvedCommit (must be a full 40-character hexadecimal SHA matching expectedCommitSha exactly)
 * 3. Any missing, malformed, mismatched, or unverifiable state returns approved: false.
 */
export function checkExternalQAApproval(
  options: ExternalApprovalOptions
): ExternalApprovalResult {
  const targetPath = options.filePath || DEFAULT_EXTERNAL_QA_APPROVAL_FILE;
  const workspace = options.workspaceDir || process.cwd();

  // 1. TRUST BOUNDARY: Enforce that external QA approval record MUST NOT reside inside repository workspace.
  // Files inside workspace are rejected as self-authorization.
  if (isPathInsideWorkspace(targetPath, workspace)) {
    return {
      approved: false,
      approvalSource: 'external_record',
      code: 'SELF_AUTHORIZATION_BLOCKED',
      reason: `Self-authorization blocked: QA approval record cannot reside inside repository workspace (${targetPath}). External approval must be maintained outside the workspace at ${DEFAULT_EXTERNAL_QA_APPROVAL_FILE}.`,
    };
  }

  // 2. Check existence of external approval record
  if (!fsSync.existsSync(targetPath)) {
    return {
      approved: false,
      approvalSource: 'external_record',
      reason: `External QA approval record not found at ${targetPath}`,
    };
  }

  // 3. Read and parse external approval record
  let parsed: any;
  try {
    const raw = fsSync.readFileSync(targetPath, 'utf-8').trim();
    if (!raw) {
      return {
        approved: false,
        approvalSource: 'external_record',
        reason: `External QA approval record at ${targetPath} is empty`,
        code: 'APPROVAL_SIGNAL_INVALID',
      };
    }
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        approved: false,
        approvalSource: 'external_record',
        reason: `External QA approval record at ${targetPath} is not a valid JSON object`,
        code: 'APPROVAL_SIGNAL_INVALID',
      };
    }
  } catch (err) {
    return {
      approved: false,
      approvalSource: 'external_record',
      reason: `Failed to parse external QA approval record at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // 4. Extract fields (supporting standard naming conventions)
  const rawStatus = (parsed.approvalStatus ?? parsed.status ?? parsed.QA_APPROVAL ?? '')
    .toString()
    .trim()
    .toUpperCase();
  const rawTaskId = (parsed.taskId ?? parsed.task_id ?? parsed.TASK_ID ?? '')
    .toString()
    .trim();
  const rawApprover = (parsed.approvedBy ?? parsed.approved_by ?? parsed.QA_APPROVED_BY ?? '')
    .toString()
    .trim();
  const rawCommit = (parsed.approvedCommit ?? parsed.approved_commit ?? parsed.commitSha ?? parsed.commit_sha ?? parsed.QA_APPROVED_COMMIT ?? '')
    .toString()
    .trim();

  // 5. Verify status is APPROVED
  if (rawStatus !== 'APPROVED') {
    return {
      approved: false,
      approvalStatus: rawStatus || 'PENDING',
      approvedTaskId: rawTaskId,
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      reason: `External QA approval status is "${rawStatus || 'missing'}", not "APPROVED"`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // 6. Verify approver identity is ChatGPT / Technical Lead
  const isChatGPT =
    rawApprover &&
    (rawApprover.toLowerCase().includes('chatgpt') ||
      rawApprover.toLowerCase().includes('technical lead'));
  if (!isChatGPT) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedTaskId: rawTaskId,
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      reason: `External QA approval approver is "${rawApprover || 'missing'}". Must be authorized by "ChatGPT"`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // 7. Verify task ID binding (P0-3)
  if (options.expectedTaskId) {
    const normExpectedTask = options.expectedTaskId.trim().toUpperCase();
    const normActualTask = rawTaskId.toUpperCase();
    if (!normActualTask || normActualTask !== normExpectedTask) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedTaskId: rawTaskId,
        approvedBy: rawApprover,
        approvedCommit: rawCommit,
        approvalSource: 'external_record',
        reason: `External QA approval task ID (${rawTaskId || 'missing'}) does not match completed task (${options.expectedTaskId})`,
        code: 'APPROVAL_SIGNAL_INVALID',
      };
    }
  } else if (!rawTaskId) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      reason: 'External QA approval record is missing task ID',
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // 8. Verify commit SHA binding & exact full 40-character hex (P0-2)
  if (!rawCommit || !FULL_SHA_REGEX.test(rawCommit)) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedTaskId: rawTaskId,
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      reason: `External QA approval commit SHA (${rawCommit || 'missing'}) must be a full 40-character hexadecimal SHA. Truncated, prefix, suffix, or partial SHA is rejected.`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  if (options.expectedCommitSha) {
    const normExpectedCommit = options.expectedCommitSha.trim().toLowerCase();
    const normActualCommit = rawCommit.toLowerCase();
    if (!FULL_SHA_REGEX.test(normExpectedCommit)) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedTaskId: rawTaskId,
        approvedBy: rawApprover,
        approvedCommit: rawCommit,
        approvalSource: 'external_record',
        reason: `Expected commit SHA (${options.expectedCommitSha}) must be a full 40-character hexadecimal SHA`,
        code: 'APPROVAL_SIGNAL_INVALID',
      };
    }
    if (normActualCommit !== normExpectedCommit) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedTaskId: rawTaskId,
        approvedBy: rawApprover,
        approvedCommit: rawCommit,
        approvalSource: 'external_record',
        reason: `External QA approval commit SHA (${rawCommit}) does not match completed task commit (${options.expectedCommitSha})`,
        code: 'APPROVAL_SIGNAL_INVALID',
      };
    }
  }

  // All checks pass!
  return {
    approved: true,
    approvalStatus: 'APPROVED',
    approvedTaskId: rawTaskId,
    approvedBy: rawApprover,
    approvedCommit: rawCommit.toLowerCase(),
    approvalSource: 'external_record',
  };
}

/**
 * Parses textual QA approval signal from document content.
 *
 * Requirements for valid approval:
 * 1. QA_APPROVAL must be 'APPROVED'
 * 2. QA_APPROVED_BY must specify ChatGPT (or Technical Lead)
 * 3. QA_APPROVED_COMMIT must be a full 40-character hexadecimal SHA exactly matching expectedCommitSha
 * 4. If expectedTaskId is provided, document task ID must match
 */
export function parseApprovalSignal(
  content: string,
  expectedCommitSha?: string,
  expectedTaskId?: string
): ApprovalSignal {
  const approvalMatch = content.match(/\*\*QA_APPROVAL:\*\*\s*([A-Za-z0-9_-]+)/i);
  const approvedByMatch = content.match(/\*\*QA_APPROVED_BY:\*\*\s*([^\n]+)/i);
  const approvedCommitMatch = content.match(/\*\*QA_APPROVED_COMMIT:\*\*\s*([^\s\n]+)/i);
  const taskIdMatch =
    content.match(/\*\*TASK ID:\*\*\s*([A-Za-z0-9_-]+)/i) ||
    content.match(/\*\*TASK_ID:\*\*\s*([A-Za-z0-9_-]+)/i);

  if (!approvalMatch) {
    return {
      approved: false,
      approvalSource: 'task_document',
      reason: 'No **QA_APPROVAL:** marker found in authoritative document',
      rawText: content,
    };
  }

  const rawStatus = approvalMatch[1].trim().toUpperCase();
  const approvedBy = approvedByMatch ? approvedByMatch[1].trim() : undefined;
  const approvedCommit = approvedCommitMatch ? approvedCommitMatch[1].trim() : undefined;
  const approvedTaskId = taskIdMatch ? taskIdMatch[1].trim().toUpperCase() : undefined;

  if (rawStatus !== 'APPROVED') {
    return {
      approved: false,
      approvalStatus: rawStatus as any,
      approvedTaskId,
      approvedBy,
      approvedCommit,
      approvalSource: 'task_document',
      reason: `QA_APPROVAL status is "${rawStatus}", not "APPROVED"`,
    };
  }

  // Must be approved by ChatGPT / Technical Lead
  const isApprovedByChatGPT =
    approvedBy &&
    (approvedBy.toLowerCase().includes('chatgpt') ||
      approvedBy.toLowerCase().includes('technical lead'));

  if (!isApprovedByChatGPT) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedTaskId,
      approvedBy,
      approvedCommit,
      approvalSource: 'task_document',
      reason: `QA_APPROVED_BY is "${approvedBy || 'missing'}". Must be authorized by "ChatGPT"`,
    };
  }

  // Verify task ID if expectedTaskId is provided
  if (expectedTaskId) {
    const normExpectedTask = expectedTaskId.trim().toUpperCase();
    if (!approvedTaskId || approvedTaskId !== normExpectedTask) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedTaskId,
        approvedBy,
        approvedCommit,
        approvalSource: 'task_document',
        reason: `Task ID in document (${approvedTaskId || 'missing'}) does not match completed task (${normExpectedTask})`,
      };
    }
  }

  // If approvedCommit is present, verify full 40-character hex SHA
  if (approvedCommit) {
    if (!FULL_SHA_REGEX.test(approvedCommit)) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedTaskId,
        approvedBy,
        approvedCommit,
        approvalSource: 'task_document',
        reason: `QA_APPROVED_COMMIT (${approvedCommit}) must be a full 40-character hexadecimal SHA. Truncated, prefix, suffix, or partial SHA is rejected.`,
      };
    }
  }

  // If expectedCommitSha is given, verify exact commit match
  if (expectedCommitSha) {
    if (!FULL_SHA_REGEX.test(expectedCommitSha.trim())) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedTaskId,
        approvedBy,
        approvedCommit,
        approvalSource: 'task_document',
        reason: `Expected commit SHA (${expectedCommitSha}) must be a full 40-character hexadecimal SHA`,
      };
    }
    if (!approvedCommit) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedTaskId,
        approvedBy,
        approvalSource: 'task_document',
        reason: `QA_APPROVED_COMMIT missing; required to match commit ${expectedCommitSha}`,
      };
    }

    const normExpected = expectedCommitSha.trim().toLowerCase();
    const normApproved = approvedCommit.trim().toLowerCase();
    // EXACT EQUALITY ONLY - no startsWith, no endsWith, no partial SHA
    if (normExpected !== normApproved) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedTaskId,
        approvedBy,
        approvedCommit,
        approvalSource: 'task_document',
        reason: `QA_APPROVED_COMMIT (${approvedCommit}) does not exactly match completed task commit (${expectedCommitSha})`,
      };
    }
  }

  return {
    approved: true,
    approvalStatus: 'APPROVED',
    approvedTaskId,
    approvedBy,
    approvedCommit: approvedCommit?.toLowerCase(),
    approvalSource: 'task_document',
  };
}

/**
 * Discovers if an explicitly-issued next task exists on origin/main.
 *
 * Rules:
 * - Must NOT invent task IDs or objectives.
 * - Must be parsed directly from the authoritative document.
 * - Next task must be in READY state (or LOCAL READY / REMOTE READY).
 * - If the task ID matches completedTaskId and is not re-issued, or if no task is READY, returns hasNext: false.
 */
export function discoverNextTask(
  content: string,
  completedTaskId?: string
): { hasNext: boolean; task?: TaskDefinition; reason?: string } {
  const parseResult = parseTaskDocument(content);
  if (!parseResult.ok || !parseResult.task) {
    return {
      hasNext: false,
      reason: parseResult.error || 'No valid task found in authoritative document',
    };
  }

  const task = parseResult.task;

  // Check if status is a READY variant
  const isReady =
    task.status === 'READY' ||
    task.status === 'LOCAL READY' ||
    task.status === 'REMOTE READY';

  if (!isReady) {
    return {
      hasNext: false,
      reason: `Authoritative task ${task.id} has status "${task.status}", not READY`,
    };
  }

  // If completedTaskId was provided, verify this is either a new task ID or explicitly re-issued
  if (completedTaskId && task.id === completedTaskId) {
    // If the same task ID is still there, it was already completed unless explicitly new
    return {
      hasNext: false,
      reason: `Task ${task.id} matches completed task and has not progressed to a newly-issued task`,
    };
  }

  return {
    hasNext: true,
    task,
  };
}
