import { describe, it, expect } from 'vitest';
import { parseTaskDocument, updateTaskStatus, parseApprovalSignal, discoverNextTask } from '../src/task-parser.ts';

describe('task-parser', () => {
  const validDoc = `
# AI TASK — ChatGPT → Claude Code

## Current Task

**TASK ID:** TASK-002
**STATUS:** READY
**TITLE:** Build Phase B Local Bridge
**SOURCE:** GitHub Issue #6

### Objective
Implement Phase B of the loop.

### Required work
1. Inspect code.
2. Implement bridge in tools/ai-bridge/.
3. Run tests.

### Hard constraints
- MAX_ALLOWED_COST = 0
- ALLOW_PAID_API = false

## QA Gate
Wait for QA.
`;

  it('parses a valid task document successfully', () => {
    const res = parseTaskDocument(validDoc);
    expect(res.ok).toBe(true);
    expect(res.task).toBeDefined();
    expect(res.task?.id).toBe('TASK-002');
    expect(res.task?.status).toBe('READY');
    expect(res.task?.title).toBe('Build Phase B Local Bridge');
    expect(res.task?.source).toBe('GitHub Issue #6');
    expect(res.task?.objective).toBe('Implement Phase B of the loop.');
    expect(res.task?.requiredWork).toHaveLength(3);
    expect(res.task?.hardConstraints).toHaveLength(2);
  });

  it('fails if ## Current Task section is missing', () => {
    const invalidDoc = '# Title\n## Other Section\nNo task here.';
    const res = parseTaskDocument(invalidDoc);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('TASK_NOT_FOUND');
  });

  it('fails if no TASK ID is present in ## Current Task', () => {
    const invalidDoc = '## Current Task\n**STATUS:** READY\nNo task id.';
    const res = parseTaskDocument(invalidDoc);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('TASK_NOT_FOUND');
  });

  it('enforces exactly one active task: fails on multiple tasks', () => {
    const multiTaskDoc = `
## Current Task

**TASK ID:** TASK-002
**STATUS:** READY
**TITLE:** First task

**TASK ID:** TASK-003
**STATUS:** READY
**TITLE:** Second task
`;
    const res = parseTaskDocument(multiTaskDoc);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('MULTIPLE_TASKS_DETECTED');
  });

  it('fails on invalid status string', () => {
    const invalidStatusDoc = `
## Current Task
**TASK ID:** TASK-002
**STATUS:** INVALID_STATUS_STRING
`;
    const res = parseTaskDocument(invalidStatusDoc);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_TASK_STATE');
  });

  it('updates task status correctly', () => {
    const updated = updateTaskStatus(validDoc, 'QA_REVIEW');
    expect(updated).toContain('**STATUS:** QA_REVIEW');
    const parsed = parseTaskDocument(updated);
    expect(parsed.ok).toBe(true);
    expect(parsed.task?.status).toBe('QA_REVIEW');
  });

  describe('parseApprovalSignal', () => {
    it('approves when QA_APPROVAL is APPROVED by ChatGPT with matching commit SHA', () => {
      const doc = `
# AI TASK
## Approval Gate
**QA_APPROVAL:** APPROVED
**QA_APPROVED_BY:** ChatGPT
**QA_APPROVED_COMMIT:** 526368e
`;
      const signal = parseApprovalSignal(doc, '526368e');
      expect(signal.approved).toBe(true);
      expect(signal.approvalStatus).toBe('APPROVED');
      expect(signal.approvedBy).toBe('ChatGPT');
      expect(signal.approvedCommit).toBe('526368e');
    });

    it('rejects when QA_APPROVAL marker is missing', () => {
      const doc = '# AI TASK\nNo approval markers here.';
      const signal = parseApprovalSignal(doc, '526368e');
      expect(signal.approved).toBe(false);
      expect(signal.reason).toContain('No **QA_APPROVAL:** marker found');
    });

    it('rejects when QA_APPROVAL is not APPROVED (e.g. REJECTED or PENDING)', () => {
      const doc = `
**QA_APPROVAL:** REJECTED
**QA_APPROVED_BY:** ChatGPT
**QA_APPROVED_COMMIT:** 526368e
`;
      const signal = parseApprovalSignal(doc, '526368e');
      expect(signal.approved).toBe(false);
      expect(signal.reason).toContain('QA_APPROVAL status is "REJECTED"');
    });

    it('rejects when QA_APPROVED_BY is not ChatGPT / Technical Lead', () => {
      const doc = `
**QA_APPROVAL:** APPROVED
**QA_APPROVED_BY:** AutonomousAgent
**QA_APPROVED_COMMIT:** 526368e
`;
      const signal = parseApprovalSignal(doc, '526368e');
      expect(signal.approved).toBe(false);
      expect(signal.reason).toContain('Must be authorized by "ChatGPT"');
    });

    it('rejects when QA_APPROVED_COMMIT does not match expected commit SHA', () => {
      const doc = `
**QA_APPROVAL:** APPROVED
**QA_APPROVED_BY:** ChatGPT
**QA_APPROVED_COMMIT:** wrongcommit123
`;
      const signal = parseApprovalSignal(doc, '526368e');
      expect(signal.approved).toBe(false);
      expect(signal.reason).toContain('does not match completed task commit');
    });
  });

  describe('discoverNextTask', () => {
    it('discovers next explicit task when ID is new and status is READY', () => {
      const nextDoc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** READY
**TITLE:** Open Phase C Autonomous Task Loop
`;
      const discovery = discoverNextTask(nextDoc, 'TASK-002');
      expect(discovery.hasNext).toBe(true);
      expect(discovery.task?.id).toBe('TASK-003');
    });

    it('refuses to discover next task if document still has completed task ID not re-issued', () => {
      const sameTaskDoc = `
## Current Task
**TASK ID:** TASK-002
**STATUS:** QA_REVIEW
**TITLE:** Build Phase B Local Bridge
`;
      const discovery = discoverNextTask(sameTaskDoc, 'TASK-002');
      expect(discovery.hasNext).toBe(false);
    });

    it('refuses to discover next task if task status is not READY', () => {
      const notReadyDoc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** HOLD
**TITLE:** Next task on hold
`;
      const discovery = discoverNextTask(notReadyDoc, 'TASK-002');
      expect(discovery.hasNext).toBe(false);
      expect(discovery.reason).toContain('not READY');
    });

    it('does not invent task IDs or objectives', () => {
      const emptyDoc = '## Current Task\nNothing here';
      const discovery = discoverNextTask(emptyDoc, 'TASK-002');
      expect(discovery.hasNext).toBe(false);
      expect(discovery.task).toBeUndefined();
    });
  });
});
