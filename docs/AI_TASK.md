# AI TASK — ChatGPT → Claude Code

## Authority
- ChatGPT = Technical Lead / Architecture / QA
- Claude Code = Developer / Executor
- GitHub repository state + this file = persistent task handoff channel
- `AI_AGENT_HANDOFF.md` remains the project communication/state layer; locked architecture decisions remain authoritative.

## Protocol
Claude Code must read this file before starting implementation work.

- `STATUS: READY` means a task is approved for execution.
- `STATUS: HOLD` means do not modify code; wait for ChatGPT.
- `STATUS: QA_REVIEW` means implementation is finished and Claude must stop.
- `STATUS: APPROVED` means ChatGPT has independently accepted the task.
- `STATUS: REJECTED` means Claude must not start another task; wait for a new task.

## Current Task

**TASK ID:** TASK-001
**STATUS:** READY
**TITLE:** Stabilize Domain/Test Layer
**SOURCE:** GitHub Issue #5

### Objective
Make the existing domain/test layer green without changing the locked architecture.

### Required work
1. Inspect current code/tests before editing.
2. Fix SHA-256 duplicate-test fixtures to valid 64-character hexadecimal SHA-256 values. Do not weaken production validation in `packages/domain/src/duplicate.ts`.
3. Fix the JPEG decoder test/contract issue using the smallest correct implementation/test change consistent with the existing architecture. Do not expand decoder scope.
4. Fix TypeScript errors in `jobs-d1.test.ts` and directly related test typing.
5. Ensure `workers/consumer/` tests are included in the intended Vitest configuration without broad unrelated test scope.
6. Run `npm test`.
7. Run `npm run typecheck`.
8. Fix only failures within this task scope; otherwise report blockers with evidence.
9. Update `AI_AGENT_HANDOFF.md` with verified status/evidence.
10. Commit and push the focused changes to `main`.
11. Update `docs/AI_REPORT.md` with the completion evidence.
12. Stop. Do not start TASK-002.

### Hard constraints
- `MAX_ALLOWED_COST = 0`
- `ALLOW_PAID_API = false`
- No paid AI/API/model fallback.
- Free quota exhausted or unavailable => STOP. Never add credits.
- No Cloudflare resource provisioning.
- No live generation.
- No authentication/security architecture work (OD-001).
- No dashboard.
- No architecture-lock changes.
- No secrets, credentials, tokens, or API keys.
- No subagents that can route to paid models.

### Important execution rule
Do not use WebFetch/WebSearch or external web APIs merely to retrieve this task. The task is persisted in this repository. Read `docs/AI_TASK.md` directly from the checked-out repository.

## QA Gate
Claude's report is evidence to inspect, not automatic approval. After `STATUS: QA_REVIEW`, ChatGPT will verify the diff, commit, tests, typecheck, architecture constraints, and remaining blockers. Claude must wait for the next task.

## Handoff State
At completion Claude should set the task state in this file to `QA_REVIEW` only if the implementation and requested verification are complete. If blocked, set `STATUS: BLOCKED` and document the blocker in `docs/AI_REPORT.md`.
