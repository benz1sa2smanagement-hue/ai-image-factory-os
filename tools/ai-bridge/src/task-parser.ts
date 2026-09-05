import * as fs from 'node:fs/promises';
import type { TaskDefinition, HandoffState, SafetyErrorCode, ApprovalSignal } from './types.ts';

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

/**
 * Parses explicit durable ChatGPT QA approval signal from task document content.
 *
 * Requirements for valid approval:
 * 1. QA_APPROVAL must be 'APPROVED'
 * 2. QA_APPROVED_BY must specify ChatGPT (or Technical Lead)
 * 3. If expectedCommitSha is provided, QA_APPROVED_COMMIT must match the expected commit
 */
export function parseApprovalSignal(
  content: string,
  expectedCommitSha?: string
): ApprovalSignal {
  const approvalMatch = content.match(/\*\*QA_APPROVAL:\*\*\s*([A-Za-z0-9_-]+)/i);
  const approvedByMatch = content.match(/\*\*QA_APPROVED_BY:\*\*\s*([^\n]+)/i);
  const approvedCommitMatch = content.match(/\*\*QA_APPROVED_COMMIT:\*\*\s*([^\s\n]+)/i);

  if (!approvalMatch) {
    return {
      approved: false,
      reason: 'No **QA_APPROVAL:** marker found in authoritative document',
      rawText: content,
    };
  }

  const rawStatus = approvalMatch[1].trim().toUpperCase();
  const approvedBy = approvedByMatch ? approvedByMatch[1].trim() : undefined;
  const approvedCommit = approvedCommitMatch ? approvedCommitMatch[1].trim() : undefined;

  if (rawStatus !== 'APPROVED') {
    return {
      approved: false,
      approvalStatus: rawStatus as any,
      approvedBy,
      approvedCommit,
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
      approvedBy,
      approvedCommit,
      reason: `QA_APPROVED_BY is "${approvedBy || 'missing'}". Must be authorized by "ChatGPT"`,
    };
  }

  // If expectedCommitSha is given, verify exact commit match
  if (expectedCommitSha && approvedCommit) {
    const normExpected = expectedCommitSha.trim().toLowerCase();
    const normApproved = approvedCommit.trim().toLowerCase();
    if (!normExpected.startsWith(normApproved) && !normApproved.startsWith(normExpected)) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedBy,
        approvedCommit,
        reason: `QA_APPROVED_COMMIT (${approvedCommit}) does not match completed task commit (${expectedCommitSha})`,
      };
    }
  } else if (expectedCommitSha && !approvedCommit) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedBy,
      reason: `QA_APPROVED_COMMIT missing; required to match commit ${expectedCommitSha}`,
    };
  }

  return {
    approved: true,
    approvalStatus: 'APPROVED',
    approvedBy,
    approvedCommit,
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
