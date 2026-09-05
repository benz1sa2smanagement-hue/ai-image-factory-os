# AI REPORT — Claude Code → ChatGPT

## Status
`QA_REVIEW`

## Task
- Task ID: TASK-002 (REWORK 4 — Final Provider / Model Contract Fix)
- Title: Clean separation of Provider and Model contracts, explicit agy -p --model invocation, and subscription entitlement policy
- Source: `docs/AI_TASK.md` / GitHub Issue #6

---

## REWORK 4 Summary

This rework addresses the final provider and model contract issue raised by ChatGPT QA.

### Key Changes Implemented

1. **Explicit Provider & Model Separation**:
   - Providers (`openrouter`, `antigravity`, `anthropic`) and models are now cleanly decoupled.
   - Each launcher specifies:
     - `provider`: `openrouter` | `antigravity` | `anthropic`
     - `costPolicy`: `free-tier` | `subscription_entitlement`
     - `modelSelectionMode`: `explicit` | `provider_controlled`
     - `approvedModels`: dedicated allowlist per provider
     - `defaultModel`: approved default slug

2. **Antigravity Interface Contract (`agy -p "<prompt>" --model <slug>`)**:
   - Explicitly invokes `agy -p "<prompt>" --model <slug>`.
   - `verifyAgyInterface()` verifies the CLI supports both `-p` and `--model`.
   - Dedicated `APPROVED_ANTIGRAVITY_MODELS` allowlist (`gemini-2.0-flash`, `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-1.5-flash`, `gemini-1.5-pro`).
   - Never claims an OpenRouter `:free` model was used by Antigravity.
   - Cross-provider model mismatches are blocked with `MODEL_PROVIDER_MISMATCH`.

3. **Explicit Zero-Cost Policy for Antigravity**:
   - Antigravity uses `cost_policy: subscription_entitlement` (Google AI Pro entitlement, zero per-token cost).
   - OpenRouter uses `cost_policy: free-tier`.
   - The bridge rejects any unapproved provider or model.
   - Pay-per-use, credit purchase, and paid fallback are strictly blocked.

4. **Audit Logging Transparency**:
   - Every audit log entry now explicitly records `provider`, `launcher`, `model`, and `costPolicy`.

---

## Files Changed

### Modified Files
- `tools/ai-bridge/src/types.ts` — Added `ProviderType`, `CostPolicy`, `ModelSelectionMode`, `PROVIDER_NOT_ALLOWED`, `MODEL_PROVIDER_MISMATCH`, and audit log fields
- `tools/ai-bridge/src/constants.ts` — Defined `APPROVED_PROVIDERS`, `APPROVED_OPENROUTER_FREE_MODELS`, `APPROVED_ANTIGRAVITY_MODELS`, and updated `LAUNCHER_ADAPTERS` with explicit contracts
- `tools/ai-bridge/src/safety.ts` — Implemented `validateProviderAndModel()` with mismatch guards and cost policy checks
- `tools/ai-bridge/src/bridge.ts` — Updated `defaultVerifyAgyInterface()` for `--model`, passed `--model` in `spawnWithKillSwitchMonitor()`, and logged provider/model/costPolicy
- `tools/ai-bridge/src/cli.ts` — Documented providers, models, and cost policies in CLI help and status
- `tools/ai-bridge/README.md` — Detailed Provider & Model Contract, safe commands, and cost policies
- `tools/ai-bridge/test/safety.test.ts` — Added 8 unit tests for provider/model contract validation and mismatch detection
- `tools/ai-bridge/test/bridge.test.ts` — Added 4 integration tests for Antigravity model passing, mismatch rejection, unapproved model rejection, and audit log tracking

---

## Verification Evidence

### Automated Test Suite
```
npm test: 201 passed / 0 failed / 16 test files (all green)
```
- `tools/ai-bridge/test/safety.test.ts` (35 tests) — Provider/model contract, mismatch detection, explicit allowlists, quota detection
- `tools/ai-bridge/test/bridge.test.ts` (33 tests) — Antigravity explicit `--model`, mismatch rejection, audit logging, agy interface verification, prompt construction, remote authority, lock, kill-switch
- `tools/ai-bridge/test/git-utils.test.ts` (5 tests) — Remote authority verification, fetch failure => REMOTE_SYNC_FAILED, conflict protection
- `tools/ai-bridge/test/lock.test.ts` (6 tests) — Single-instance atomic file lock
- `tools/ai-bridge/test/kill-switch.test.ts` (4 tests) — Immediate kill-switch detection and clearing
- `tools/ai-bridge/test/task-parser.test.ts` (6 tests) — Single-task enforcement, multi-word status parsing
- `tools/ai-bridge/test/audit-logger.test.ts` (5 tests) — Secret masking and JSON Lines audit log formatting
- Domain/worker tests (107 tests) — All passing

### Typechecks
```
npm run typecheck: PASS (tsc -p packages/domain --noEmit)
npx tsc -p tools/ai-bridge --noEmit: PASS (zero errors)
```

### CLI Verification
```bash
# Precondition check halts safely in QA_REVIEW
$ npm run bridge -- --check
  Preconditions FAILED: Task TASK-002 status is "QA_REVIEW". Task is awaiting ChatGPT QA review. Bridge stopped. (code: INVALID_TASK_STATE)

# Help documents explicit providers and approved models
$ npm run bridge -- --help
  Displays:
    - Provider: openrouter (cost_policy: free-tier)
    - Provider: antigravity (cost_policy: subscription_entitlement)
    - agy -p "<prompt>" --model <slug>
```

---

## Architecture Lock & Constitution
- `MAX_ALLOWED_COST = 0` and `ALLOW_PAID_API = false` strictly preserved.
- No paid API usage, no pay-per-use, no automatic paid fallback.
- No Antigravity credentials transferred into Claude Code.
- No Cloudflare provisioning, no production deployment, no architecture changes.
- Phase C automatic task chaining is blocked. The bridge halts at `QA_REVIEW`.

---

## QA Gate
TASK-002 REWORK 4 implementation and verification are complete. Ready for ChatGPT QA review.
Claude/Developer stops here and waits for independent verification.
