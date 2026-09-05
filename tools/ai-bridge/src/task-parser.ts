import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import type * as crypto from 'node:crypto';
import type { TaskDefinition, HandoffState, SafetyErrorCode, ApprovalSignal } from './types.ts';
import { isPathInsideWorkspace } from './safety.ts';
import { DEFAULT_EXTERNAL_QA_APPROVAL_FILE } from './constants.ts';
import {
  canonicalizeApprovalPayload,
  verifyEd25519Signature,
  loadProtectedTrustAnchor,
  type ApprovalPayload,
  type ExternalApprovalArtifact,
  type QAApprovalVerifier,
} from './crypto.ts';

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
/**
 * Options for verifying external durable QA approval.
 */
export interface ExternalApprovalOptions {
  filePath?: string;
  workspaceDir?: string;
  expectedTaskId?: string;
  expectedCommitSha?: string;
  /** Test-only verifier dependency. Production CLI cannot set this. */
  testVerifier?: QAApprovalVerifier;
  /** Custom trust anchor path for testing */
  trustAnchorPath?: string;
}

/**
 * Result of checking external durable QA approval.
 */
export type ExternalApprovalResult = ApprovalSignal;

/**
 * Verifies external durable ChatGPT QA approval artifact outside the repository workspace.
 *
 * Requirements:
 * 1. MUST reside at an operator/QA-controlled location outside the repository workspace.
 *    Any record located inside the workspace is rejected as self-authorization (SELF_AUTHORIZATION_BLOCKED).
 * 2. Record must be a cryptographic approval artifact containing:
 *    - payload: { version: 1, status: "APPROVED", approver: "ChatGPT", approvedTaskId, approvedCommitSha, approvedAt }
 *    - signature: Base64-encoded Ed25519 digital signature over the canonical payload JSON
 * 3. Signature is verified against the operator-controlled protected trust anchor.
 * 4. Any missing, malformed, extra ambiguous, mismatched, unsigned, or cryptographically invalid state returns approved: false.
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
      signatureVerification: 'INVALID',
      trustAnchorProtection: 'UNPROTECTED',
      code: 'SELF_AUTHORIZATION_BLOCKED',
      reason: `Self-authorization blocked: QA approval record cannot reside inside repository workspace (${targetPath}). External approval must be maintained outside the workspace at ${DEFAULT_EXTERNAL_QA_APPROVAL_FILE}.`,
    };
  }

  // 2. Resolve Trust Anchor (Production loads protected OS trust anchor; tests use testVerifier)
  let trustedPublicKey: string;
  let keyFingerprint: string;
  let trustAnchorProtection: 'PROTECTED' | 'UNPROTECTED' | 'MISSING' | 'INVALID';

  if (options.testVerifier) {
    const testAnchor = options.testVerifier.getTrustAnchor();
    if (testAnchor.protectionState !== 'PROTECTED') {
      return {
        approved: false,
        approvalStatus: 'REJECTED',
        approvalSource: 'external_record',
        signatureVerification: 'FAILED',
        trustAnchorProtection: testAnchor.protectionState,
        reason: testAnchor.reason || 'Test trust anchor protection failed',
        code: testAnchor.code || 'TRUST_ANCHOR_NOT_PROTECTED',
      };
    }
    trustedPublicKey = testAnchor.publicKeyPem;
    keyFingerprint = testAnchor.keyFingerprint;
    trustAnchorProtection = testAnchor.protectionState;
  } else {
    // PRODUCTION: Load protected trust anchor from OS-level operator location
    const anchorResult = loadProtectedTrustAnchor({
      workspaceRoot: workspace,
      trustAnchorPath: options.trustAnchorPath,
    });
    if (!anchorResult.protected) {
      return {
        approved: false,
        approvalStatus: 'REJECTED',
        approvalSource: 'external_record',
        signatureVerification: 'FAILED',
        trustAnchorProtection: anchorResult.protectionState,
        reason: `Trust anchor protection verification failed: ${anchorResult.reason}`,
        code: anchorResult.code || 'TRUST_ANCHOR_NOT_PROTECTED',
      };
    }
    trustedPublicKey = anchorResult.publicKeyPem!;
    keyFingerprint = anchorResult.keyFingerprint!;
    trustAnchorProtection = anchorResult.protectionState;
  }

  // 3. Check existence of external approval record
  if (!fsSync.existsSync(targetPath)) {
    return {
      approved: false,
      approvalSource: 'external_record',
      signatureVerification: 'MISSING',
      trustAnchorProtection,
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
        signatureVerification: 'INVALID',
        reason: `External QA approval record at ${targetPath} is empty`,
        code: 'APPROVAL_SIGNAL_INVALID',
      };
    }
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        approved: false,
        approvalSource: 'external_record',
        signatureVerification: 'INVALID',
        reason: `External QA approval record at ${targetPath} is not a valid JSON object`,
        code: 'APPROVAL_SIGNAL_INVALID',
      };
    }
  } catch (err) {
    return {
      approved: false,
      approvalSource: 'external_record',
      signatureVerification: 'INVALID',
      reason: `Failed to parse external QA approval record at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // 4. Verify artifact format: must contain payload and signature
  if (!parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) {
    return {
      approved: false,
      approvalSource: 'external_record',
      signatureVerification: 'MISSING',
      reason: 'External QA approval record missing valid "payload" object (cryptographic approval artifact required)',
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  if (!parsed.signature || typeof parsed.signature !== 'string' || !parsed.signature.trim()) {
    return {
      approved: false,
      approvalSource: 'external_record',
      signatureVerification: 'MISSING',
      reason: 'External QA approval record missing valid "signature" string (Ed25519 signature required)',
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  const payload = parsed.payload;

  // 5. Reject extra keys or missing keys in payload (exact canonical fields only)
  const payloadKeys = Object.keys(payload);
  const requiredKeys = ['version', 'status', 'approver', 'approvedTaskId', 'approvedCommitSha', 'approvedAt'];
  const hasExactKeys =
    payloadKeys.length === requiredKeys.length &&
    requiredKeys.every((k) => Object.prototype.hasOwnProperty.call(payload, k));

  if (!hasExactKeys) {
    return {
      approved: false,
      approvalSource: 'external_record',
      signatureVerification: 'INVALID',
      reason: `External QA approval payload has invalid, missing, or extra ambiguous keys. Required keys: ${requiredKeys.join(', ')}`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // 6. Validate payload field values
  if (payload.version !== 1) {
    return {
      approved: false,
      approvalSource: 'external_record',
      signatureVerification: 'INVALID',
      reason: `External QA approval payload version is ${payload.version}. Only version 1 is supported`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  const rawStatus = String(payload.status).trim().toUpperCase();
  const rawTaskId = String(payload.approvedTaskId).trim();
  const rawApprover = String(payload.approver).trim();
  const rawCommit = String(payload.approvedCommitSha).trim();
  const rawApprovedAt = String(payload.approvedAt).trim();

  // Validate status is APPROVED
  if (rawStatus !== 'APPROVED') {
    return {
      approved: false,
      approvalStatus: rawStatus || 'PENDING',
      approvedTaskId: rawTaskId,
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      signatureVerification: 'INVALID',
      reason: `External QA approval status is "${rawStatus}", not "APPROVED"`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // Validate approver identity is ChatGPT / Technical Lead
  const isChatGPT =
    rawApprover.toLowerCase().includes('chatgpt') ||
    rawApprover.toLowerCase().includes('technical lead');
  if (!isChatGPT) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedTaskId: rawTaskId,
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      signatureVerification: 'INVALID',
      reason: `External QA approval approver is "${rawApprover}". Must be authorized by "ChatGPT"`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // Validate task ID binding
  if (!rawTaskId) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      signatureVerification: 'INVALID',
      reason: 'External QA approval payload is missing approvedTaskId',
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }
  if (options.expectedTaskId) {
    const normExpectedTask = options.expectedTaskId.trim().toUpperCase();
    if (rawTaskId.toUpperCase() !== normExpectedTask) {
      return {
        approved: false,
        approvalStatus: 'APPROVED',
        approvedTaskId: rawTaskId,
        approvedBy: rawApprover,
        approvedCommit: rawCommit,
        approvalSource: 'external_record',
        signatureVerification: 'INVALID',
        reason: `External QA approval task ID (${rawTaskId}) does not match completed task (${options.expectedTaskId})`,
        code: 'APPROVAL_SIGNAL_INVALID',
      };
    }
  }

  // Validate commit SHA is full 40-character hex
  if (!FULL_SHA_REGEX.test(rawCommit)) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedTaskId: rawTaskId,
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      signatureVerification: 'INVALID',
      reason: `External QA approval commit SHA (${rawCommit}) must be a full 40-character hexadecimal SHA. Truncated, prefix, suffix, or partial SHA is rejected.`,
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
        signatureVerification: 'INVALID',
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
        signatureVerification: 'INVALID',
        reason: `External QA approval commit SHA (${rawCommit}) does not match completed task commit (${options.expectedCommitSha})`,
        code: 'APPROVAL_SIGNAL_INVALID',
      };
    }
  }

  // Validate approvedAt timestamp
  if (!rawApprovedAt || isNaN(Date.parse(rawApprovedAt))) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedTaskId: rawTaskId,
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      signatureVerification: 'INVALID',
      reason: `External QA approval payload has invalid approvedAt timestamp: "${rawApprovedAt}"`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // 7. Canonicalize payload
  const canonical = canonicalizeApprovalPayload({
    version: 1,
    status: 'APPROVED',
    approver: rawApprover,
    approvedTaskId: rawTaskId,
    approvedCommitSha: rawCommit,
    approvedAt: rawApprovedAt,
  });

  // 8. Cryptographically verify Ed25519 signature
  const sigResult = verifyEd25519Signature(canonical, parsed.signature.trim(), trustedPublicKey);

  if (!sigResult.valid) {
    return {
      approved: false,
      approvalStatus: 'APPROVED',
      approvedTaskId: rawTaskId,
      approvedBy: rawApprover,
      approvedCommit: rawCommit,
      approvalSource: 'external_record',
      signatureVerification: 'FAILED',
      trustAnchorProtection,
      approvalPublicKeyId: sigResult.keyFingerprint || keyFingerprint,
      reason: `Cryptographic approval signature verification failed: ${sigResult.reason}`,
      code: 'APPROVAL_SIGNAL_INVALID',
    };
  }

  // All checks pass cryptographically!
  return {
    approved: true,
    approvalStatus: 'APPROVED',
    approvedTaskId: rawTaskId,
    approvedBy: rawApprover,
    approvedCommit: rawCommit.toLowerCase(),
    approvalSource: 'external_record',
    signatureVerification: 'VALID',
    approvalPublicKeyId: sigResult.keyFingerprint || keyFingerprint,
    trustAnchorProtection: 'PROTECTED',
  };
}

/**
 * Parses textual QA approval metadata from document content.
 *
 * NOTE: Repository-local textual approval in docs/AI_TASK.md is strictly INFORMATIONAL METADATA.
 * It CANNOT authorize TASK_APPROVED or autonomous progression.
 * Cryptographic external approval artifact (~/.config/antigravity/qa-approval.json) is required.
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
      signatureVerification: 'MISSING',
      reason: 'No **QA_APPROVAL:** marker found in authoritative document',
      rawText: content,
    };
  }

  const rawStatus = approvalMatch[1].trim().toUpperCase();
  const approvedBy = approvedByMatch ? approvedByMatch[1].trim() : undefined;
  const approvedCommit = approvedCommitMatch ? approvedCommitMatch[1].trim() : undefined;
  const approvedTaskId = taskIdMatch ? taskIdMatch[1].trim().toUpperCase() : undefined;

  // Repository-local textual approval is strictly informational metadata.
  // Cryptographic external approval artifact signed with Ed25519 is mandatory for TASK_APPROVED.
  return {
    approved: false,
    approvalStatus: rawStatus || 'PENDING',
    approvedTaskId,
    approvedBy,
    approvedCommit: approvedCommit?.toLowerCase(),
    approvalSource: 'task_document',
    signatureVerification: 'MISSING',
    reason:
      'Repository-local textual approval in docs/AI_TASK.md is informational only; signed cryptographic external approval artifact (~/.config/antigravity/qa-approval.json) is required.',
    code: 'APPROVAL_SIGNAL_INVALID',
    rawText: content,
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
