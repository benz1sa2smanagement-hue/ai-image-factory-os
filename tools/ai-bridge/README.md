# AI Bridge — Phase B Local Bridge for ChatGPT ↔ Claude Code / Antigravity

**Version:** TASK-002-REWORK-3 (Final Safety Correction)  
**Status:** Implemented, verified, and passing 189 automated tests

---

## Overview

The AI Bridge is a **local, human-supervised tool** that coordinates task execution between ChatGPT (Technical Lead / Architecture / QA) and local AI developer environments (Claude Code and Google Antigravity).

Key safety and automation capabilities:
1. **Mandatory Remote Authority Verification**: Detects and verifies authoritative task state from `origin/main` before execution. If `origin/main` cannot be fetched or verified, the bridge **HALTS immediately with `REMOTE_SYNC_FAILED`**. It never executes unattended tasks using stale local state.
2. **Local Work Protection (No-Overwrite Guarantee)**: If the local working tree has uncommitted changes and remote task state differs, the bridge **HALTS with `SYNC_CONFLICT`** without touching local files.
3. **Official Antigravity Headless Interface**: Uses the documented headless interface `agy -p "<prompt>"`. Rejects unsupported, guessed, or arbitrary commands (e.g. `agy run` is blocked).
4. **Strict Credential Separation**: Antigravity credentials are NEVER transferred into Claude Code or external tools; no undocumented bypasses.
5. **State Discrimination**: Explicitly distinguishes `LOCAL READY`, `REMOTE READY`, `IMPLEMENTING`, `TESTING`, `QA_REVIEW`, `BLOCKED`, and `APPROVED`.
6. **Real-time Child Process Kill-Switch**: Immediate termination of running child processes on `.bridge-stop` activation.
7. **Single-Instance Atomic Lock**: Prevents duplicate executions (`.bridge-lock`).
8. **Strict Free-Model Enforcement**: Only models in `APPROVED_FREE_MODELS` are permitted (`:free` suffix alone is rejected).

---

## Quick Start & Safe Commands

### 1. Claude Code Launcher (Default)
```bash
# Verify preconditions and task state (read-only)
npm run bridge -- --check

# Dry-run simulation (safe anytime, no side effects)
npm run bridge -- --dry-run

# Run single approved task with Claude Code
npm run bridge -- --run --launcher ori-claude

# Watch mode: poll origin/main + docs/AI_TASK.md every 30s
npm run bridge -- --watch --launcher ori-claude
```

### 2. Antigravity Headless Launcher Adapter
```bash
# Run single approved task with Antigravity (invokes: agy -p "<prompt>")
npm run bridge -- --run --launcher antigravity

# Alias launcher name (invokes: agy -p "<prompt>")
npm run bridge -- --run --launcher agy

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

## Antigravity Headless Interface (`agy -p`)

The bridge connects to Google Antigravity via its official headless interface:

```bash
agy -p "<prompt>"
```

### Safety & Interface Rules:
1. **Prompt Construction**:
   - The bridge reads the approved task from `docs/AI_TASK.md`.
   - It safely constructs a structured prompt containing the Task ID, Title, Objective, Required work items, and Hard constraints.
   - It passes this prompt to `agy -p`.
2. **Interface Verification**:
   - Before executing, the bridge verifies that the installed `agy` CLI supports the `-p` headless flag.
   - If the installed CLI differs from the documented interface, the bridge **STOPS and reports `LAUNCHER_NOT_ALLOWED`** instead of guessing.
3. **Rejection of Unsupported Semantics**:
   - Unsupported or guessed commands such as `agy run` are explicitly rejected.
4. **Billing and Quota Error Detection**:
   - The bridge captures stdout and stderr from `agy`.
   - If 402, 429, payment required, credit exhaustion, or billing strings are detected, the bridge **STOPS immediately and transitions task to `BLOCKED`**.
   - **Never enables paid fallback.**
5. **Strict Credential Isolation**:
   - `agy` runs with its own local session configuration.
   - No Antigravity tokens, credentials, or session data are shared with or transferred into Claude Code or other tools.

---

## Remote Authority & Offline Safety

To ensure unattended execution never runs on stale or unverified local state:

1. **Mandatory Remote Fetch**:
   - Before checking task readiness, the bridge fetches from `origin/main` (`git fetch origin main`).
   - If the remote cannot be fetched or verified (network down, repo unreachable, no remote configured), the bridge **HALTS immediately with code `REMOTE_SYNC_FAILED`**.
   - The bridge **does NOT silently continue offline**.
2. **Stale Local State Prevention**:
   - A local task marked `STATUS: READY` will NOT execute if remote authority cannot be verified.
3. **No-Overwrite Guarantee**:
   - If the local working tree has uncommitted changes (`git status --porcelain` is not empty) and the remote task definition differs, the bridge **HALTS with `SYNC_CONFLICT`**.
   - Local files are left completely untouched.
4. **Clean Fast-Forward**:
   - If the local working tree is clean and remote has new commits on `origin/main`, the bridge fast-forwards cleanly (`git merge --ff-only origin/main`).
   - The task is recognized as `REMOTE READY`.

---

## Supported Task States

| State | Source | Behavior |
|-------|--------|----------|
| `LOCAL READY` | `docs/AI_TASK.md` | Task is approved locally; bridge proceeds to execute. |
| `REMOTE READY` | `origin/main` synced | Authoritative task from GitHub; bridge proceeds to execute. |
| `READY` | Default alias | Equivalent to `LOCAL READY` / `REMOTE READY`. |
| `IMPLEMENTING` | In progress | Child developer process is active. |
| `TESTING` | In progress | Verification test suite (`npm test`, `typecheck`) is running. |
| `QA_REVIEW` | Completed cycle | Implementation complete. **Bridge STOPS unconditionally and waits for ChatGPT QA.** No auto-chaining. |
| `APPROVED` | ChatGPT sign-off | Task independently accepted. Bridge stops and waits for next task. |
| `BLOCKED` | Error / Guardrail | Execution halted due to safety violation, quota error, sync failure, or human action. |

---

## Allowlisted Launcher Adapters

| Adapter Name | Binary | Prefix Arguments | Execution Mode | Description |
|--------------|--------|------------------|----------------|-------------|
| `ori-claude` | `ori` | `['claude']` | Interactive/CLI | Existing local Claude Code wrapper |
| `claude-direct` | `claude` | `[]` | Interactive/CLI | Direct Claude CLI invocation |
| `antigravity` | `agy` | `['-p']` | Headless (`agy -p "<prompt>"`) | Official Antigravity CLI headless interface |
| `agy` | `agy` | `['-p']` | Headless (`agy -p "<prompt>"`) | Alias for `antigravity` |

Any other adapter name is rejected with `LAUNCHER_NOT_ALLOWED`.

---

## Approved Free Models

The bridge strictly enforces the explicit allowlist. Suffix `:free` alone is **NOT** sufficient:

- `nvidia/nemotron-3.5-lightning:free` (default)
- `meta-llama/llama-3.3-70b-instruct:free`
- `qwen/qwen-2.5-coder-32b-instruct:free`
- `mistralai/mistral-7b-instruct:free`
- `google/gemini-2.0-flash-exp:free`
- `google/gemini-2.0-flash-thinking-exp:free`
- `deepseek/deepseek-r1:free`
- `deepseek/deepseek-chat:free`

---

## Verification Suite

```bash
# Run all automated tests (189 tests across 16 test files)
npm test

# Run TypeScript typechecks
npm run typecheck
npx tsc -p tools/ai-bridge --noEmit
```
