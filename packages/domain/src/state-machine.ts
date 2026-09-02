/** Asset / job state machine — no illegal transitions */

export const ASSET_STATES = [
  'PLANNED',
  'QUEUED',
  'GENERATING',
  'GENERATED',
  'QC',
  'PASSED',
  'REJECTED',
  'METADATA',
  'READY_TO_UPLOAD',
  'UPLOADING',
  'UPLOADED',
  'TRACKING',
  'ARCHIVED',
  'DELETED',
  'FAILED',
  'RETRY_WAIT',
  'RETRY',
  'DEAD_LETTER',
] as const;

export type AssetState = (typeof ASSET_STATES)[number];

const TRANSITIONS: Record<AssetState, readonly AssetState[]> = {
  PLANNED: ['QUEUED', 'FAILED'],
  QUEUED: ['GENERATING', 'FAILED', 'RETRY_WAIT'],
  GENERATING: ['GENERATED', 'FAILED'],
  GENERATED: ['QC', 'FAILED'],
  QC: ['PASSED', 'REJECTED', 'FAILED'],
  PASSED: ['METADATA', 'FAILED'],
  REJECTED: ['ARCHIVED', 'DELETED', 'RETRY'],
  METADATA: ['READY_TO_UPLOAD', 'FAILED'],
  READY_TO_UPLOAD: ['UPLOADING', 'ARCHIVED'],
  UPLOADING: ['UPLOADED', 'FAILED', 'READY_TO_UPLOAD'],
  UPLOADED: ['TRACKING', 'ARCHIVED'],
  TRACKING: ['ARCHIVED'],
  ARCHIVED: ['DELETED'],
  DELETED: [],
  FAILED: ['RETRY_WAIT', 'DEAD_LETTER'],
  RETRY_WAIT: ['RETRY', 'DEAD_LETTER'],
  RETRY: ['QUEUED', 'GENERATING', 'DEAD_LETTER'],
  DEAD_LETTER: [],
};

export function canTransition(from: AssetState, to: AssetState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: AssetState, to: AssetState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal state transition: ${from} → ${to}`);
  }
}

export function isTerminal(state: AssetState): boolean {
  return state === 'DELETED' || state === 'DEAD_LETTER' || state === 'ARCHIVED';
}
