import { describe, it, expect } from 'vitest';
import { parseTaskDocument, updateTaskStatus } from '../src/task-parser.ts';

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
});
