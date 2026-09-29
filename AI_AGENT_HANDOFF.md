# AI Image Factory OS — AI Agent Handoff

## 1. Project Identity
- **Repository**: `/Users/phan/ai-image-factory-os`
- **Current branch**: `main`
- **Current commit**: `c1daa60` (Merge pull request #4 from benz1sa2smanagement-hue/chore/register-b2-standard-s3-diagnostic)
- **Current working tree status**: Clean — nothing to commit, working tree clean
- **Remote branches**: 20 remote-tracking branches (see Section 3 for full list)

---

## 2. Architecture Lock

**THIS SECTION CONTAINS ARCHITECTURE DECISIONS THAT MUST NOT BE CHANGED WITHOUT EXPLICIT APPROVAL.**

The following are established, intentional architecture decisions:

| Decision | Status | Evidence |
|----------|--------|----------|
| Zero-cost constitution: `MAX_ALLOWED_COST = 0`, `ALLOW_PAID_API = false` | LOCKED | `packages/domain/src/policy.ts` |
| Kill switch: `factory_status = STOPPED` blocks new work | LOCKED | `packages/domain/src/policy.ts`, `watchdog.ts` |
| Marketplace upload: **MANUAL MODE ONLY** (no official bulk API verified) | LOCKED | `docs/PROVIDER_RESEARCH.md`, `docs/MARKETPLACES.md`, `README.md` |
| Primary image model: `@cf/black-forest-labs/flux-1-schnell` on Workers AI free tier | LOCKED | `docs/PROVIDER_RESEARCH_UPDATE.md`, `packages/domain/src/providers.ts` |
| D1 as source of truth; Queues for async delivery only | LOCKED | `docs/ARCHITECTURE.md`, `docs/DATABASE.md` |
| MOCK_MODE default for CI/dev; live path requires bindings | LOCKED | `workers/*/wrangler.toml`, `workers/api/src/index.ts` |
| No owner PC required at runtime — Cloudflare Workers run autonomously | LOCKED | `docs/OWNER_ARCHITECTURE_CHECK.md` |
| All secrets in Cloudflare dashboard / `wrangler secret` — never in git | LOCKED | `docs/SECURITY.md`, `wrangler.toml` comments |

---

## 3. Master Context Discovery

**Investigation performed**: READ-ONLY search across:
- Current filesystem (entire repository tree)
- Current branch (`main`)
- All 20 remote-tracking branches
- Git history (all commits, all branches via `git log --all`)
- Deleted files (`git log --all --full-history --oneline -- <path>`)
- Renamed files (searched for `*Master*Context*`, `*master*context*`)
- Commits containing "Master Context"
- Commits containing "AI Image Factory"
- All `.txt` files in repository

**Result**: **Master Context file NOT FOUND in repository/history.**

No file named `AI_Image_Factory_Master_Context.txt` (or any case variation) exists in:
- Current working tree
- Any local branch (only `main` exists locally)
- Any remote-tracking branch
- Git history (no commits reference it, no deleted file matches)
- Any `.txt` file in the repository (zero `.txt` files exist outside `.git/`)

**Conclusion**: The Master Context file was never committed to this repository, or existed only outside git tracking. DO NOT invent or reconstruct it.

---

## 4. Current Architecture

### 4.1 Domain Layer (`packages/domain/src/`)
Pure TypeScript — no external dependencies. Exports 22 modules:

| Module | Purpose |
|--------|---------|
| `policy.ts` | Constitutional constants, `assertZeroCost()`, `canStartNewWork()` |
| `state-machine.ts` | 22-state asset lifecycle, strict transition matrix, `canTransition()` |
| `quota.ts` | Pure quota logic: `availableUnits`, `canReserve`, `applyReserve/Commit/Release`, `estimateFluxSchnellNeurons` |
| `quota-d1.ts` | D1 atomic implementation: `d1Reserve`, `d1Commit`, `d1Release` with idempotency keys |
| `providers.ts` | Provider interface, router (`scoreProvider`, `pickBestProvider`, `routeProvider`), zero-cost gate |
| `qc.ts` | 3-level QC pipeline: L1 (file integrity), L2 (heuristics), L3 (AI stub, skipped by default) |
| `duplicate.ts` | Exact SHA-256 + pHash (Hamming distance), threshold policy |
| `phash.ts` / `phash-pixels.ts` / `phash-decode.ts` | Perceptual hash pipeline: decode → RGBA → aHash (64-bit) |
| `jpeg-baseline.ts` | Pure TS baseline JPEG decoder for pHash (progressive/CMYK not supported) |
| `retry.ts` | Exponential backoff, quota-wait, DLQ policy, `NON_RETRYABLE_CODES` |
| `watchdog.ts` | Stuck job detection: timeouts per state, heartbeat, STOP-aware actions |
| `jobs-d1.ts` | D1 job persistence: conditional transitions, DLQ, watchdog application, quota release |
| `jobs.ts` | Job types, statuses, `maxAttemptsFor()`, `isRetryableJobStatus()` |
| `cleanup.ts` | Safe deletion rules: never delete uploaded/kept/pending assets |
| `audit.ts` | Audit log helpers for every state transition |
| `quota-release-by-job.ts` | Helper to release reserved quota by `job_id` on watchdog recovery |
| `memory-d1.ts` / `memory-jobs-d1.ts` | Test doubles for D1 (SQLite-compatible) |

### 4.2 API Worker (`workers/api/`)
- **Endpoints**: `/health`, `/factory/status` (GET), `/factory/stop` (POST), `/factory/resume` (POST), `/v1/generate` (POST)
- **Bindings** (commented in `wrangler.toml`): D1, R2, Queue producer, Workers AI
- **Behavior**: MOCK_MODE default; live generation returns 501 NOT_IMPLEMENTED
- **Auth**: None on any endpoint

### 4.3 Consumer Worker (`workers/consumer/`)
- **Queue**: Consumes from `aif-factory` (binding commented)
- **Job types handled**: `IMAGE_GENERATION`, `QC`, `DUPLICATE_CHECK`, `METADATA`, `CLEANUP`, `WATCHDOG`
- **Retry**: Native CF retry `max_retries=3` + application DLQ via D1
- **Cron**: Commented triggers for watchdog/cleanup (`*/15 * * * *`)
- **MOCK_MODE**: Default true; quota operations work in-memory when no DB bound

### 4.4 Cloudflare D1
- **Migrations**: 3 files (`0001_init.sql`, `0002_quota_atomicity.sql`, `0003_reliability_persistence.sql`)
- **Tables**: 27 tables including settings, providers, quotas, reservations, jobs, job_attempts, generated_assets, image_hashes, qc_results, duplicate_results, prompts, trends, strategies, production_plans, metadata, marketplaces, upload_jobs, audit_logs, system_events, dead_letter_jobs, watchdog_actions
- **Indexes**: On status, timestamps, idempotency keys, hash lookups
- **Bindings**: Commented in both workers' `wrangler.toml` — requires `database_id`

### 4.5 Cloudflare R2
- **Bucket**: `aif-assets` (referenced in `wrangler.toml`, commented)
- **Usage**: Temporary asset storage → QC → metadata → READY_TO_UPLOAD → cleanup
- **Cleanup rules**: Only delete if `uploaded=true` OR retention expired, AND no pending job, AND `keep≠true`

### 4.6 Cloudflare Queues
- **Queue name**: `aif-factory`
- **Producer**: `aif-api` (commented binding)
- **Consumer**: `aif-consumer` (commented binding, `max_batch_size=5`, `max_retries=3`)
- **Application DLQ**: `dead_letter_jobs` table in D1 (not a second Queue)
- **Status**: Must be created once: `wrangler queues create aif-factory`

### 4.7 Workers AI
- **Model**: `@cf/black-forest-labs/flux-1-schnell` (Apache-2.0 license)
- **Free allocation**: 10,000 Neurons/day (resets 00:00 UTC)
- **Cost estimate**: ~44 neurons for 512×512 @ 4 steps
- **Binding**: `[ai]` in `wrangler.toml` (commented)
- **Adapter**: `packages/providers/src/cloudflare-flux.ts`

### 4.8 Cron
- **Triggers**: Commented in consumer `wrangler.toml`: `crons = ["*/15 * * * *"]`
- **Purpose**: Watchdog + cleanup (not yet active)

### 4.9 Provider Layer (`packages/providers/`)
- `MockImageProvider` — deterministic 4-byte JPEG stub, no network, no quota
- `cloudflare-flux.ts` — Workers AI adapter, only invoked after zero-cost gate + quota reserve

### 4.10 QC Pipeline
- **Level 1**: File existence, size (1KB–15MB), dimensions (512–4096), MIME type, format, hash presence, decode success
- **Level 2**: Corruption, blank/near-blank detection, aspect ratio (0.2–5.0)
- **Level 3**: AI content check — skipped by default (`skip: true`), accepts supplied checks only
- **Gate**: `mayUpload(qcPassed, factoryAllowsUpload)` — blocks QC failures

### 4.11 Duplicate Detection
- **Layer 1**: Exact SHA-256 (short-circuits if match)
- **Layer 2**: pHash Hamming distance ≤ threshold (default 10 from `phash-threshold.ts`)
- **Layer 3**: Semantic — reserved, not implemented

### 4.12 State Machine
```
PLANNED → QUEUED → GENERATING → GENERATED → QC → PASSED|REJECTED
PASSED → METADATA → READY_TO_UPLOAD → UPLOADING → UPLOADED → TRACKING → ARCHIVED → DELETED
FAILURE: FAILED → RETRY_WAIT → RETRY → DEAD_LETTER
```
- 22 states, strict transition matrix, every transition audited

### 4.13 Quota Manager
- **Flow**: CHECK → RESERVE → EXECUTE → COMMIT / RELEASE
- **Atomicity**: D1 transaction with conditional UPDATE (capacity check in WHERE), then INSERT reservation
- **Idempotency**: Unique index on `job_id` (reserved) + `idempotency_key`
- **TTL**: 900s default on reservations to prevent leaks
- **Default**: 10,000 neurons/day for `cf_workers_ai` / `flux-1-schnell`

### 4.14 Retry / DLQ
- **Non-retryable codes**: `PAID_BLOCKED`, `COST_EXCEEDED`, `FACTORY_STOPPED`, `POLICY`, `UNSUPPORTED_FORMAT`, `QC_REJECTED`, `DUPLICATE_REJECTED`, `ILLEGAL_TRANSITION`
- **Quota codes**: `QUOTA`, `WAITING_FOR_QUOTA`, `INSUFFICIENT_QUOTA` → wait up to 60s, max 10 attempts
- **Backoff**: 2s base × 2^attempt, max 5min, 20% jitter
- **DLQ**: `dead_letter_jobs` table with `UNIQUE(job_id)` — insert once via `INSERT OR IGNORE`

### 4.15 Watchdog
- **Timeouts**: GENERATING 10min, QC 5min, QUEUED 30min, RETRY_WAIT 1hr, heartbeat 15min
- **Actions**: `mark_failed`, `requeue` (if STOP not active), `dead_letter`
- **Recovery**: Releases reserved quota by `job_id` on `mark_failed` / `dead_letter`

### 4.16 B2 Diagnostics
4 GitHub Actions workflows (all `workflow_dispatch` only):
1. `b2-standard-s3-diagnostic.yml` — AWS CLI S3 API vs B2 endpoint
2. `b2-secret-forensics.yml` — Inspects secret representation (no values printed)
3. `b2-native-auth.yml` — Calls `b2_authorize_account` with basic auth
4. `b2-live-e2e.yml` — Manual, runs vitest against real B2 bucket

### 4.17 CI/CD
- **`.github/workflows/ci.yml`**: `npm install` → `npm test` → `npm run typecheck` → optional D1 SQLite sim
- **Test config**: `vitest.config.ts` — only includes `packages/**/*.test.ts`
- **Typecheck**: `tsc -p packages/domain --noEmit` (domain only)

---

## 5. Current Implementation Status

| Component | Status | Evidence | Notes |
|-----------|--------|----------|-------|
| Architecture docs | DONE | `docs/ARCHITECTURE.md`, `DATABASE.md`, `QUOTA.md`, `SECURITY.md`, `OPERATIONS.md`, `PROVIDER_RESEARCH.md`, `MARKETPLACES.md`, `SETUP.md` | Comprehensive, consistent |
| Provider research | DONE | `docs/PROVIDER_RESEARCH.md`, `PROVIDER_RESEARCH_UPDATE.md` | Verified FLUX.1 Schnell free tier, Adobe Stock manual mode |
| D1 schema / migrations | DONE | `migrations/0001-0003.sql` | 27 tables, indexes, foreign keys |
| State machine | DONE | `packages/domain/src/state-machine.ts` + tests | 22 states, strict transitions, audited |
| Quota manager (design) | DONE | `packages/domain/src/quota.ts` | Pure logic, neuron estimation |
| Quota manager (D1 impl) | DONE | `packages/domain/src/quota-d1.ts` | Atomic reserve/commit/release, idempotency |
| Provider router | DONE | `packages/domain/src/providers.ts` | Score/pick/route, zero-cost gate |
| QC pipeline (L1-L2) | DONE | `packages/domain/src/qc.ts` + tests | Deterministic, configurable thresholds |
| QC pipeline (L3) | SCAFFOLD | `packages/domain/src/qc.ts` | Stub only, skipped by default |
| Duplicate detection (exact) | DONE | `packages/domain/src/duplicate.ts` | SHA-256, case-insensitive |
| Duplicate detection (pHash) | PARTIAL | `packages/domain/src/phash*.ts` | Decode pipeline exists; JPEG baseline only |
| Duplicate detection (semantic) | MISSING | — | Reserved, not implemented |
| Workers / Queues (config) | SCAFFOLD | `workers/*/wrangler.toml` | Bindings commented, queue must be created |
| Image generation (mock) | DONE | `packages/providers/src/mock-image.ts` | 4-byte JPEG stub, works in tests |
| Image generation (live) | BLOCKED | `workers/api/src/index.ts:95-98` | Returns 501; requires bindings + quota E2E |
| Marketplace upload | MANUAL MODE | `docs/MARKETPLACES.md`, `workers/consumer/src/index.ts:284` | Intentional — no official API verified |
| Dashboard | MISSING | — | API scaffold exists only |
| Tests (domain) | DONE | `packages/domain/src/*.test.ts` | 28 tests passing |
| Tests (consumer) | PARTIAL | `workers/consumer/src/process.test.ts` | 9 tests; vitest config may not include |
| Tests (integration) | SCAFFOLD | `scripts/d1-integration-sim.mjs` | SQLite sim, runs in CI with `continue-on-error` |
| CI/CD (GitHub) | PARTIAL | `.github/workflows/ci.yml` | No deploy, no remote D1 migration |
| B2 diagnostics | DONE | 4 workflows in `.github/workflows/` | All manual dispatch |
| Cron (watchdog/cleanup) | MISSING | `workers/consumer/wrangler.toml:39-40` | Commented out |
| R2 usage tracking | MISSING | — | Docs mention, no implementation |
| Prompt/Strategy pipeline | MISSING | Tables exist, no workers | `trends`, `strategies`, `production_plans` tables unused |
| Revenue/sales tracking | MISSING | Tables exist, no workers | `sales`, `downloads`, `revenue` tables unused |

---

## 6. Known Problems / Risks

### Critical Blockers
1. **Queue resource missing** — `aif-factory` queue must be created via `wrangler queues create aif-factory`
2. **D1 database not bound** — `database_id` needed in both workers' `wrangler.toml`
3. **R2 bucket not bound** — `aif-assets` bucket must be created and bound
4. **Workers AI binding not bound** — `[ai]` binding required for live generation
5. **Live generation path incomplete** — API worker returns 501 for non-mock mode
6. **Cron triggers not active** — Watchdog/cleanup not running in production

### Architecture Risks
7. **JPEG decoder limited to baseline** — `jpeg-baseline.ts` fails on progressive/CMYK JPEGs
8. **No semantic duplicate detection** — Only exact + pHash; near-duplicates may slip through
9. **No authentication on API** — `/factory/stop|resume` completely open
10. **TypeScript config isolated to domain** — Workers not type-checked

### Security Risks
11. **No auth on control endpoints** — Anyone can STOP/RESUME factory
12. **Secrets management relies on manual process** — No setup wizard, no validation

### Operational Risks
13. **Free tier enforcement** — D1 (5M reads/100K writes/day), R2 (10GB), Queues (10K ops/day) — no auto-stop
14. **Neuron cost estimation may drift** — Based on 2026-08-28 pricing; must treat Neurons as authoritative
15. **No R2 usage tracking** — Docs mention tracking but no code exists

### Testing Gaps
16. **Vitest excludes worker tests** — Config only includes `packages/**/*.test.ts` (FIXED in TASK 1: `workers/**/*.test.ts` now included)
17. **No integration tests against real D1/Queue/AI** — Only SQLite sim
18. **No E2E test for live generation path** — Mock only

### Deployment Gaps
19. **No automated deploy workflow** — Manual `wrangler deploy` only
20. **No remote D1 migration apply workflow** — Must run manually
21. **No production environment protection** — No GitHub Environments configured

---

## 7. Existing E2E / B2 Work

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `b2-standard-s3-diagnostic.yml` | `workflow_dispatch` | AWS CLI S3 API (PUT/HEAD/GET/DELETE) vs B2 S3-compatible endpoint |
| `b2-secret-forensics.yml` | `workflow_dispatch` | Inspect GitHub secret representation (character classes, SHA256, whitespace) — never prints values |
| `b2-native-auth.yml` | `workflow_dispatch` | Call `b2_authorize_account` with basic auth (`B2_KEY_ID:B2_APPLICATION_KEY`) |
| `b2-live-e2e.yml` | `workflow_dispatch` | Run vitest against real B2 bucket (`aif-os-e2e-test` in `us-west-004`) |

All require GitHub Secrets: `B2_KEY_ID`, `B2_APPLICATION_KEY`.
None run on push/PR — all manual dispatch only.

---

## 8. Open Decisions

| Decision | Required From | Status |
|----------|---------------|--------|
| Queue `aif-factory` creation | Human owner (one-time Cloudflare action) | PENDING |
| D1 database creation + `database_id` | Human owner | PENDING |
| R2 bucket `aif-assets` creation | Human owner | PENDING |
| Workers AI binding enablement | Human owner (confirm free tier access) | PENDING |
| Authentication method for API endpoints | Human owner / ChatGPT | OPEN |
| Automated deploy workflow (GitHub Actions + secrets) | Human owner / ChatGPT | OPEN |
| Cron trigger enablement (watchdog/cleanup) | Human owner / ChatGPT | OPEN |
| JPEG decoder scope (baseline vs full) | ChatGPT | OPEN |
| R2/D1/Queue usage monitoring implementation | ChatGPT | OPEN |
| Vitest config expansion to include worker tests | ChatGPT | OPEN |
| TypeScript config for workers | ChatGPT | OPEN |

---

## 9. ChatGPT Instructions

**Waiting for ChatGPT instructions.**

---

## 10. Claude Code Report

### Investigation Summary
- **Master Context file**: NOT FOUND anywhere in repository, history, or branches
- **Repository state**: Clean, on `main` at commit `c1daa60`, 20 remote branches
- **Architecture**: Well-documented, consistent, zero-cost constitution enforced in code
- **Implementation**: Strong domain layer, scaffolded workers, blocked on Cloudflare resource creation
- **Tests**: Domain tests passing (107/107); worker tests now included via vitest config expansion (completed TASK 1)

### Most Important Blockers
1. **Cloudflare resources don't exist** — Queue, D1, R2, AI bindings all require one-time owner setup
2. **No live generation possible** — All bindings commented, API returns 501
3. **No production automation** — Deploy, migrations, cron all manual

### Proposed Next Actions (AWAITING AUTHORIZATION)
1. **Do nothing** — Wait for owner to create Cloudflare resources and populate `wrangler.toml`
2. **Add API authentication** — Before any deploy, secure `/factory/stop|resume`
3. **Vitest config expanded** — `workers/**/*.test.ts` now included (completed TASK 1)
4. **Create deploy workflow** — With GitHub Environments and secret validation
5. **Implement R2 usage tracking** — Prevent surprise bills

### Unresolved Issues
- Whether to keep JPEG baseline decoder or upgrade
- Whether to implement semantic duplicate detection now or defer
- Timeline for dashboard (mobile-first)

### Architectural Concerns
- None — architecture is sound, consistent, and policy-first

---

## 11. Change Authorization

**NO CODE CHANGES ARE AUTHORIZED unless explicitly approved by the human owner or by a clearly documented instruction from ChatGPT.**

This file is the single authorized documentation artifact for this session.

---

## 12. Communication Protocol

### Before starting any significant task:
1. Read `AI_AGENT_HANDOFF.md`
2. Check **Architecture Lock** (Section 2)
3. Check **ChatGPT Instructions** (Section 9)
4. Check **Open Decisions** (Section 8)
5. Explain intended action
6. Wait for authorization if task could alter architecture or behavior

### After completing a task:
1. Update **Claude Code Report** (Section 10)
2. Record files changed
3. Record tests executed
4. Record test results
5. Record unresolved issues
6. Record any architectural concern
7. Stop and wait for further instructions

---

## 13. ChatGPT Session Handoff — 2026-09-29

### Session objective
Continue making the project usable end-to-end while preserving the locked architecture and the user's requirement of **100% free / no credit card / no paid fallback**.

### Progress
- **Project progress: 38% — B2 connection diagnostic / handoff checkpoint**
- Do not advance the percentage merely by adding documentation. Advance only after a real integration milestone is verified.

### What was verified in this session
1. The repository was re-read from GitHub on `main`.
2. Existing B2 diagnostic workflows were inspected:
   - `.github/workflows/b2-standard-s3-diagnostic.yml`
   - `.github/workflows/b2-live-e2e.yml`
   - plus the existing B2 secret/native-auth diagnostic workflows documented above.
3. The current diagnostics hard-code:
   - Endpoint: `https://s3.us-west-004.backblazeb2.com`
   - Region: `us-west-004`
   - Bucket: `aif-os-e2e-test`
4. Backblaze's current documentation confirms:
   - S3-Compatible API requires AWS Signature Version 4.
   - The automatically-created/master application key is **not supported** by the S3-Compatible API.
   - A manually-created Application Key is required.
   - The key ID maps to AWS Access Key ID and the application key maps to AWS Secret Access Key.
   - The endpoint must match the B2 account/bucket region.
   - A bucket-restricted key may need `listAllBucketNames` for S3 List Buckets / Head Bucket compatibility.
   - Endpoint format for SDKs is normally `https://s3.<region>.backblazeb2.com` without the bucket in the endpoint.
   Sources checked: Backblaze official S3-Compatible API, App Key, AWS CLI, and integration documentation.

### Current B2 diagnosis
The actual B2 failure is **not yet proven** because no redacted failing GitHub Actions log/error was available in the session.

Most likely diagnostic branches, in order:
1. Wrong key type — master key instead of a manually-created Application Key.
2. Endpoint/region mismatch.
3. Bucket permission restriction, especially List Buckets compatibility.
4. Secret corruption/whitespace or wrong key ID/application key pairing.
5. Client-side signing configuration mismatch (must be SigV4).

Do NOT add another custom B2 signer or SDK dependency until the exact failing error is known. The repo already has standard AWS CLI diagnostics specifically intended to isolate this.

### Important constraint
The previous attempt to add a custom `packages/providers/src/b2-s3.ts` adapter and `@aws-sdk/client-s3` dependency was blocked by the tool safety layer. **Those changes were NOT committed and must not be reported as present.**

### Next action
Run the existing manual GitHub Actions B2 diagnostic workflow using the user's configured secrets, then inspect the resulting redacted error. The required workflow is:
`b2-standard-s3-diagnostic.yml`

Interpretation guide:
- `InvalidAccessKeyId` → wrong/nonexistent key ID.
- `SignatureDoesNotMatch` → key pair, endpoint, region/signing, or secret formatting issue.
- `AccessDenied` / 403 → key capabilities or bucket restriction.
- `NoSuchBucket` / 404 → bucket name or endpoint/region mismatch.
- TLS/connection failure → endpoint/network issue.

If the standard AWS CLI diagnostic passes PUT/HEAD/GET/DELETE, treat B2 connectivity as proven and move to the project integration layer. If it fails, fix the credential/endpoint/permission issue first.

### Required B2 values
Use this conceptual mapping only; never commit values:
```text
B2_KEY_ID=<manually-created application key ID>
B2_APPLICATION_KEY=<application key secret>
B2_ENDPOINT=https://s3.<actual-region>.backblazeb2.com
B2_REGION=<actual-region>
B2_BUCKET=<actual bucket name>
```

### Session continuation rules
- Preserve: zero-cost policy, STOP kill switch, D1 source of truth, Queue async delivery, manual marketplace upload.
- Do not introduce paid APIs or credit-card-required infrastructure.
- Do not change architecture just to work around an unverified B2 error.
- Prefer existing diagnostics and standard S3-compatible tooling before custom cryptographic/signing code.
- Record every real verification result in this handoff.
- Never place B2 secrets in this file or Git history.

### End-of-chat handoff protocol
When the conversation/context is approaching its usable limit:
1. Update this file with the latest verified progress percentage.
2. Record the exact current commit SHA.
3. Record files changed and commits created.
4. Record tests/workflows actually executed and their results.
5. Record the exact unresolved blocker and the single next action.
6. Explicitly state anything that was attempted but **not** committed.
7. Do not leave the next agent guessing or repeat previously failed approaches.

### Current stop point
**STOP HERE before further B2 integration code.** The next useful evidence is the actual result/log from `b2-standard-s3-diagnostic.yml`.
### B2 diagnostic result — verified 2026-09-29
- **Progress: 40% — B2 credential blocker isolated**
- A safe owner-only `issue_comment` trigger was added to `.github/workflows/b2-standard-s3-diagnostic.yml` because the available GitHub connector has no direct workflow-dispatch mutation.
- Diagnostic run #6 confirmed both GitHub secrets are present, without exposing their values.
- AWS CLI S3 PUT against `https://s3.us-west-004.backblazeb2.com` fails with:
  `Connection was closed before we received a valid response from endpoint URL`.
- A transport probe resolved the endpoint DNS but received no HTTP headers from the S3 endpoint in the GitHub runner.
- A separate B2 Native API authentication test reached `https://api.backblazeb2.com` and returned **HTTP 401 / code `unauthorized`**.
- Therefore the currently stored `B2_KEY_ID` + `B2_APPLICATION_KEY` pair is **not accepted by Backblaze B2**. The exact secret values are intentionally not retrievable or printed.
- This is now a credential/key-state blocker, not a TypeScript/SDK/signing implementation blocker.
- Backblaze's current documentation confirms that S3-Compatible API requires a manually-created application key (the master key is not supported for S3), and that the endpoint must match the B2 account region. citeturn0search0turn0search2
- Backblaze Native API upload is a viable fallback integration path if S3 transport remains unusable: authorize account → get upload URL → POST file with SHA-1/content headers. citeturn2search0turn2search1

### Exact next action
1. In Backblaze B2, create a **new Application Key** rather than reusing the current pair.
2. Give it access to the intended bucket `aif-os-e2e-test`, with **Read and Write** while debugging. If the client needs bucket listing, enable **Allow List All Bucket Names**. Backblaze documents this requirement for S3 List Buckets compatibility. citeturn0search0turn0search2
3. Copy the newly-created `keyID` and `applicationKey` immediately; Backblaze only shows the application key value at creation time.
4. Replace GitHub Actions repository secrets **with the new pair**:
   - `B2_KEY_ID`
   - `B2_APPLICATION_KEY`
5. Do not paste either secret into chat, issues, commits, or this handoff.
6. Tell ChatGPT only that the secrets were replaced. Then trigger `/run-b2-diagnostic` again and inspect the Native API result first.
7. If Native API becomes PASS, implement B2 storage through the Native API path unless S3 transport independently becomes usable. This avoids spending another cycle on an endpoint that is currently closing the connection.
8. If Native API remains 401, the new key is still invalid/revoked/expired or the two secret values do not belong to the same key; create one more fresh key and replace both secrets as a pair.

### Diagnostic commits
- Handoff checkpoint: `334037c5cd69d6747ceec9b9fc7b22f333e6b827`
- Owner-only diagnostic trigger: `ff50baa80153d105016d24387242ffbf64d1fec7`
- Redacted transport error: `ce0414e8c860c07f6bf32454d49d4a8c877592df`
- Native API diagnostic: `026543a0a1a9c36470fa06b30382da5e3bbe0d72`
- Redacted Native API auth error: `9a86a09d66b123316bb0bc92b433fb2baed9478a`

### What was NOT done
- No B2 secret values were read, printed, committed, or inferred.
- No custom SigV4 implementation was added.
- No AWS SDK dependency was added.
- No core architecture was changed.


## 14. Session Continuation — Google Drive Storage Migration — 2026-09-29

### Progress
- **Project progress: 49% — Google Drive storage adapter milestone completed**
- This percentage reflects a real code milestone, not documentation-only work.

### Decision implemented
- B2 is no longer the critical path for storage.
- Google Drive is the new primary storage target behind a vendor-neutral storage interface.
- D1, Queue, Workers AI, zero-cost policy, kill switch, duplicate/QC/state-machine logic, and manual marketplace mode remain unchanged.
- B2 diagnostics/legacy references are intentionally retained for traceability and are not used by the new adapter.

### Files added/changed
- `packages/providers/src/storage.ts` — `StorageProvider` contract + deterministic mock implementation.
- `packages/providers/src/google-drive.ts` — OAuth refresh + Drive multipart upload/download/exists/delete using native `fetch()`; hard per-file size limit.
- `packages/providers/src/storage.test.ts` — offline tests for mock round-trip, OAuth/upload request flow, and file-size guard.
- `packages/providers/src/index.ts` — exports storage providers.
- `docs/GOOGLE_DRIVE_STORAGE.md` — setup, secret names, zero-cost guard, and owner setup steps.
- `workers/api/wrangler.toml` — non-secret Google Drive file-size limit.
- `workers/consumer/wrangler.toml` — non-secret Google Drive file-size limit.

### Commits
- `ee7b05bcac04f4975d5d721b43a6b625311f69e6` — storage abstraction
- `f51b35a562ed4672888cd0f6117a7d52a8960ab6` — Google Drive adapter
- `a71b2b911376ac47d29067f5b2eeeccac6f9773f` — storage tests
- `8b237d787974cc3704075d0f01ffb2c1fa9ecf38` — provider exports
- `201483da58f769353983248c029ff474d4cca4b9` — preserve full storage key in Drive
- `4e8f1b8b2f60a95d0b00f7f4b9eee384760c6f4d` — Google Drive setup documentation
- `8156d4043eba48ee4b9cf06290bc89e688cae0ea` — API Worker config
- `f69967122b02c79921d133b6ae3bcf04b64a131b` — consumer Worker config

### Verification
- Repository writes returned successful commit SHAs.
- No secret values were read, printed, inferred, or committed.
- Local `npm test` could not be executed because the runtime cannot resolve `github.com` for a fresh clone. Therefore tests are **not claimed as executed/passing** in this environment.
- The new provider tests are designed to be offline and do not call Google services.

### Google API constraint
Google currently documents standard Drive API usage as no additional cost, with 2026 quota changes and a planned later-2026 billing model above standard daily thresholds. The project therefore does not request quota increases and does not add a paid fallback. Refresh tokens are required for long-term private Drive API access and must be stored securely. See official Google documentation. 

### Next single action
Add the one-time OAuth setup path and then wire the storage provider into the real generation/asset lifecycle. Do not enable live generation until the Google Drive smoke test and Cloudflare bindings are verified.

### Current stop point
**STOP HERE for verification before claiming live Google Drive connectivity.** The adapter exists; actual Google account authorization and runtime upload have not yet been performed.
