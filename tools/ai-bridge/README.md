# AI Bridge — Phase B Local Bridge for ChatGPT ↔ Claude Code

## Overview

The AI Bridge is a lightweight, isolated local process implementing **Phase B** of `docs/AI_AGENT_AUTONOMOUS_LOOP.md`. It provides a safe execution conduit between:

- **ChatGPT** — Technical Lead, Architecture Authority, and QA Gate
- **Claude Code** — Repository Executor running locally via `ori claude`
- **GitHub** — Persistent task definition (`docs/AI_TASK.md`), execution evidence (`docs/AI_REPORT.md`), and commit log

> **Scope Boundary:** Phase B is controlled single-task execution only. Phase C automatic task chaining is explicitly prohibited and out of scope.

---

## Architectural Guarantees & Safety Gates

1. **Repository & Branch Allowlist**
   - **Repository:** `benz1sa2smanagement-hue/ai-image-factory-os`
   - **Branch:** `main`
   - Any execution attempt on another repository or branch is blocked immediately (`REPO_NOT_ALLOWED` / `BRANCH_NOT_ALLOWED`).

2. **One Active Task Enforcement**
   - Consumes exclusively the single active task under `## Current Task` in `docs/AI_TASK.md`.
   - If zero tasks or multiple tasks are detected, execution halts (`TASK_NOT_FOUND` / `MULTIPLE_TASKS_DETECTED`).
   - Tasks cannot be invented.

3. **State Machine Conformance**
   - Implements handoff lifecycle: `READY → IMPLEMENTING → TESTING → QA_REVIEW → APPROVED`.
   - Failure states: `BLOCKED`, `REJECTED`, `FAILED`.
   - Only tasks with `STATUS: READY` can be consumed.

4. **Zero-Cost & Free-Only Policy**
   - Enforces `MAX_ALLOWED_COST = 0` and `ALLOW_PAID_API = false`.
   - Enforces OpenRouter free-tier models (must end with `:free` or be on the approved free list, e.g. `nvidia/nemotron-3.5-lightning:free`).
   - Any selection of paid models, paid fallback, account-switching, or credit-adding instructions halts execution immediately (`PAID_MODEL_BLOCKED`).
   - Output scanning detects billing errors, quota exhaustion, and rate limits; free quota exhaustion halts work with `FREE_QUOTA_EXHAUSTED` instead of falling back to paid models.

5. **Human-Only Action Gates**
   - Stops execution and marks task `BLOCKED` if task requires:
     - Cloudflare resource creation (`wrangler queues create`, `wrangler d1 create`, `wrangler r2 bucket create`)
     - Production deployment (`wrangler deploy`)
     - Credentials, tokens, or secret management
     - Domain or DNS changes
     - Modifications to locked architecture or zero-cost constitution
     - Marketplace automation

6. **Human Kill Switch**
   - Simple file-based kill switch (`.bridge-stop`).
   - Active kill switch aborts any cycle immediately (`KILL_SWITCH_ACTIVE`).
   - Controllable via CLI (`--stop [reason]`, `--resume`).

7. **Audit Logging & Secret Scrubbing**
   - Appends JSON Lines to `docs/AI_BRIDGE_AUDIT.log`.
   - Records task start/stop/complete, status, model, commit SHA, and stop reasons.
   - Automatically sanitizes and scrubs API keys (`sk-*`), Bearer tokens, GitHub tokens (`ghp_*`), and passwords.

8. **Safe Dry-Run & Check Modes**
   - `--check`: validates all safety preconditions without modifying files or launching processes.
   - `--dry-run`: simulates complete execution cycle without side effects.

---

## CLI Usage

### Check Preconditions & Status
```bash
# Check preconditions for current task
node --experimental-strip-types tools/ai-bridge/src/cli.ts --check

# Display repository, branch, task status, and kill-switch state
node --experimental-strip-types tools/ai-bridge/src/cli.ts --status
```

### Dry Run Simulation
```bash
node --experimental-strip-types tools/ai-bridge/src/cli.ts --dry-run
```

### Human Kill Switch Management
```bash
# Halt the bridge immediately
node --experimental-strip-types tools/ai-bridge/src/cli.ts --stop "Operator emergency pause"

# Clear the kill switch and resume operations
node --experimental-strip-types tools/ai-bridge/src/cli.ts --resume
```

### Run Approved Task
```bash
node --experimental-strip-types tools/ai-bridge/src/cli.ts --run
```

---

## Testing

Run the bridge test suite along with the complete repository tests:
```bash
npm test
npm run typecheck
npx tsc -p tools/ai-bridge --noEmit
```
