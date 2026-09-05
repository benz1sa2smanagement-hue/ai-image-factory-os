# AI Bridge — Phase B Local Bridge for ChatGPT ↔ Claude Code

**Version:** TASK-002-REWORK  
**Status:** Implemented and tested

---

## Overview

The AI Bridge is a **local, human-supervised tool** that automates the handoff between ChatGPT (Technical Lead) and Claude Code (Developer). It:

1. Reads `docs/AI_TASK.md` to find a single task with `STATUS: READY`
2. Validates all safety gates before doing anything
3. Launches Claude Code via an explicit, allowlisted launcher adapter
4. Monitors the launched process and can kill it immediately on kill-switch activation
5. Runs verification tests and transitions the task to `QA_REVIEW`
6. **Stops unconditionally** — does NOT auto-approve, does NOT chain to TASK-003

---

## Quick Start

```bash
# Install dependencies (only needed once)
cd /path/to/ai-image-factory-os
npm install

# Check current status (read-only)
npm run bridge -- --status

# Verify preconditions without executing
npm run bridge -- --check

# Simulate a full cycle without side effects (DRY RUN — safe to run anytime)
npm run bridge -- --dry-run

# Execute one READY task (single cycle, live)
npm run bridge -- --run

# Watch mode: poll every 30s, auto-start on STATUS: READY
npm run bridge -- --watch

# Watch mode with custom interval and launcher
npm run bridge -- --watch --interval 60000 --launcher ori-claude

# Stop the bridge (human kill-switch)
npm run bridge -- --stop "Manual halt for review"

# Clear the kill-switch
npm run bridge -- --resume
```

---

## Commands

| Command | Description |
|---------|-------------|
| `--status` | Print current repository, task, kill-switch, lock state |
| `--check` | Check preconditions only (read-only) |
| `--dry-run` | Simulate bridge cycle without modifying state |
| `--run` | Execute one READY task (live) |
| `--watch` | Persistent watch mode, polls for READY task |
| `--stop [reason]` | Trigger kill-switch immediately |
| `--resume / --clear` | Clear kill-switch |
| `--help` | Show full help |

### Options
- `--model <name>` — Override model (must be in explicit allowlist)
- `--launcher <name>` — Override launcher adapter name
- `--interval <ms>` — Watch mode poll interval (default: 30000ms)

---

## Safety Architecture

### Hard Constraints (immutable)

```
MAX_ALLOWED_COST = 0
ALLOW_PAID_API = false
```

The bridge enforces all constraints at startup and refuses to execute if any violation is detected.

### Safety Gates (checked in order)

1. **Kill-switch file** — `.bridge-stop` must not exist
2. **Git repository** — must be `benz1sa2smanagement-hue/ai-image-factory-os` (exact match)
3. **Git branch** — must be `main`
4. **AI model** — must be in the **explicit allowlist** (`:free` suffix alone is NOT sufficient)
5. **Launcher adapter** — must be named in the explicit adapter allowlist
6. **Single task** — exactly one task must exist in `docs/AI_TASK.md`
7. **Task status** — must be `STATUS: READY`
8. **Human-only scan** — task text must not reference Cloudflare provisioning, DNS changes, etc.

### Explicit Free-Model Allowlist

Only models listed here are accepted. Arbitrary `:free` suffix is **NOT** sufficient — models must appear verbatim:

- `nvidia/nemotron-3.5-lightning:free`
- `meta-llama/llama-3.3-70b-instruct:free`
- `qwen/qwen-2.5-coder-32b-instruct:free`
- `mistralai/mistral-7b-instruct:free`
- `google/gemini-2.0-flash-exp:free`
- `google/gemini-2.0-flash-thinking-exp:free`
- `deepseek/deepseek-r1:free`
- `deepseek/deepseek-chat:free`

To add a model: edit `APPROVED_FREE_MODELS` in `src/constants.ts` and commit for human review.

### Explicit Launcher Adapter Allowlist

Only registered launcher adapters are accepted:

| Name | Binary | Prefix Args |
|------|--------|-------------|
| `ori-claude` | `ori` | `claude` |
| `claude-direct` | `claude` | _(none)_ |

To add a launcher: edit `LAUNCHER_ADAPTERS` in `src/constants.ts`.

**Important:** Antigravity/AGY credentials are NOT transferred to `ori claude`. These are independent local developer tools.

---

## Kill Switch

The kill switch is a JSON file (`.bridge-stop`) in the repository root.

**Activate:**
```bash
npm run bridge -- --stop "Reason for stopping"
# or manually:
echo '{"active":true,"reason":"manual"}' > .bridge-stop
```

**Clear:**
```bash
npm run bridge -- --resume
# or:
rm .bridge-stop
```

**During process execution:** The bridge spawns the developer launcher as a child process. It polls `.bridge-stop` every 1 second while the child runs. On activation:
- Sends `SIGTERM` to the child immediately
- Follows with `SIGKILL` after 2 seconds if the child doesn't exit
- Records `KILL_SWITCH_ACTIVE` in the audit log
- Transitions task to `BLOCKED`

---

## Single-Instance Lock

The bridge uses a lock file (`.bridge-lock`) to prevent concurrent execution:
- The lock file contains the PID of the running bridge instance
- A second bridge invocation detects the lock, logs `DUPLICATE_INSTANCE`, and exits with code 2
- Stale locks (from crashed instances with dead PIDs) are cleaned up automatically
- The lock is released on clean exit or SIGINT/SIGTERM

---

## Watch Mode

```bash
npm run bridge -- --watch [--interval <ms>] [--launcher <name>]
```

Watch mode behavior:
1. Acquires single-instance lock
2. Polls `docs/AI_TASK.md` every N milliseconds (default 30s)
3. When `STATUS: READY` is found, executes **exactly one task**
4. After task completes → `QA_REVIEW`: **watch stops and waits for external QA**
5. Does **not** auto-approve or chain to TASK-003 or any other task

**Stop watch mode:**
```bash
# Ctrl+C (SIGINT) — graceful shutdown
# Or:
npm run bridge -- --stop "Operator halt"
```

---

## Graceful Shutdown

The bridge handles `SIGINT` and `SIGTERM`:
- Sets an internal `_stopped` flag
- The watch loop exits after the current sleep completes (within 100ms)
- Audit log records `GRACEFUL_SHUTDOWN`
- Lock file is released

---

## Audit Log

All bridge actions are appended to `docs/AI_BRIDGE_AUDIT.log` in JSON Lines format.

Logged events:
- `WATCH_START`, `WATCH_TICK`, `WATCH_STOP`
- `TASK_START`, `TASK_COMPLETE`, `TASK_BLOCKED`, `TASK_STOP`
- `DRY_RUN`
- `KILL_SWITCH_ACTIVE`, `KILL_SWITCH_TRIGGERED`, `KILL_SWITCH_CLEARED`
- `CHILD_KILLED`
- `SAFETY_VIOLATION`
- `DUPLICATE_INSTANCE`
- `GRACEFUL_SHUTDOWN`

Secret masking: API keys, tokens, and credentials are redacted before logging.

---

## File Structure

```
tools/ai-bridge/
├── src/
│   ├── types.ts          # All TypeScript types
│   ├── constants.ts      # Allowlists, launcher adapters, defaults
│   ├── safety.ts         # Safety validators (repo, branch, model, launcher, quota, human-only)
│   ├── kill-switch.ts    # Kill-switch file management (async + sync)
│   ├── lock.ts           # Single-instance lock (atomic O_EXCL)
│   ├── bridge.ts         # Main bridge engine (AIBridge class)
│   ├── cli.ts            # CLI entry point
│   ├── task-parser.ts    # docs/AI_TASK.md parser
│   ├── audit-logger.ts   # JSON Lines audit logging with secret masking
│   ├── git-utils.ts      # Git context inspection
│   └── index.ts          # Module exports
├── test/
│   ├── bridge.test.ts        # Bridge engine tests (18 cases)
│   ├── safety.test.ts        # Safety validator tests (24 cases)
│   ├── lock.test.ts          # Lock module tests (6 cases)
│   ├── kill-switch.test.ts   # Kill-switch tests (4 cases)
│   ├── task-parser.test.ts   # Task parser tests (6 cases)
│   └── audit-logger.test.ts  # Audit log tests (5 cases)
├── tsconfig.json
└── README.md
```

---

## Stop Conditions

The bridge **always stops** on:

| Condition | Code | Action |
|-----------|------|--------|
| Kill switch active | `KILL_SWITCH_ACTIVE` | Abort, task → BLOCKED |
| Child killed by switch | `KILL_SWITCH_ACTIVE` | Kill child, task → BLOCKED |
| Free quota exhausted | `FREE_QUOTA_EXHAUSTED` | Stop, task → BLOCKED |
| Rate limit (HTTP 429) | `RATE_LIMIT_EXCEEDED` | Stop, task → BLOCKED |
| Paid model detected | `PAID_MODEL_BLOCKED` | Abort |
| Unapproved launcher | `LAUNCHER_NOT_ALLOWED` | Abort |
| Unauthorized repository | `REPO_NOT_ALLOWED` | Abort |
| Non-main branch | `BRANCH_NOT_ALLOWED` | Abort |
| Task not READY | `INVALID_TASK_STATE` | Abort |
| Human-only action in task | `HUMAN_ONLY_ACTION` | Abort, task → BLOCKED |
| Verification tests failed | `TESTS_FAILED` | Abort, task → BLOCKED |
| Duplicate instance | `DUPLICATE_INSTANCE` | Exit code 2 |
| QA_REVIEW reached | _(watch stops)_ | Wait for external QA |
| Graceful SIGINT/SIGTERM | `GRACEFUL_SHUTDOWN` | Exit cleanly |

---

## What the Bridge Will NEVER Do

- Add credits or enable billing
- Use a paid model or API
- Fallback to any paid model on quota exhaustion
- Create Cloudflare resources (Queues, D1, R2, Workers)
- Deploy to production
- Change DNS / domain configuration
- Modify architecture-lock decisions
- Start TASK-003 automatically
- Approve tasks without external ChatGPT QA
- Log secrets, tokens, or credentials
- Transfer Antigravity credentials into `ori claude`
