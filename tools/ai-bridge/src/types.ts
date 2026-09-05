/**
 * AI Bridge Types — Phase B Local Bridge between ChatGPT and Claude Code / Antigravity.
 */

export type HandoffState =
  | 'LOCAL READY'
  | 'REMOTE READY'
  | 'LOCAL_READY'
  | 'REMOTE_READY'
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
  | 'TESTS_FAILED'
  | 'DUPLICATE_INSTANCE'
  | 'LAUNCHER_NOT_ALLOWED'
  | 'CHILD_PROCESS_KILLED'
  | 'GRACEFUL_SHUTDOWN'
  | 'SYNC_CONFLICT'
  | 'LOCAL_CHANGES_PRESENT';

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  code?: SafetyErrorCode;
}

/** Describes a registered launcher adapter. */
export interface LauncherAdapter {
  name: string;
  /** The binary to invoke (first element of the command). */
  binary: string;
  /** Fixed prefix arguments that are always prepended (e.g., ['claude']). */
  prefixArgs: string[];
  /** Description of the launcher environment */
  description?: string;
}

export interface BridgeConfig {
  repoAllowlist: string[];
  branchAllowlist: string[];
  taskFilePath: string;
  reportFilePath: string;
  handoffFilePath: string;
  auditLogPath: string;
  killSwitchFilePath: string;
  lockFilePath: string;
  /** Explicit allowlist of approved free model names. Suffix-matching is NOT allowed. */
  freeModelAllowlist: string[];
  /** Name of the launcher adapter to use (must be in LAUNCHER_ADAPTERS). */
  launcherName: string;
  dryRun: boolean;
  /** Watch mode: poll docs/AI_TASK.md and execute a single READY task automatically. */
  watchMode: boolean;
  /** Polling interval for watch mode in milliseconds. Default: 30000 (30s). */
  pollIntervalMs: number;
  /** Enable remote synchronization with origin/main before consuming tasks. Default: true */
  syncRemote: boolean;
  /** Remote name for git sync. Default: 'origin' */
  remoteName: string;
  /** Remote branch for git sync. Default: 'main' */
  remoteBranch: string;
}

export type AuditEventType =
  | 'TASK_START'
  | 'TASK_COMPLETE'
  | 'TASK_STOP'
  | 'TASK_BLOCKED'
  | 'STATE_TRANSITION'
  | 'KILL_SWITCH_TRIGGERED'
  | 'KILL_SWITCH_CLEARED'
  | 'KILL_SWITCH_ACTIVE'
  | 'DRY_RUN'
  | 'SAFETY_VIOLATION'
  | 'WATCH_TICK'
  | 'WATCH_START'
  | 'WATCH_STOP'
  | 'DUPLICATE_INSTANCE'
  | 'GRACEFUL_SHUTDOWN'
  | 'CHILD_KILLED'
  | 'SYNC_START'
  | 'SYNC_COMPLETE'
  | 'SYNC_CONFLICT';

export interface AuditLogEntry {
  timestamp: string;
  eventType: AuditEventType;
  taskId?: string;
  status?: HandoffState;
  model?: string;
  commitSha?: string;
  stopReason?: string;
  code?: SafetyErrorCode | string;
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
