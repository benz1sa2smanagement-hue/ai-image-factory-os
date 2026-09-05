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

export type ProviderType = 'openrouter' | 'antigravity';

export type CostPolicy =
  | 'free-tier'
  | 'subscription_with_zero_overage'
  | 'unsupported';

export type ModelSelectionMode =
  | 'explicit'
  | 'provider_controlled'
  | 'unsupported';

export type ZeroOverageVerificationState =
  | 'HUMAN_VERIFIED'
  | 'UNVERIFIED'
  | 'NOT_APPLICABLE'
  | 'VERIFIED'
  | 'N/A';

export type CreditFallbackState = 'DISABLED' | 'ENABLED' | 'UNKNOWN';

export type SafetyErrorCode =
  | 'REPO_NOT_ALLOWED'
  | 'BRANCH_NOT_ALLOWED'
  | 'PAID_MODEL_BLOCKED'
  | 'PAID_API_BLOCKED'
  | 'FREE_QUOTA_EXHAUSTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'BILLING_ERROR'
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
  | 'PROVIDER_NOT_ALLOWED'
  | 'MODEL_PROVIDER_MISMATCH'
  | 'CHILD_PROCESS_KILLED'
  | 'GRACEFUL_SHUTDOWN'
  | 'SYNC_CONFLICT'
  | 'LOCAL_CHANGES_PRESENT'
  | 'REMOTE_SYNC_FAILED'
  | 'ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED'
  | 'ANTIGRAVITY_CREDIT_FALLBACK_ENABLED'
  | 'ANTIGRAVITY_CREDIT_FALLBACK_UNVERIFIED'
  | 'SELF_AUTHORIZATION_BLOCKED'
  | 'MODEL_NOT_IN_CLI'
  | 'CLI_MODEL_POLICY_MISMATCH'
  | 'ANTIGRAVITY_MODEL_POLICY_MISMATCH'
  | 'APPROVAL_SIGNAL_INVALID'
  | 'TRUST_ANCHOR_NOT_PROTECTED'
  | 'TRUST_ANCHOR_MISSING'
  | 'TRUST_ANCHOR_INVALID'
  | 'SUPERVISOR_BLOCKED'
  | 'NO_READY_TASK'
  | 'EXECUTION_NOOP';

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  code?: SafetyErrorCode;
}

export interface LauncherAdapter {
  name: string;
  provider: ProviderType;
  costPolicy: CostPolicy;
  modelSelectionMode: ModelSelectionMode;
  binary: string;
  prefixArgs: string[];
  modelArgFlag?: string;
  isHeadlessPrompt?: boolean;
  approvedModels: readonly string[];
  defaultModel: string;
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
  operatorVerificationFilePath: string;
  zeroOverageVerificationFilePath?: string;
  qaApprovalFilePath: string;
  antigravitySettingsPath?: string;
  launcherName: string;
  model?: string;
  dryRun: boolean;
  watchMode: boolean;
  pollIntervalMs: number;
  syncRemote: boolean;
  remoteName: string;
  remoteBranch: string;
  allowedProviders: ProviderType[];
}

export type SupervisorState =
  | 'LOOP_START'
  | 'WAITING_FOR_TASK'
  | 'TASK_ACCEPTED'
  | 'TASK_EXECUTING'
  | 'TASK_TESTING'
  | 'TASK_QA_REVIEW'
  | 'WAITING_FOR_APPROVAL'
  | 'TASK_APPROVED'
  | 'NEXT_TASK_DETECTED'
  | 'LOOP_STOP'
  | 'LOOP_BLOCKED';

export interface ApprovalSignal {
  approved: boolean;
  approvalStatus?: 'APPROVED' | 'REJECTED' | 'PENDING' | string;
  approvedTaskId?: string;
  approvedBy?: string;
  approvedCommit?: string;
  approvalSource?: 'external_record' | 'task_document';
  signatureVerification?: 'VALID' | 'FAILED' | 'MISSING' | 'INVALID';
  approvalPublicKeyId?: string;
  trustAnchorProtection?: 'PROTECTED' | 'UNPROTECTED' | 'MISSING' | 'INVALID';
  rawText?: string;
  reason?: string;
  code?: SafetyErrorCode;
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
  | 'SYNC_CONFLICT'
  | 'SYNC_FAILED'
  | 'LOOP_START'
  | 'WAITING_FOR_TASK'
  | 'TASK_ACCEPTED'
  | 'TASK_EXECUTING'
  | 'TASK_TESTING'
  | 'TASK_QA_REVIEW'
  | 'WAITING_FOR_APPROVAL'
  | 'TASK_APPROVED'
  | 'NEXT_TASK_DETECTED'
  | 'LOOP_STOP'
  | 'LOOP_BLOCKED';

export interface AuditLogEntry {
  timestamp: string;
  eventType: AuditEventType;
  taskId?: string;
  status?: HandoffState;
  supervisorState?: SupervisorState;
  provider?: ProviderType;
  launcher?: string;
  model?: string;
  costPolicy?: CostPolicy;
  zeroOverageVerificationState?: ZeroOverageVerificationState;
  creditFallbackState?: CreditFallbackState;
  modelRuntimeVerification?: string;
  approvalState?: 'APPROVED' | 'REJECTED' | 'PENDING' | string;
  approvalTaskId?: string;
  approvalCommitSha?: string;
  approvalSource?: string;
  signatureVerification?: string;
  approvalPublicKeyId?: string;
  trustAnchorProtection?: string;
  commitSha?: string;
  stopReason?: string;
  code?: SafetyErrorCode | string;
  safetyCode?: SafetyErrorCode | string;
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
