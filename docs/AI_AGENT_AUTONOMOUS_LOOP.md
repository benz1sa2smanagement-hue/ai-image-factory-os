# AI Image Factory OS — ChatGPT ↔ Claude Code Handoff Loop

## Status
IMPLEMENTED (Phase C) — Governed by AutonomousSupervisor (`tools/ai-bridge/src/supervisor.ts`) and AIBridge (`tools/ai-bridge/src/bridge.ts`). Phase B was independently QA APPROVED by ChatGPT (commit `526368e`). Phase C is implemented and tested with 40 supervisor test cases.

## Purpose
Define a controlled communication loop between:

- **ChatGPT** — Technical Lead / Architecture / QA
- **Claude Code** — Developer / Repository Executor
- **GitHub** — persistent communication and evidence layer

`AI_AGENT_HANDOFF.md` remains the communication/state layer and does not become the authority for changing locked architecture.

## Hard Constraints

1. Zero paid AI/API usage remains mandatory.
2. Claude Code must use the approved free OpenRouter model path only.
3. Free quota exhaustion must stop work rather than trigger paid fallback.
4. No autonomous architecture changes.
5. No silent scope expansion.
6. No marketplace automation unless explicitly approved and verified.
7. Human approval remains required for credentials, production infrastructure creation, and architecture decisions.
8. Every implementation cycle must leave auditable Git evidence.

## Communication Protocol

```text
                    ┌─────────────────────────────┐
                    │ ChatGPT                      │
                    │ Technical Lead / QA          │
                    └──────────────┬──────────────┘
                                   │
                          Approved Task / QA
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │ GitHub                       │
                    │ Handoff + Reports + Commits │
                    └──────────────┬──────────────┘
                                   │
                              Read task
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │ Claude Code                  │
                    │ Developer                    │
                    └──────────────┬──────────────┘
                                   │
                         Code / Tests / Report
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │ GitHub                       │
                    │ Evidence / Commit / Status  │
                    └──────────────┬──────────────┘
                                   │
                              QA retrieval
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │ ChatGPT                      │
                    │ Verify → Approve / Reject   │
                    └─────────────────────────────┘
```

## State Machine

The handoff loop uses these states conceptually:

`READY → TASK_ISSUED → IMPLEMENTING → TESTING → REPORT_READY → QA_REVIEW → APPROVED`

Failure paths:

`IMPLEMENTING → BLOCKED`

`TESTING → FAILED`

`REPORT_READY → QA_REJECTED`

Architecture conflict:

`IMPLEMENTING → OPEN_DECISION`

No state transition permits Claude to self-approve an architecture change.

## Required Claude Cycle

Before every significant task Claude must:

1. Read `AI_AGENT_HANDOFF.md`.
2. Read the relevant architecture documentation.
3. Inspect current Git state.
4. Identify the exact approved task.
5. Check Open Decisions and blockers.
6. Implement only the approved scope.
7. Run the relevant tests/typechecks.
8. Inspect the final diff.
9. Update the handoff/report according to the existing protocol.
10. Commit and push only when the task explicitly authorizes implementation and repository write-back.
11. Stop and wait for QA.

## Required ChatGPT QA Cycle

ChatGPT must treat Claude's report as a claim, not proof.

QA should verify:

- commit and diff
- changed files
- tests actually run
- architecture consistency
- zero-cost policy
- quota behavior
- kill switch
- QC gate
- duplicate protection
- security implications
- unresolved blockers

A task is not considered complete merely because Claude reports `DONE`.

## Progress Checkpoints

Project progress is evidence-based and may be reported only at:

`0, 5, 10, 15, 20, ... 95, 100%`

Audit progress and project completion are separate metrics.

## Automation Boundary

The current ChatGPT environment cannot autonomously start a local Claude Code process or wake a local terminal session without an external bridge/orchestrator.

Therefore the safe architecture is:

### Phase A — Controlled handoff
ChatGPT ↔ GitHub ↔ Claude Code, with the human initiating each cycle.

### Phase B — Local bridge
A local process may watch the GitHub handoff state and launch Claude Code through the user's already-configured OpenRouter/`ori claude` environment. The bridge must enforce:

- approved repository
- approved branch
- free-only model
- no paid fallback
- one active task at a time
- explicit stop conditions
- audit logging

### Phase C — Autonomous Task Loop (Implemented)
Phase C extends the Phase B Local Bridge into an autonomous supervisor loop (`tools/ai-bridge/src/supervisor.ts`) that manages continuous task cycles across:
`LOOP_START → WAITING_FOR_TASK → TASK_ACCEPTED → TASK_EXECUTING → TASK_TESTING → TASK_QA_REVIEW → WAITING_FOR_APPROVAL → TASK_APPROVED → NEXT_TASK_DETECTED`

Key Phase C guarantees:
1. **Durable Approval Gate**: Reaching `QA_REVIEW` stops progression immediately and transitions to `WAITING_FOR_APPROVAL`. The supervisor never self-approves and requires durable ChatGPT approval:
   ```markdown
   **QA_APPROVAL:** APPROVED
   **QA_APPROVED_BY:** ChatGPT
   **QA_APPROVED_COMMIT:** <commit SHA>
   ```
2. **Next Task Rule**: On approval, discovers next task on `origin/main`. If no next task is in `READY`, it transitions to `WAITING_FOR_TASK` without inventing work or creating unapproved tasks.
3. **Persistent Single-Instance Lock**: Held throughout the entire supervisor process lifetime (`.bridge-lock`).
4. **Immediate Kill Switch**: Monitors `.bridge-stop` before every cycle and kills active child processes.
5. **Mandatory Remote Authority**: Pulls `origin/main` before every task decision (`REMOTE_SYNC_FAILED` on failure).
6. **Zero-Cost Policy Enforcement**: 402/429/quota exhaustion halts the supervisor loop immediately (`LOOP_BLOCKED`). No paid fallback.
7. **External Zero-Overage Verification**: Mandatory for Google Antigravity launcher (`HUMAN_VERIFIED` with `AI Credit Overages = Never`).


## Free-Only Guardrail

The bridge must never convert a free-model failure into a paid-model request.

Required behavior:

```text
Free model available
      ↓
Execute
      ↓
Success → report
Failure → retry only under approved free-only policy
      ↓
Free quota exhausted / unavailable
      ↓
STOP
```

Forbidden:

```text
Free unavailable → paid model
Free quota exhausted → add credits
Free model rate limit → silently switch to paid
```

## Human-Only Actions

The bridge must stop for:

- credentials or secrets
- Cloudflare resource creation
- production deployment approval
- domain/DNS changes
- architecture changes
- changes to zero-cost policy
- marketplace automation approval

## Current Recommendation

Do not build a fully autonomous production loop yet.

First prove the controlled loop with a read-only audit, then one small implementation task, then QA. Only after those cycles are reliable should the local bridge be implemented.

## Acceptance Criteria for a Future Bridge

A future bridge is acceptable only when all are demonstrated:

1. It can consume exactly one approved task.
2. It cannot invent a new task.
3. It cannot change locked architecture without an Open Decision.
4. It cannot select a paid model.
5. It stops on free quota exhaustion.
6. It records task start/finish/failure.
7. It records the exact Git commit.
8. It refuses to continue when tests fail unless explicitly instructed.
9. It preserves the existing kill-switch semantics.
10. It can be stopped immediately by the human owner.

## Important Distinction

This document defines a protocol and future automation boundary. It does **not** grant Claude Code authority over architecture, production infrastructure, or itself.
