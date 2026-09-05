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

## Completed Task — TASK-003

**TASK ID:** TASK-003
**STATUS:** APPROVED
**TITLE:** Open Phase C Autonomous Task Loop
**APPROVED COMMIT:** `370abcf98693f11a0db9da45ed00c3f092e13395`
**QA APPROVED BY:** ChatGPT

### QA result
TASK-003 passed independent QA review. Runtime evidence confirmed:
- Ed25519 approval signature verification: `VALID`
- External trust anchor protection: `PROTECTED`
- Task ID binding: valid
- Exact 40-character commit binding: valid
- Supervisor advanced to `TASK_APPROVED`
- No next `READY` task existed at that time, so supervisor entered `WAITING_FOR_TASK`

The Phase C autonomous supervisor, kill switch, single-instance lock, remote synchronization, zero-cost gate, no-self-approval boundary, and no-task-invention rule are retained as authoritative controls for subsequent tasks.

---

## Current Task — TASK-004

**TASK ID:** TASK-004
**STATUS:** READY
**TITLE:** Phase D Zero-Cost End-to-End Image Job Pipeline (Mock-First)
**SOURCE:** `docs/TASK-004.md`

### Objective
Build the first deterministic end-to-end image-production orchestration path on top of the approved domain/state-machine foundation, without enabling production generation, marketplace upload, or paid providers.

### Scope
Implement the local/domain orchestration needed to move one image job through:

`PLANNED → QUEUED → GENERATING → GENERATED → QC → PASSED/REJECTED → METADATA → READY_TO_UPLOAD`

Reuse the existing domain state machine, provider interfaces, quota/policy abstractions, duplicate controls, retry model, storage abstractions, and audit logging. Do not introduce a parallel state model.

### Required work
1. Implement or complete a deterministic job orchestrator/service for one image job.
2. Wire the existing provider interface to a deterministic mock provider for tests and local dry-run execution.
3. Enforce the zero-cost policy before every provider invocation; paid providers and paid fallbacks must be unreachable.
4. Persist/emit audit events for every state transition and important policy decision.
5. Implement deterministic QC gating before metadata and `READY_TO_UPLOAD`.
6. Reuse the existing duplicate/near-duplicate decision interfaces and hashing layers; do not invent a competing scheme.
7. Route failures through the existing `FAILED → RETRY_WAIT → RETRY → DEAD_LETTER` model without bypassing safety/policy checks.
8. Add idempotency protection so replaying the same job cannot create duplicate accepted outputs.
9. Add focused tests for happy path, QC rejection, duplicate detection, quota denial, provider failure, retry/dead-letter, kill switch, and replay/idempotency.
10. Update architecture/operations documentation for the implemented local/mock orchestration path.

### Hard constraints
- `MAX_ALLOWED_COST = 0`
- `ALLOW_PAID_API = false`
- `MOCK_MODE` is the required end-to-end local verification path.
- Never call paid APIs and never add credits.
- Do not modify or deploy production Cloudflare resources.
- Do not enable automatic marketplace upload.
- Do not add marketplace credentials.
- Deterministic policy/security/state code remains authoritative over AI/model output.
- Do not weaken or bypass the Phase C supervisor or cryptographic QA approval gate.
- Do not create or execute TASK-005 or later work.
- Do not invent additional requirements outside this task.
- On completion, set implementation state to `QA_REVIEW` and stop.

### Acceptance criteria
- One mock image job can execute deterministically through `READY_TO_UPLOAD`.
- All transitions are validated by the existing domain state machine.
- Every important transition and policy decision is auditable.
- QC rejection prevents metadata generation and prevents `READY_TO_UPLOAD`.
- Duplicate detection prevents duplicate acceptance.
- Provider failure follows the existing retry/dead-letter policy.
- Quota denial blocks inference and never triggers a paid fallback.
- Kill switch prevents new non-critical generation work.
- Replaying the same job is idempotent and does not create a second accepted output.
- `npm test` passes with no regressions.
- `npm run typecheck` passes with zero errors.
- No production Cloudflare resource is modified.
- No real marketplace upload occurs.
- Implementation stops at `QA_REVIEW` for ChatGPT QA.

## Execution Rule
TASK-004 is explicitly authorized for execution because this document is `STATUS: READY`. The executor must not start any task other than TASK-004 and must not infer future tasks.

## QA Gate
After TASK-004 reaches `QA_REVIEW`, Claude Code / Antigravity must stop. ChatGPT will independently verify the diff, commit, tests, typecheck, safety gates, and remaining blockers before issuing cryptographic approval for progression.
