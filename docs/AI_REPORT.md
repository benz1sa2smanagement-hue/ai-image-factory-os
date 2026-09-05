# AI REPORT — Claude Code → ChatGPT

## Status
`QA_REVIEW`

## Task
- Task ID: TASK-002 (REWORK 5 — Final Zero-Cost / Current Antigravity Model Contract Fix)
- Title: Replacement of naive subscription entitlement with mandatory zero-overage preflight gate, current Gemini 3.x models, and runtime CLI model verification
- Source: `docs/AI_TASK.md` / GitHub Issue #6

---

## REWORK 5 Summary

This rework resolves the two P0 issues identified by ChatGPT QA regarding Antigravity zero-cost policy enforcement and model contracts.

### Key Changes Implemented

1. **Mandatory Zero-Overage Verification (`subscription_with_zero_overage`)**:
   - Replaced naive `subscription_entitlement = zero per-token cost` assumption with explicit `subscription_with_zero_overage`.
   - Google AI Pro allows AI Credit Overages after baseline quota exhaustion unless specifically disabled ("Never").
   - Added preflight safety gate `ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED`:
     - Checks `.antigravity-zero-overage-verified` sentinel file or programmatic `zeroOverageVerified` flag.
     - If unverified, the bridge refuses unattended Antigravity execution with exit code `ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED`.
     - Added operator command `npm run bridge -- --verify-zero-overage` which confirms account settings and creates the sentinel file.
   - Preserves strict `MAX_ALLOWED_COST = 0` and `ALLOW_PAID_API = false`.

2. **Current Antigravity Gemini 3.x Model Allowlist**:
   - Stale Gemini 2.x models (such as `gemini-2.0-flash`) have been removed from the Antigravity allowlist and are rejected with `MODEL_NOT_APPROVED`.
   - Updated `APPROVED_ANTIGRAVITY_MODELS` to current official Antigravity CLI Gemini 3.x slugs:
     - `gemini-3.8-flash` (default)
     - `gemini-3.8-pro`
     - `gemini-3.5-flash`
     - `gemini-3.5-pro`
     - `gemini-3-flash`
     - `gemini-3-pro`

3. **Runtime Model Verification (`agy models`)**:
   - Before launching Antigravity, the bridge queries `agy models` via `defaultGetAgyModels()`.
   - If the selected model is not in the installed CLI output, the bridge halts with `MODEL_NOT_IN_CLI`.
   - If the model is returned by CLI but not in project policy, the bridge halts with `CLI_MODEL_POLICY_MISMATCH`.

4. **Audit Logging & Verification State**:
   - Audit log entries now record `zeroOverageVerificationState` ('verified' | 'unverified' | 'not_applicable') in addition to `provider`, `launcher`, `model`, and `costPolicy`.

---

## Files Changed

### Modified Files
- `tools/ai-bridge/src/types.ts` — Added `subscription_with_zero_overage` to `CostPolicy`; added error codes `ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED`, `MODEL_NOT_IN_CLI`, `CLI_MODEL_POLICY_MISMATCH`; added `zeroOverageVerificationState` to `AuditLogEntry` and `zeroOverageVerified` option to `BridgeOptions`.
- `tools/ai-bridge/src/constants.ts` — Updated `APPROVED_ANTIGRAVITY_MODELS` to Gemini 3.x slugs; set `DEFAULT_ANTIGRAVITY_MODEL = 'gemini-3.8-flash'`; defined `DEFAULT_ZERO_OVERAGE_FILE = '.antigravity-zero-overage-verified'`; updated Antigravity launcher adapters to `subscription_with_zero_overage`.
- `tools/ai-bridge/src/safety.ts` — Added `checkZeroOverageVerification()` function; updated `validateProviderAndModel()` for Gemini 3.x and zero-overage cost policy.
- `tools/ai-bridge/src/bridge.ts` — Added zero-overage preflight gate; added `defaultGetAgyModels()` querying `agy models`; integrated runtime model validation; added `zeroOverageVerificationState` to audit logs.
- `tools/ai-bridge/src/cli.ts` — Added `--verify-zero-overage` CLI flag; updated help and status output to reflect Gemini 3.x and zero-overage requirements.
- `tools/ai-bridge/README.md` — Updated documentation with zero-overage verification workflow, Gemini 3.x model list, and CLI usage.
- `tools/ai-bridge/test/safety.test.ts` — Added unit tests for Gemini 3.x models, stale model rejection (`gemini-2.0-flash`), and `checkZeroOverageVerification`.
- `tools/ai-bridge/test/bridge.test.ts` — Added integration tests for zero-overage verification gate, `MODEL_NOT_IN_CLI`, unapproved model handling, and audit logging.

---

## Verification Evidence

### Automated Test Suite
```
npm test: 206 passed / 0 failed / 16 test files (all green)
```
- `tools/ai-bridge/test/safety.test.ts` (38 tests) — Provider/model contracts, Gemini 3.x slugs, stale model rejection, zero-overage verification checks, quota detection
- `tools/ai-bridge/test/bridge.test.ts` (35 tests) — Zero-overage preflight gate (`ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED`), `agy models` runtime verification (`MODEL_NOT_IN_CLI`), Antigravity explicit `--model`, mismatch rejection, audit logging, agy interface verification, prompt construction, remote authority, lock, kill-switch
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
# Verify zero-overage command creates sentinel file
$ npm run bridge -- --verify-zero-overage
  Verified Antigravity zero-overage policy. Created sentinel: .antigravity-zero-overage-verified

# Help documents explicit providers, Gemini 3.x models, and zero-overage cost policy
$ npm run bridge -- --help
  Displays:
    - Provider: antigravity (cost_policy: subscription_with_zero_overage)
    - Default model: gemini-3.8-flash
    - Models: gemini-3.8-flash, gemini-3.8-pro, gemini-3.5-flash, gemini-3.5-pro, gemini-3-flash, gemini-3-pro
    - Flag: --verify-zero-overage
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
TASK-002 REWORK 5 implementation and verification are complete. Ready for ChatGPT QA review.
Claude/Developer stops here and waits for independent verification.
