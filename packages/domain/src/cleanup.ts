/** Safe cleanup rules — never delete pending / kept / uploaded assets */

export interface CleanupCandidate {
  id: string;
  status: string;
  uploaded: boolean;
  keep: boolean;
  hasPendingJob: boolean;
  storageKey?: string | null;
  createdAt: string;
  retentionDays: number;
}

export type CleanupDecision =
  | { action: 'delete'; reason: string }
  | { action: 'skip'; reason: string };

export function decideCleanup(c: CleanupCandidate, now = Date.now()): CleanupDecision {
  if (c.uploaded) {
    return { action: 'skip', reason: 'uploaded == true' };
  }
  if (c.keep) {
    return { action: 'skip', reason: 'KEEP flag set' };
  }
  if (c.hasPendingJob) {
    return { action: 'skip', reason: 'pending job exists' };
  }
  const cleanable = ['REJECTED', 'FAILED', 'ARCHIVED', 'DELETED', 'DEAD_LETTER'].includes(c.status);
  if (!cleanable) {
    return { action: 'skip', reason: `status ${c.status} not cleanable` };
  }
  const ageMs = now - new Date(c.createdAt).getTime();
  const retentionMs = c.retentionDays * 24 * 60 * 60 * 1000;
  if (ageMs < retentionMs) {
    return { action: 'skip', reason: 'within retention window' };
  }
  if (!c.storageKey) {
    return { action: 'skip', reason: 'no storage key' };
  }
  return { action: 'delete', reason: 'past retention and safe' };
}
