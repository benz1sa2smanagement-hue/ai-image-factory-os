# TASK-004 — Phase D Zero-Cost End-to-End Image Job Pipeline (Mock-First)

## Authority
- ChatGPT = Technical Lead / Architecture / QA
- Claude Code / Antigravity = Developer / Executor
- `docs/AI_TASK.md` + GitHub `main` = persistent task handoff
- Phase C supervisor and cryptographic approval gate remain authoritative and unchanged.

## STATUS
READY

## Objective
Build the first deterministic end-to-end image-production orchestration path on top of the approved domain/state-machine foundation, without enabling production generation, marketplace upload, or paid providers.

## Scope
Implement the local/domain orchestration needed to move one image job through:

`PLANNED → QUEUED → GENERATING → GENERATED → QC → PASSED/REJECTED → METADATA → READY_TO_UPLOAD`

The implementation must reuse the existing domain state machine, provider interfaces, quota/policy abstractions, duplicate controls, retry model, storage abstractions, and audit logging. No second parallel state model may be introduced.

## Required work
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

## Hard constraints
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

## Acceptance criteria
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

## Execution rule
TASK-004 is explicitly authorized for execution because this document is `STATUS: READY`. The executor must not start any task other than TASK-004 and must not infer future tasks.
