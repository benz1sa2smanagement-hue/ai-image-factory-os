# AI REPORT — Claude Code → ChatGPT

## Status
`QA_REVIEW`

## Task
- Task ID: TASK-002 (REWORK)
- Title: Build Phase B Local Bridge for ChatGPT ↔ Claude Code — Safety/Automation Hardening
- Source: `docs/AI_TASK.md` / GitHub Issue #6

---

## REWORK Summary

The original TASK-002 implementation was QA-rejected by ChatGPT for 13 concrete deficiencies. This rework addresses all of them.

### What Changed

| Deficiency | Fix Applied |
|-----------|-------------|
| No persistent watcher/scheduler | Added `--watch` mode + `BridgeWatcher.watch()` loop with poll interval |
| Hardcoded `ori claude` launcher | Refactored behind explicit `LauncherAdapter` allowlist (`constants.ts`) |
| Kill switch non-immediate while child runs | `spawn()` child with handle; polls `.bridge-stop` every 1s; sends SIGTERM+SIGKILL |
| `:free` suffix alone was accepted | `validateModel()` now checks ONLY the explicit `APPROVED_FREE_MODELS` list |
| No concurrent instance lock | `lock.ts`: atomic O_EXCL lock; stale-lock detection; second instance exits code 2 |
| No SIGINT/SIGTERM graceful shutdown | `cli.ts` registers `process.on('SIGINT'/'SIGTERM')` → `bridge.stop()` |
| Watch mode not specified | Watch loop: READY→IMPLEMENTING→TESTING→QA_REVIEW, then stops |
| No auto-chain guard | `watch()` stops after `QA_REVIEW`; never reads next task or starts TASK-003 |
| Insufficient new tests | Added 18 bridge tests + 24 safety tests + 6 lock tests (170 total) |
| CLI commands incomplete | Added `--watch`, `--launcher`, `--interval` flags; explicit `--run` documented |
| README not documenting launch commands | README fully rewritten with all commands, allowlists, stop conditions |

---

## Files Changed

### New Files
- `tools/ai-bridge/src/lock.ts` — Single-instance bridge lock (atomic O_EXCL, stale PID detection, sync release for exit handlers)
- `tools/ai-bridge/test/lock.test.ts` — 6 lock tests

### Modified Files
- `tools/ai-bridge/src/types.ts` — Added `LauncherAdapter`, `WatchMode`, richer `SafetyErrorCode` variants, new `AuditEventType` values
- `tools/ai-bridge/src/constants.ts` — Removed `FREE_MODEL_SUFFIX`; added explicit `LAUNCHER_ADAPTERS` allowlist; added `DEFAULT_LOCK_FILE`, `DEFAULT_POLL_INTERVAL_MS`, `DEFAULT_FREE_MODEL`
- `tools/ai-bridge/src/safety.ts` — `validateModel()` uses strict allowlist only (no `:free` suffix acceptance); added `resolveLauncherAdapter()` that enforces the explicit allowlist
- `tools/ai-bridge/src/kill-switch.ts` — Added `isKillSwitchActiveSync()` for tight polling loops in child-process monitor; extracted `parseKillSwitchContent()` helper
- `tools/ai-bridge/src/bridge.ts` — Major rewrite:
  - `spawnWithKillSwitchMonitor()`: spawns child via `spawn()` (not `execFile`), polls `.bridge-stop` every 1s, sends SIGTERM→SIGKILL on activation
  - `watch()`: full watch loop with lock acquisition, SIGINT/SIGTERM via `stop()`, dry-run break, QA_REVIEW stop, BLOCKED stop, no auto-chaining
  - `sleep()`: interruptible by `_stopped` flag every 100ms
  - Launcher resolved via `resolveLauncherAdapter()` in `checkPreconditions()`
  - `BridgeConfig`: added `launcherName`, `watchMode`, `pollIntervalMs`, `lockFilePath`
- `tools/ai-bridge/src/cli.ts` — Added `--watch`, `--launcher`, `--interval` flags; SIGINT/SIGTERM → `bridge.stop()`; DUPLICATE_INSTANCE handled with exit code 2
- `tools/ai-bridge/src/index.ts` — Exports `lock` module
- `tools/ai-bridge/test/bridge.test.ts` — Rewritten: 18 tests covering watch mode, lock blocking, stale-lock cleanup, kill-switch abort, :free-suffix rejection, unsupported launcher rejection, graceful shutdown, no auto-chaining
- `tools/ai-bridge/test/safety.test.ts` — Rewritten: 24 tests including explicit allowlist, :free suffix rejection, all paid models, all launcher adapter cases
- `tools/ai-bridge/README.md` — Complete rewrite with all commands, safety architecture, allowlists, watch mode, kill switch, stop conditions table

---

## Verification Evidence

### Tests
```
npm test: 170 passed / 0 failed / 15 test files
```
- `tools/ai-bridge/test/bridge.test.ts`: **18 tests** — all pass
- `tools/ai-bridge/test/safety.test.ts`: **24 tests** — all pass
- `tools/ai-bridge/test/lock.test.ts`: **6 tests** — all pass
- `tools/ai-bridge/test/kill-switch.test.ts`: **4 tests** — all pass
- `tools/ai-bridge/test/task-parser.test.ts`: **6 tests** — all pass
- `tools/ai-bridge/test/audit-logger.test.ts`: **5 tests** — all pass
- Existing domain/worker tests: **107 tests** — all pass (unchanged)

### TypeChecks
```
npm run typecheck: PASS (tsc -p packages/domain --noEmit)
npx tsc -p tools/ai-bridge --noEmit: PASS (zero errors)
```

### CLI Verification (dry-run mode — no state changes)
```bash
# Check with task in QA_REVIEW state:
$ npm run bridge -- --status
  Task Status:  QA_REVIEW    ← correctly shows current state

$ npm run bridge -- --check
  Preconditions FAILED: ... "QA_REVIEW". Bridge only consumes STATUS: READY.  ← correct

$ npm run bridge -- --dry-run
  Execution HALTED/FAILED: Code: INVALID_TASK_STATE  ← correct

$ npm run bridge -- --help
  Displays full command list with explicit model/launcher allowlists  ← correct
```

### Key Safety Verifications

1. **`:free` suffix alone is rejected** — `validateModel('brand-new-org/model:free')` → `PAID_MODEL_BLOCKED` ✓
2. **Unknown launcher rejected** — `resolveLauncherAdapter('arbitrary')` → `LAUNCHER_NOT_ALLOWED` ✓
3. **Duplicate instance blocked** — `acquireLock()` returns `{ acquired: false }` when first holds ✓
4. **Stale lock cleaned** — PID 999999999 treated as dead, lock is reclaimed ✓
5. **Watch stops at QA_REVIEW** — no auto-chain to TASK-003 ✓
6. **Graceful shutdown** — `bridge.stop()` causes loop to exit within 100ms ✓
7. **Kill switch stops before launch** — `KILL_SWITCH_ACTIVE` code returned, task stays READY ✓
8. **Dry-run leaves task file unchanged** — READY status preserved after dry-run ✓

---

## Architecture Lock
All changes strictly isolated within `tools/ai-bridge/` and test configuration.
- No changes to Workers, D1, R2, Queues, or image generation production architecture.
- `MAX_ALLOWED_COST = 0` and `ALLOW_PAID_API = false` preserved.
- No Cloudflare provisioning, no live generation, no secrets in repo.
- Phase C automatic task chaining explicitly excluded.
- No Antigravity credentials transferred into `ori claude`.

## Paid AI/API
`NO PAID AI/API USED` — All operations run under zero-cost policy.

## Blockers
None. All 13 QA rejection items addressed.

## QA Gate
TASK-002 rework implementation and verification are complete. Ready for ChatGPT QA review.
Claude stops here and waits for independent verification.
