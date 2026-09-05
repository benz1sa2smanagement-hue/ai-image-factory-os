# AI Bridge — Phase B Local Bridge for ChatGPT ↔ Claude Code / Antigravity

**Version:** TASK-002-REWORK-5 (Final Zero-Cost / Current Antigravity Model Contract Fix)  
**Status:** Implemented, verified, and passing 206 automated tests

---

## Overview

The AI Bridge is a **local, human-supervised tool** that coordinates task execution between ChatGPT (Technical Lead / Architecture / QA) and local AI developer environments (Claude Code and Google Antigravity).

Key architecture and safety contracts:
1. **Explicit Provider & Model Contract**: Providers (`openrouter`, `antigravity`, `anthropic`) and models are strictly separated. Cross-provider model mismatch is blocked (e.g. OpenRouter `:free` models cannot be used with Antigravity).
2. **Current Antigravity Gemini 3.x Models**: Uses official Antigravity CLI Gemini 3.x model slugs (`gemini-3.8-flash` default, `gemini-3.8-pro`, `gemini-3.5-flash`, `gemini-3.5-pro`, `gemini-3-flash`, `gemini-3-pro`). Stale 2.x models are rejected.
3. **Runtime Model Verification (`agy models`)**: The bridge queries `agy models` at runtime to verify that the target model is supported by the installed CLI (`MODEL_NOT_IN_CLI` if missing, `CLI_MODEL_POLICY_MISMATCH` if unapproved).
4. **Mandatory Zero-Overage Verification**:
   - `openrouter`: `cost_policy: free-tier`
   - `antigravity`: `cost_policy: subscription_with_zero_overage`
   - Google AI Pro baseline quota allows AI credit overages unless explicitly configured to "Never".
   - The bridge enforces a preflight gate: if zero-overage is unverified, execution halts with `ANTIGRAVITY_ZERO_OVERAGE_UNVERIFIED`.
   - Zero-cost policy: `MAX_ALLOWED_COST = 0`, `ALLOW_PAID_API = false`.
5. **Official Antigravity Headless Interface**: Uses `agy -p "<prompt>" --model <slug>`. The model slug is verified and passed explicitly via `--model`.
6. **Mandatory Remote Authority Verification**: Fetches and verifies `origin/main` before execution (`REMOTE_SYNC_FAILED` on failure). Never runs stale local state.
7. **Local Work Protection (No-Overwrite Guarantee)**: Halts on `SYNC_CONFLICT` if local working tree is dirty.
8. **Real-time Child Process Kill-Switch**: Immediate termination of running child processes on `.bridge-stop` activation.
9. **Single-Instance Atomic Lock**: Prevents duplicate bridge executions (`.bridge-lock`).

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
# Pre-verify zero-overage policy (confirm AI Credit Overages = Never in Google account)
npm run bridge -- --verify-zero-overage

# Run single approved task with Antigravity (invokes: agy -p "<prompt>" --model <slug>)
npm run bridge -- --run --launcher antigravity --model gemini-3.8-flash

# Default Antigravity model (gemini-3.8-flash)
npm run bridge -- --run --launcher antigravity

# Explicit gemini-3.8-pro model
npm run bridge -- --run --launcher antigravity --model gemini-3.8-pro

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
| `anthropic` | `claude-direct` | `subscription_entitlement` | `provider_controlled` |

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
- `gemini-3.8-flash` (default)
- `gemini-3.8-pro`
- `gemini-3.5-flash`
- `gemini-3.5-pro`
- `gemini-3-flash`
- `gemini-3-pro`

### 3. Model/Provider Mismatch & Runtime Model Checks
- Passing an OpenRouter model to the Antigravity launcher is **REJECTED** with `MODEL_PROVIDER_MISMATCH`.
- Passing an Antigravity model to the OpenRouter launcher is **REJECTED** with `MODEL_PROVIDER_MISMATCH`.
- Stale Gemini 2.x models (e.g. `gemini-2.0-flash`) are **REJECTED** with `MODEL_NOT_APPROVED`.
- At runtime, `agy models` is checked: missing models yield `MODEL_NOT_IN_CLI`; unapproved CLI models yield `CLI_MODEL_POLICY_MISMATCH`.
- The audit log explicitly records `provider`, `launcher`, `model`, `costPolicy`, and `zeroOverageVerificationState`.

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
# Run all automated tests (201 tests across 16 test files)
npm test

# Run TypeScript typechecks
npm run typecheck
npx tsc -p tools/ai-bridge --noEmit
```
