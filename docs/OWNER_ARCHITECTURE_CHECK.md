# Owner Architecture Verification Check

**Principle locked for this project**

| Layer | Where it runs | Owner PC required? |
|-------|---------------|--------------------|
| **D. Production Runtime** | Cloudflare Workers / Queues / Cron / D1 / R2 / Workers AI | **No** |
| **C. Cloudflare Deployment Verification** | Cloudflare dashboard + Wrangler (CI or one-time) | Only for setup/deploy triggers |
| **B. GitHub CI Verification** | GitHub Actions (`npm test`, typecheck) | **No** |
| **A. Local Development Verification** | Owner laptop (`npm`, `vitest`, `tsc`, `wrangler --local`) | Optional for developers only |

## Production Runtime (D)

Designed stack (zero-cost / free-tier oriented):

- **Compute**: Cloudflare Workers (`workers/api`, `workers/consumer`)
- **Async**: Cloudflare Queues (consumer worker)
- **Schedule**: Cloudflare Cron Triggers (watchdog / cleanup — to be bound)
- **DB**: Cloudflare D1 (single DB for jobs + quota)
- **Storage**: Cloudflare R2
- **AI**: Cloudflare Workers AI (policy-gated; MOCK_MODE default)

Factory jobs run when Workers are deployed and bindings are set. **Owner PC does not need to stay online.**

`npm` / `vitest` / `tsc` / `wrangler` are **not** production runtime dependencies.

## GitHub (B + deploy path)

Current `.github/workflows/ci.yml`:

- On push/PR → `npm install` → `npm test` → `npm run typecheck`
- Runs on GitHub-hosted runners (not owner PC)

**Not yet present (by design until secrets/resources exist):**

- Automated `wrangler deploy`
- Automated remote D1 migration apply

Those belong in a future **manual_dispatch / protected environment** workflow after one-time Cloudflare resource creation — never as “owner must run npm daily”.

## Mobile Dashboard (future)

Architecture target: mobile UI → **HTTPS API Worker** (`aif-api`) → D1/Queues on Cloudflare.

Phone does **not** run npm or a local server. Control plane = Cloud API + `factory_status` in D1.

## D1

- Migrations live in repo: `migrations/0001` → `0003`
- Apply path: Wrangler `d1 migrations apply` (local for dev, remote after binding)
- Production uses **one** D1 database bound as `DB` on both API and consumer workers
- Bindings are **commented** in `wrangler.toml` until owner creates the DB once (no accidental prod deploy from repo alone)

## Zero-cost

- No paid SaaS required in architecture docs
- `MOCK_MODE=true` default in worker vars
- `MAX_ALLOWED_COST=0` / `ALLOW_PAID_API=false` in domain policy

## One-time owner setup (only)

1. Cloudflare Free account
2. Create D1 / R2 / Queue (dashboard or wrangler once)
3. Put `database_id` into wrangler bindings (or CF dashboard bind)
4. Apply migrations once to that D1
5. Deploy Workers once (dashboard, Wrangler, or future GH Action with secrets)
6. Store any secrets via `wrangler secret` / CF dashboard — **never in GitHub source**

## Must NOT require owner machine ongoing

- Queue processing
- Watchdog / retry / DLQ
- Quota reserve/commit/release
- Daily free-tier generation (when enabled)
- STOP/RESUME via settings (API/dashboard)

## Honest gaps (not architecture violations)

- Deploy workflow not automated yet
- Cron binding not in wrangler.toml yet
- Dashboard not built yet (API scaffold exists)
- Resource IDs still placeholders until one-time setup
