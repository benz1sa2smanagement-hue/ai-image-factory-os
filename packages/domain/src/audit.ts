/** Audit helpers — every important transition must be loggable */

export interface AuditEntry {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  from_state?: string;
  to_state?: string;
  actor?: string;
  details?: Record<string, unknown>;
  created_at: string;
}

export function makeAuditId(): string {
  return `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function transitionAudit(
  entityType: string,
  entityId: string,
  from: string,
  to: string,
  actor = 'system',
  details?: Record<string, unknown>
): AuditEntry {
  return {
    id: makeAuditId(),
    entity_type: entityType,
    entity_id: entityId,
    action: 'state_transition',
    from_state: from,
    to_state: to,
    actor,
    details,
    created_at: new Date().toISOString(),
  };
}
