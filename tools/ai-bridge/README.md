# AI Bridge — Phase B Local Bridge for ChatGPT ↔ Claude Code / Antigravity

**Version:** TASK-002 FINAL PATCH (Self-Authorization Bypass Removed)  
**Status:** Implemented, verified, and passing 229 automated tests across 16 test files

---

## Overview

The AI Bridge is a **local, human-supervised tool** that coordinates task execution between ChatGPT (Technical Lead / Architecture / QA) and local AI developer environments (Claude Code and Google Antigravity).

Key architecture and safety contracts:
1. **Human Zero-Overage Trust Boundary**:
   - Proof of human verification MUST reside at an operator-controlled location OUTSIDE the repository workspace (`~/.config/antigravity/zero-overage-verified.json`).
   - External verification record MUST confirm BOTH `status: "HUMAN_VERIFIED"` AND `policy: "AI Credit Overages = Never"`.
   - All internal execution-path overrides (`stateOverride`, `zeroOverageVerified` config flags) have been removed. The bridge cannot self-authorize.
   - Repository-local files or CLI flags CANNOT self-authorize execution (`SELF_AUTHORIZATION_BLOCKED`).
   - Autonomous coding agents operating inside the repository workspace cannot bypass human operator controls.
2. **AI Credit Fallback Disabled**:
   - Antigravity AI Credit Overages / `useG1Credits` setting must be verified as disabled.
   - If `useG1Credits` is enabled or overages are configured to charge credits, execution halts immediately with `ANTIGRAVITY_CREDIT_FALLBACK_ENABLED`.
3. **Current Antigravity Gemini 3.x Models with Quality Suffixes**:
   - Official Antigravity CLI model slugs require explicit quality/effort suffixes:
     `gemini-3.8-flash-medium` (default), `gemini-3.8-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-high`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-high`, `gemini-3.1-pro-high`.
   - Exact matching only: no suffix stripping, appending, or silent mutations at runtime.
4. **Runtime Model Verification (`agy models`)**:
   - The bridge queries `agy models` at runtime to verify that the target model is supported by the installed CLI (`MODEL_NOT_IN_CLI` if missing, `ANTIGRAVITY_MODEL_POLICY_MISMATCH` if unapproved).
5. **Mandatory Zero-Cost Constitution**:
   - `MAX_ALLOWED_COST = 0`, `ALLOW_PAID_API = false`.
   - `openrouter`: `cost_policy: free-tier` (:free models only).
   - `antigravity`: `cost_policy: subscription_with_zero_overage` (Google AI Pro baseline quota with confirmed zero-overage only).
6. **Official Antigravity Headless Interface**:
   - Uses `agy -p "<prompt>" --model <slug>`. The model slug is verified and passed explicitly via `--model`.
7. **Mandatory Remote Authority Verification**:
   - Fetches and verifies `origin/main` before execution (`REMOTE_SYNC_FAILED` on failure). Never runs stale local state.
8. **Local Work Protection (No-Overwrite Guarantee)**:
   - Halts on `LOCAL_CHANGES_PRESENT` or `SYNC_CONFLICT` if local working tree contains uncommitted changes.
9. **Real-time Child Process Kill-Switch**:
   - Immediate termination of running child processes on `.bridge-stop` activation.
10. **Single-Instance Atomic Lock**:
    - Prevents duplicate bridge executions (`.bridge-lock`).

---

## Quick Start & Safe Commands

### 1. Claude Code Launcher (OpenRouter Free-Tier)
```bash
# Verify preconditions and task state (read-only)
npm run bridge -- --check --launcher ori-claude

# Dry-run simulation (safe anytime, no side effects)
npm run bridge -- --dry-run --launcher ori-claude

# Run single approved task with Claude Code
npm run bridge -- --run --launcher ori-claude --model nvidia/nemotron-3.5-lightning:free

# Watch mode: poll origin/main + docs/AI_TASK.md every 30s
npm run bridge -- --watch --launcher ori-claude
```

### 2. Antigravity Headless Launcher (Subscription with Zero Overage)
```bash
# Verify operator zero-overage status outside workspace
npm run bridge -- --verify-zero-overage

# Run single approved task with Antigravity (invokes: agy -p "<prompt>" --model <slug>)
npm run bridge -- --run --launcher antigravity --model gemini-3.8-flash-medium

# Default Antigravity model (gemini-3.8-flash-medium)
npm run bridge -- --run --launcher antigravity

# Explicit gemini-3.8-flash-high model
npm run bridge -- --run --launcher antigravity --model gemini-3.8-flash-high

# Watch mode with Antigravity adapter
npm run bridge -- --watch --launcher antigravity --interval 30000

# Dry-run simulation with Antigravity adapter
npm run bridge -- --dry-run --launcher antigravity
```

### 3. Kill-Switch Management
```bash
# Stop immediately (creates .bridge-stop, terminates any running child process)
npm run bridge -- --stop "Operator halt"

# Clear kill-switch
npm run bridge -- --resume
```

---

## Provider and Model Contract

### 1. Approved Providers & Cost Policies

| Provider | Launcher Adapter | Cost Policy | Model Selection Mode |
|---|---|---|---|
| `openrouter` | `ori-claude` | `free-tier` | `explicit` (passed via `--model`) |
| `antigravity` | `antigravity`, `agy` | `subscription_with_zero_overage` | `explicit` (passed via `--model`) |

*Note: Unsafe or unverified launchers (including direct subscription launchers without verifiable zero overage) are excluded from the allowlist.*

### 2. Approved Model Slugs by Provider

#### Provider: `openrouter` (cost_policy: `free-tier`)
- `nvidia/nemotron-3.5-lightning:free` (default)
- `meta-llama/llama-3.3-70b-instruct:free`
- `qwen/qwen-2.5-coder-32b-instruct:free`
- `mistralai/mistral-7b-instruct:free`
- `google/gemini-2.0-flash-exp:free`
- `google/gemini-2.0-flash-thinking-exp:free`
- `deepseek/deepseek-r1:free`
- `deepseek/deepseek-chat:free`

#### Provider: `antigravity` (cost_policy: `subscription_with_zero_overage`)
- `gemini-3.8-flash-medium` (default)
- `gemini-3.8-flash-high`
- `gemini-3.7-flash-medium`
- `gemini-3.7-flash-high`
- `gemini-3.6-flash-medium`
- `gemini-3.6-flash-high`
- `gemini-3.1-pro-high`

### 3. Model/Provider Mismatch & Runtime Model Checks
- Passing an OpenRouter model to the Antigravity launcher is **REJECTED** with `MODEL_PROVIDER_MISMATCH`.
- Passing an Antigravity model to the OpenRouter launcher is **REJECTED** with `MODEL_PROVIDER_MISMATCH`.
- Models without quality suffixes (e.g. `gemini-3.8-flash`) are **REJECTED** with `PAID_MODEL_BLOCKED`.
- Stale Gemini 2.x models (e.g. `gemini-2.0-flash`) are **REJECTED** with `PAID_MODEL_BLOCKED`.
- At runtime, `agy models` is checked: missing models yield `MODEL_NOT_IN_CLI`; unapproved CLI models yield `ANTIGRAVITY_MODEL_POLICY_MISMATCH`.
- The audit log explicitly records `provider`, `launcher`, `model`, `costPolicy`, `zeroOverageVerificationState`, `creditFallbackState`, and `modelRuntimeVerification`.

---

## Antigravity Headless Interface (`agy -p --model`)

The bridge connects to Google Antigravity via its official interface:

```bash
agy -p "<prompt>" --model <slug>
```

### Safety & Interface Rules:
1. **Prompt Construction**:
   - The bridge reads the approved task from `docs/AI_TASK.md`.
   - It safely constructs a structured prompt containing the Task ID, Title, Objective, Required work items, and Hard constraints.
   - It passes this prompt to `agy -p` along with `--model <slug>`.
2. **Interface Verification**:
   - Before executing, the bridge verifies that the installed `agy` CLI supports both `-p` and `--model`.
   - If the installed CLI differs from the documented interface, the bridge **STOPS and reports `LAUNCHER_NOT_ALLOWED`**.
3. **Billing and Quota Error Detection**:
   - The bridge captures stdout and stderr from `agy`.
   - If 402, 429, payment required, credit exhaustion, or billing strings are detected, the bridge **STOPS immediately and transitions task to `BLOCKED`**.
   - **Never enables paid fallback.**
4. **Strict Credential Isolation**:
   - `agy` runs with its own local session configuration.
   - No Antigravity tokens, credentials, or session data are shared with or transferred into Claude Code or other tools.

---

## Remote Authority & Offline Safety

1. **Mandatory Remote Fetch**:
   - Before checking task readiness, the bridge fetches from `origin/main` (`git fetch origin main`).
   - If the remote cannot be fetched or verified, the bridge **HALTS with `REMOTE_SYNC_FAILED`**.
   - The bridge **does NOT silently continue offline**.
2. **Stale Local State Prevention**:
   - A local task marked `STATUS: READY` will NOT execute if remote authority cannot be verified.
3. **No-Overwrite Guarantee**:
   - If the local working tree has uncommitted changes and the remote task definition differs, the bridge **HALTS with `SYNC_CONFLICT`**.
   - Local files are left completely untouched.

---

## Supported Task States

| State | Source | Behavior |
|---|---|---|
| `LOCAL READY` | `docs/AI_TASK.md` | Task is approved locally; bridge proceeds to execute. |
| `REMOTE READY` | `origin/main` synced | Authoritative task from GitHub; bridge proceeds to execute. |
| `READY` | Default alias | Equivalent to `LOCAL READY` / `REMOTE READY`. |
| `IMPLEMENTING` | In progress | Child developer process is active. |
| `TESTING` | In progress | Verification test suite (`npm test`, `typecheck`) is running. |
| `QA_REVIEW` | Completed cycle | Implementation complete. **Bridge STOPS unconditionally and waits for ChatGPT QA.** |
| `APPROVED` | ChatGPT sign-off | Task independently accepted. Bridge stops and waits for next task. |
| `BLOCKED` | Error / Guardrail | Execution halted due to safety violation, quota error, sync failure, or human action. |

---

## Verification Suite

```bash
# Run all automated tests (229 tests across 16 test files)
npm test

# Run TypeScript typechecks
npm run typecheck
npx tsc -p tools/ai-bridge --noEmit
```
