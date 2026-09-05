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
- `STATUS: REJECTED` means Claude must not start another task; wait for ChatGPT.
- `STATUS: BLOCKED` means execution cannot continue safely; document the blocker in `docs/AI_REPORT.md` and stop.

## Current Task

**TASK ID:** TASK-002
**STATUS:** READY
**TITLE:** Build Phase B Local Bridge for ChatGPT ↔ Claude Code
**SOURCE:** GitHub Issue #6

### Objective
Implement Phase B of `docs/AI_AGENT_AUTONOMOUS_LOOP.md`: a local bridge on the owner's Mac that consumes exactly one approved task from this file, launches Claude Code through the existing `ori claude` environment, enforces hard safety gates, and records execution evidence.

This is controlled-loop infrastructure only. **Phase C automatic task chaining is explicitly out of scope.**

### Required work
1. Inspect the current repository and existing loop documents before editing.
2. Implement the bridge in an isolated directory, preferably `tools/ai-bridge/`.
3. Support the handoff states at minimum: READY, IMPLEMENTING, TESTING, QA_REVIEW, APPROVED, BLOCKED, REJECTED.
4. Enforce the exact repository allowlist `benz1sa2smanagement-hue/ai-image-factory-os` and branch `main`.
5. Enforce one active task at a time.
6. Never invent tasks. Consume only the current approved task from `docs/AI_TASK.md`.
7. Launch Claude only through the existing local `ori claude` path. Do not create a second credential system.
8. Enforce free-only execution at the bridge layer. Any paid model/API selection, paid fallback, billing/credits action, or account-switching action is an immediate STOP.
9. Detect provider, billing, and rate-limit failures. Account-level free quota exhaustion must STOP. Do not loop indefinitely.
10. Human-only actions must STOP: credentials/secrets, Cloudflare resource creation, production deployment, DNS/domain changes, architecture changes, marketplace automation, and changes to the zero-cost policy.
11. Add audit logging for task start/end, stop reason, safely observable model/path, and resulting Git commit. Never log secrets/tokens.
12. Add a simple human kill/stop mechanism.
13. Add safe dry-run/read-only mode.
14. Add tests for state handling, one-task enforcement, repo/branch allowlist, paid-model/paid-API stop conditions, free-quota stop condition, and kill switch.
15. Do not modify Workers/D1/R2/Queue/image-generation production architecture.
16. Do not start TASK-003 or chain tasks automatically.
17. Update `docs/AI_REPORT.md` with evidence and set this file to `QA_REVIEW` only after implementation and verification are complete.
18. Commit and push the focused TASK-002 changes to `main`.

### Hard constraints
- `MAX_ALLOWED_COST = 0`
- `ALLOW_PAID_API = false`
- No paid AI/API/model fallback.
- No credits may be added.
- No secrets, credentials, tokens, or API keys may be written to repository or logs.
- No Cloudflare provisioning.
- No live generation changes.
- No architecture-lock changes.
- No Phase C automatic task chaining.
- No paid-capable subagents.

### Acceptance criteria
- Bridge runs locally from documented command.
- Dry-run works without modifying repository/code state.
- Exactly one approved task can be consumed at a time.
- Bridge stops on paid/billing/quota conditions.
- Human-only actions cause STOP/BLOCKED.
- Kill switch works immediately.
- Audit log records task lifecycle and final commit without secrets.
- Bridge tests pass.
- `npm test` and `npm run typecheck` remain green.
- No production architecture files changed.
- TASK-003 is not started automatically.

## QA Gate
Claude's report is evidence to inspect, not automatic approval. After `STATUS: QA_REVIEW`, ChatGPT will verify the diff, commit, tests, typecheck, safety gates, and remaining blockers. Claude must stop and wait for QA.