# AI TASK — ChatGPT → Claude Code / Antigravity

## Authority
- ChatGPT = Technical Lead / Architecture / QA
- Claude Code / Antigravity = Developer / Executor
- GitHub repository state + this file = persistent task handoff channel
- `AI_AGENT_HANDOFF.md` remains the project communication/state layer; locked architecture decisions remain authoritative.

## Protocol
The developer/executor must read this file before starting implementation work.

- `STATUS: READY` means a task is approved for execution.
- `STATUS: HOLD` means do not modify code; wait for ChatGPT.
- `STATUS: QA_REVIEW` means implementation is finished and developer must stop.
- `STATUS: APPROVED` means ChatGPT has independently accepted the task.
- `STATUS: REJECTED` means developer must not start another task; wait for ChatGPT.
- `STATUS: BLOCKED` means execution cannot continue safely; document the blocker in `docs/AI_REPORT.md` and stop.

---

## Approval Gate (TASK-002)

**TASK ID:** TASK-002
**QA_APPROVAL:** APPROVED
**QA_APPROVED_BY:** ChatGPT
**QA_APPROVED_COMMIT:** 526368ebac3f7a94141d3c36e12a7a41ee8fc5f8
**SUMMARY:** TASK-002 Phase B Local Bridge independently QA APPROVED by ChatGPT. Self-authorization bypass removed, operator trust boundary enforced outside repository, and Antigravity model contract verified with quality suffixes.

---

## Current Task

**TASK ID:** TASK-003
**STATUS:** QA_REVIEW
**TITLE:** Open Phase C Autonomous Task Loop
**SOURCE:** GitHub Issue #7

### Objective
Extend the already-approved Phase B Local Bridge into the Phase C AUTONOMOUS TASK LOOP (`tools/ai-bridge/src/supervisor.ts`).
Implement an autonomous supervisor that polls for ChatGPT-approved tasks on origin/main, validates all safety gates, runs one READY task at a time, halts unconditionally at QA_REVIEW, waits for durable ChatGPT approval, and safely discovers next tasks without inventing work or starting unapproved tasks.

### Required work
1. Implement Phase C Autonomous Task Loop state machine in `tools/ai-bridge/src/supervisor.ts`.
2. Support lifecycle states: `LOOP_START`, `WAITING_FOR_TASK`, `TASK_ACCEPTED`, `TASK_EXECUTING`, `TASK_TESTING`, `TASK_QA_REVIEW`, `WAITING_FOR_APPROVAL`, `TASK_APPROVED`, `NEXT_TASK_DETECTED`, `LOOP_BLOCKED`, `LOOP_STOP`.
3. Implement ChatGPT QA approval signal verification (`parseApprovalSignal`) requiring explicit `APPROVED` from ChatGPT matching completed commit SHA.
4. Stop progression unconditionally at `QA_REVIEW` -> `WAITING_FOR_APPROVAL`. Never self-approve.
5. Implement next task discovery (`discoverNextTask`). Transition to `WAITING_FOR_TASK` when no next task is in `READY`. Never invent tasks (do NOT start TASK-004).
6. Implement single-instance lock across supervisor lifetime (`.bridge-lock`).
7. Implement immediate kill-switch polling and child-process termination (`.bridge-stop`).
8. Implement mandatory remote sync before every decision (`origin/main`), with clean worktree verification.
9. Enforce strict zero-cost constitution (`MAX_ALLOWED_COST = 0`, `ALLOW_PAID_API = false`, immediate `LOOP_BLOCKED` on 402/429/quota).
10. Add CLI commands `--loop`, `--supervisor`, `--loop-status`, `--max-cycles <N>`.
11. Build comprehensive test suite in `tools/ai-bridge/test/supervisor.test.ts` (40 tests).
12. Update documentation and set status to `QA_REVIEW`.

### Hard constraints
- `MAX_ALLOWED_COST = 0`
- `ALLOW_PAID_API = false`
- No paid AI/API/model fallback.
- No credits may be added.
- No credentials or secrets.
- Do NOT start TASK-004.
- Do NOT modify Cloudflare production resources.
- Stop at STATUS: QA_REVIEW.

### Acceptance criteria
- Autonomous supervisor runs with `--loop` or programmatically via `AutonomousSupervisor`.
- State transitions follow explicit Phase C lifecycle state machine.
- Reaching `QA_REVIEW` halts progression immediately and transitions to `WAITING_FOR_APPROVAL`.
- `WAITING_FOR_APPROVAL` requires external durable ChatGPT approval outside workspace (`~/.config/antigravity/qa-approval.json`).
- External approval record must be cryptographically signed with Ed25519 digital signature verifiable using the protected operator trust anchor (`chatgpt-qa-public-key.pem` outside repository, mode 0o400, read-only to developer process).
- Startup preflight rejects missing, malformed, writable, or workspace trust anchors (`TRUST_ANCHOR_NOT_PROTECTED`, `TRUST_ANCHOR_MISSING`, `TRUST_ANCHOR_INVALID`, `SELF_AUTHORIZATION_BLOCKED`).
- Canonical payload verification enforces deterministic serialization: `version: 1`, `status: "APPROVED"`, `approver: "ChatGPT"`, matching `approvedTaskId`, and exact 40-character `approvedCommitSha`.
- Repository-local approval files are blocked with `SELF_AUTHORIZATION_BLOCKED`. Textual markdown is informational only. No self-approval.
- Exact full 40-character hex commit SHA matching (`/^[a-fA-F0-9]{40}$/`). Short/prefix/suffix SHAs are rejected.
- Strict task ID binding: approval record must match expected task ID.
- Mandatory fresh re-sync of `origin/main` after approval before next task discovery.
- Transitions to `WAITING_FOR_TASK` when no next task is in `READY`. Never invent tasks (TASK-004 is never created).
- Zero-cost constitution strictly enforced (402, 429, billing, quota immediately cause `LOOP_BLOCKED`).
- 322 automated tests passing across 17 test files (including 30 mandatory Phase C regression tests R1-R30).
- `npm test` and `npm run typecheck` are green.
- Status is set to `QA_REVIEW` and execution stops.

## QA Gate
Developer's report is evidence to inspect, not automatic approval. After `STATUS: QA_REVIEW`, ChatGPT will verify the diff, commit, tests, typecheck, safety gates, and remaining blockers. Developer must stop and wait for QA.