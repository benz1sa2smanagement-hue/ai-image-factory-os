# Cloudflare Real Integration Verification Notes

## Migration 0003

`migrations/0003_reliability_persistence.sql` uses:
- `ALTER TABLE jobs ADD COLUMN ...` (supported by D1)
- `CREATE TABLE IF NOT EXISTS dead_letter_jobs` / `watchdog_actions`
- Indexes with `IF NOT EXISTS`

Validated against SQLite (same dialect as `wrangler d1 --local`).

Owner should run:
```bash
npx wrangler d1 migrations apply aif-os --local
# or remote after binding database_id in wrangler.toml
```

## Worker bindings

Uncomment `[[d1_databases]]` in `workers/consumer/wrangler.toml` with real `database_id`.
Jobs + quota share the same `DB` binding (required for `releaseReservedQuotaForJob`).

## Integration sim

```bash
node scripts/d1-integration-sim.mjs
```

## Not run in CI sandbox when registry/wrangler unavailable

- `wrangler d1 migrations apply` (npm registry 502 / wrangler not installed)
- Full `vitest` via npm (install timeouts)
- `tsc` full project (incomplete typescript package in sandbox)

Domain unit subset + SQL lifecycle sim were run successfully.
