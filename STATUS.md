# Status — 2026-09-04 Queue configuration (Phase 1)

## FLUX.1 Schnell verification (Official docs)

- Catalog: listed `@cf/black-forest-labs/flux-1-schnell`
- Paid-only list (2026-07-28): does **not** include flux-1-schnell
- Free: **10,000 Neurons/day** (pricing page 2026-08-28)
- Cost: 4.80 neurons/512 tile + 9.60/step → ~44 neurons @ 512×4 steps
- License: Apache-2.0 (schnell)
- See `docs/PROVIDER_RESEARCH_UPDATE.md`

## Completed this milestone

1. Queue Consumer Worker scaffold (`workers/consumer`) — processMessage for GENERATE/QC/DUP/METADATA/CLEANUP/WATCHDOG
2. Duplicate: exact SHA-256 + pHash hamming (`packages/domain/src/duplicate.ts`)
3. Quota: reserve/commit/release + flux neuron estimate
4. Provider router: score/pick/route + zero-cost gate
5. QC level-1 pipeline + mayUpload constitution
6. Retry / exponential backoff / DLQ / quota-wait
7. Kill switch: STOP blocks IMAGE_GENERATION
8. Marketplace remains **READY_TO_UPLOAD → MANUAL**
9. MOCK_MODE default
10. **Queue configuration (repo)** — `aif-factory` producer on `aif-api`, consumer on `aif-consumer`, native max_retries=3, application DLQ via D1 only

## Tests

- Domain unit tests in `packages/domain/src/core.test.ts`
- Consumer tests in `workers/consumer/src/process.test.ts`
- Run: `npm install --legacy-peer-deps && npm test`

## NOT production-ready yet

- Live Workers AI binding + D1 quota transactions end-to-end
- pHash from real image pixels (block helper exists; needs decode pipeline)
- Semantic duplicate layer
- Dashboard
- Auto marketplace upload (intentionally disabled)
- Queue **resource** on Cloudflare account (config only in repo — owner must `wrangler queues create aif-factory`)

## User must configure

1. Cloudflare account: D1 (done), R2 (deferred), **Queue `aif-factory`**, AI binding
2. Fill wrangler.toml IDs / uncomment queue producer + consumer blocks
3. Confirm flux-1-schnell still Free-callable on their account
4. Never put secrets in GitHub
