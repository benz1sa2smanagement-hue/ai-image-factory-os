# AI Bridge — Phase B Local Bridge for ChatGPT ↔ Claude Code / Antigravity

**Version:** TASK-002-REWORK-2  
**Status:** Implemented, verified, and passing 183 automated tests

---

## Overview

The AI Bridge is a **local, human-supervised tool** that coordinates task execution between ChatGPT (Technical Lead / Architecture / QA) and local AI developer environments (Claude Code and Google Antigravity).

Key capabilities:
1. **GitHub Synchronization Layer**: Detects authoritative task state from `origin/main` before execution while strictly guaranteeing local uncommitted work is **never silently overwritten**.
2. **Explicit Launcher Adapters**: Supports allowlisted adapters (`ori-claude`, `claude-direct`, `antigravity`, `antigravity-run`, `agy`), rejecting any arbitrary commands.
3. **Strict Credential Separation**: Antigravity credentials are NEVER transferred into Claude Code or external tools; no undocumented bypasses.
4. **State Discrimination**: Explicitly distinguishes `LOCAL READY`, `REMOTE READY`, `IMPLEMENTING`, `TESTING`, `QA_REVIEW`, `BLOCKED`, and `APPROVED`.
5. **Real-time Child Process Kill-Switch**: Immediate termination of running child processes on `.bridge-stop` activation.
6. **Single-Instance Atomic Lock**: Prevents duplicate executions.
7. **Strict Free-Model Enforcement**: Only models in `APPROVED_FREE_MODELS` are permitted (`:free` suffix alone is rejected).

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

### 2. Antigravity Launcher Adapter
```bash
# Run single approved task with Antigravity
npm run bridge -- --run --launcher antigravity

# Antigravity runner command (agy run)
npm run bridge -- --run --launcher antigravity-run

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

## Antigravity Environment Assumptions & Security Guarantees

When using `--launcher antigravity`, the following assumptions and security boundaries apply:

1. **Locally Installed CLI (`agy`)**:
   - The adapter invokes the local binary `agy` (Google Antigravity CLI).
   - If not installed or not in PATH, the bridge fails safely with process execution error without altering repository state.
2. **Strict Credential Isolation**:
   - Antigravity authenticates via its own internal session configuration.
   - **NO** Antigravity tokens, session credentials, or internal secrets are passed to Claude Code, `ori claude`, or written to repository files or logs.
   - **NO** undocumented credential bypasses are implemented or tolerated.
3. **Explicit Command Allowlist**:
   - The bridge refuses to execute arbitrary strings or shell scripts.
   - Only allowlisted adapter names (`antigravity`, `antigravity-run`, `agy`, `ori-claude`, `claude-direct`) are permitted.

---

## GitHub Remote Synchronization Layer

To ensure the local bridge respects the authoritative task state from GitHub without endangering local work:

### Synchronization Flow:
1. **Context Inspection**:
   - Checks `remoteUrl` (must match `benz1sa2smanagement-hue/ai-image-factory-os`) and branch (`main`).
   - Checks working tree cleanliness via `git status --porcelain`.
2. **Remote Fetch**:
   - Runs `git fetch origin main` (safe, non-destructive read).
3. **Task State Comparison**:
   - Inspects `origin/main:docs/AI_TASK.md` without checking out or altering files.
   - Compares with local `docs/AI_TASK.md`.
4. **Safety Gates**:
   - **If local working tree is dirty AND remote task differs**:
     - **HALT IMMEDIATELY** with code `SYNC_CONFLICT`.
     - Output: `Local working tree has uncommitted changes (...). Halting to prevent overwriting local work.`
     - **Local files are left completely untouched.**
   - **If local working tree is clean AND remote task is newer**:
     - Fast-forwards `origin/main` cleanly (`git merge --ff-only origin/main`).
     - Task is recognized as `REMOTE READY`.
   - **If offline or remote is unreachable**:
     - Falls back safely to local task state (`LOCAL READY`), logging `OFFLINE`.

---

## Supported Task States

The bridge explicitly distinguishes and handles the following states:

| State | Source | Behavior |
|-------|--------|----------|
| `LOCAL READY` | `docs/AI_TASK.md` | Task is approved locally; bridge proceeds to execute. |
| `REMOTE READY` | `origin/main` synced | Authoritative task from GitHub; bridge proceeds to execute. |
| `READY` | Default alias | Equivalent to `LOCAL READY` / `REMOTE READY`. |
| `IMPLEMENTING` | In progress | Child developer process is active. |
| `TESTING` | In progress | Verification test suite (`npm test`, `typecheck`) is running. |
| `QA_REVIEW` | Completed cycle | Implementation complete. **Bridge STOPS unconditionally and waits for ChatGPT QA.** No auto-chaining. |
| `APPROVED` | ChatGPT sign-off | Task independently accepted. Bridge stops and waits for next task. |
| `BLOCKED` | Error / Guardrail | Execution halted due to safety violation, quota error, or human action. |

---

## Allowlisted Launcher Adapters

| Adapter Name | Binary | Prefix Arguments | Description |
|--------------|--------|------------------|-------------|
| `ori-claude` | `ori` | `['claude']` | Existing local Claude Code wrapper |
| `claude-direct` | `claude` | `[]` | Direct Claude CLI invocation |
| `antigravity` | `agy` | `[]` | Google Antigravity CLI launcher |
| `antigravity-run` | `agy` | `['run']` | Google Antigravity runner command |
| `agy` | `agy` | `[]` | Alias for `antigravity` |

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
# Run all automated tests (183 tests across 16 test files)
npm test

# Run TypeScript typechecks
npm run typecheck
npx tsc -p tools/ai-bridge --noEmit
```

Test coverage includes:
- `tools/ai-bridge/test/git-utils.test.ts` — Remote task sync, conflict detection, dirty tree protection
- `tools/ai-bridge/test/bridge.test.ts` — State transitions, Antigravity allowlist, graceful shutdown, single-instance lock
- `tools/ai-bridge/test/safety.test.ts` — Repo/branch allowlists, model allowlist, launcher allowlist, quota detection
- `tools/ai-bridge/test/lock.test.ts` — Atomic O_EXCL file lock, stale PID cleanup
- `tools/ai-bridge/test/kill-switch.test.ts` — Human kill switch activation, detection, and clearing
- `tools/ai-bridge/test/audit-logger.test.ts` — Secret masking, append-only log formatting
- `tools/ai-bridge/test/task-parser.test.ts` — Single-task enforcement, multi-word status parsing
