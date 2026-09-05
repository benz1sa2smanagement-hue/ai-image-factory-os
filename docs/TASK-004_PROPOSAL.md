# TASK-004 Proposal — Phase D Zero-Cost End-to-End Image Job Pipeline (Mock-First)

## Purpose
Build the first deterministic end-to-end image-production orchestration path on top of the approved domain/state-machine foundation, without enabling production generation, marketplace upload, or paid providers.

## Scope
Implement the local/domain orchestration needed to move one image job through the existing lifecycle in a fully deterministic MOCK_MODE path:

`PLANNED → QUEUED → GENERATING → GENERATED → QC → PASSED/REJECTED → METADATA → READY_TO_UPLOAD`

The implementation must use existing domain/provider/quota/policy abstractions rather than introducing a second state model.

## Required work
1. Implement or complete a deterministic job orchestrator/service for one image job.
2. Wire the existing provider interface to a mock provider for tests and local dry-run execution.
3. Enforce zero-cost policy before every provider invocation; paid providers/fallbacks remain impossible.
4. Persist/emit audit events for each state transition and important policy decision.
5. Implement deterministic QC gating before metadata and READY_TO_UPLOAD.
6. Add duplicate/near-duplicate decision hooks using existing domain interfaces; do not invent a new hashing scheme if an existing one is available.
7. Ensure failures enter the existing FAILED/RETRY_WAIT/RETRY/DEAD_LETTER model without bypassing policy checks.
8. Add idempotency protection so replaying the same job does not create duplicate successful outputs.
9. Add focused unit/integration tests for happy path, QC rejection, duplicate detection, quota denial, provider failure, retry/dead-letter, kill switch, and replay/idempotency.
10. Update architecture/operations documentation with the implemented local/mock orchestration path.

## Hard constraints
- `MAX_ALLOWED_COST = 0`
- `ALLOW_PAID_API = false`
- `MOCK_MODE` is the default and required for the end-to-end local verification path.
- Do not call paid APIs or add credits.
- Do not enable production Cloudflare mutations.
- Do not enable automatic marketplace upload.
- Do not add real marketplace credentials.
- Deterministic policy/security/state code remains authoritative over AI output.
- Do not weaken or bypass the Phase C autonomous supervisor approval gate.
- Do not invent TASK-005 or later work.
- Stop at `QA_REVIEW` after implementation and tests.

## Acceptance criteria
- One mock image job can be exercised end-to-end through `READY_TO_UPLOAD` with deterministic results.
- All transitions are validated by the existing domain state machine.
- Every important transition/policy decision is auditable.
- QC rejection prevents metadata generation and READY_TO_UPLOAD.
- Duplicate detection prevents duplicate acceptance.
- Provider failure is classified and handled by the existing retry/dead-letter policy.
- Quota denial blocks inference and never falls back to paid execution.
- Kill switch prevents new non-critical generation work.
- Replaying the same job is idempotent and does not create a second accepted output.
- `npm test` passes with no regressions.
- `npm run typecheck` passes with zero errors.
- No production Cloudflare resource is modified.
- No real marketplace upload occurs.
- Task status is left at `QA_REVIEW` for ChatGPT review.
