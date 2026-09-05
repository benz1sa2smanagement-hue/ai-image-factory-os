/**
 * AI Bridge Types
 * Phase B Local Bridge between ChatGPT and Claude Code.
 */

export type HandoffState =
  | 'READY'
  | 'HOLD'
  | 'TASK_ISSUED'
  | 'IMPLEMENTING'
  | 'TESTING'
  | 'REPORT_READY'
  | 'QA_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'BLOCKED'
  | 'FAILED';

export interface TaskDefinition {
  id: string;
  status: HandoffState;
  title: string;
  source: string;
  objective: string;
  requiredWork: string[];
  hardConstraints: string[];
  rawText: string;
}

export type SafetyErrorCode =
  | 'REPO_NOT_ALLOWED'
  | 'BRANCH_NOT_ALLOWED'
  | 'PAID_MODEL_BLOCKED'
  | 'PAID_API_BLOCKED'
  | 'FREE_QUOTA_EXHAUSTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'CREDIT_ACTION_BLOCKED'
  | 'HUMAN_ONLY_ACTION'
  | 'KILL_SWITCH_ACTIVE'
  | 'INVALID_TASK_STATE'
  | 'MULTIPLE_TASKS_DETECTED'
  | 'TASK_NOT_FOUND'
  | 'ARCHITECTURE_LOCK_VIOLATION'
  | 'TESTS_FAILED';

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  code?: SafetyErrorCode;
}

export interface BridgeConfig {
  repoAllowlist: string[];
  branchAllowlist: string[];
  taskFilePath: string;
  reportFilePath: string;
  handoffFilePath: string;
  auditLogPath: string;
  killSwitchFilePath: string;
  freeModelAllowlist: string[];
  launcherCommand: string;
  dryRun: boolean;
}

export type AuditEventType =
  | 'TASK_START'
  | 'TASK_COMPLETE'
  | 'TASK_STOP'
  | 'TASK_BLOCKED'
  | 'STATE_TRANSITION'
  | 'KILL_SWITCH_TRIGGERED'
  | 'KILL_SWITCH_CLEARED'
  | 'DRY_RUN'
  | 'SAFETY_VIOLATION';

export interface AuditLogEntry {
  timestamp: string;
  eventType: AuditEventType;
  taskId?: string;
  status?: HandoffState;
  model?: string;
  commitSha?: string;
  stopReason?: string;
  code?: SafetyErrorCode;
  metadata?: Record<string, unknown>;
}

export interface BridgeExecutionResult {
  success: boolean;
  taskId: string;
  initialStatus: HandoffState;
  finalStatus: HandoffState;
  commitSha?: string;
  stopReason?: string;
  code?: SafetyErrorCode;
  dryRun: boolean;
}
