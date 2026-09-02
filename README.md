# AI Image Factory OS

Zero-cost autonomous AI image production platform for stock marketplaces.

**Policy: MAX_ALLOWED_COST = 0 · ALLOW_PAID_API = FALSE**

## Status

Foundation phase (architecture, schema, domain, provider research).

| Area | Status |
|------|--------|
| Architecture docs | Done |
| Provider research (verified) | Done |
| D1 schema / migrations | Done |
| State machine | Done |
| Quota manager (design + types) | Done |
| Provider router (design + types) | Done |
| Workers / Queues | Scaffold |
| Image generation (Workers AI) | Scaffold + mock |
| QC / Duplicate | Scaffold |
| Marketplace upload | **MANUAL MODE** (no official bulk API verified) |
| Dashboard | Not started |
| Tests | Partial |

## Stack (Free-tier oriented)

- **Compute**: Cloudflare Workers
- **DB**: Cloudflare D1
- **Storage**: Cloudflare R2 (temporary assets)
- **Queue**: Cloudflare Queues
- **Cron**: Cloudflare Cron Triggers
- **AI**: Cloudflare Workers AI (`@cf/black-forest-labs/flux-1-schnell`)
- **Source / CI**: GitHub

## Zero-cost constitution

1. Target cost = 0 THB
2. Never call paid APIs without explicit user authorization
3. Never exceed free quota
4. Block duplicate / near-duplicate spam
5. Never upload QC failures
6. Never delete assets that are pending / kept / uploaded
7. Provider failure must not kill the whole factory
8. AI never deploys production code
9. Every job is auditable
10. Important decisions are logged
11. Kill switch (STOP / RESUME) must work
12. If unsure → STOP / LOG / ALERT

## Marketplace policy (V1)

Adobe Stock and Freepik **accept AI content** with labeling requirements, but **no official contributor bulk-upload API** was verified for safe automation.

V1 default:

```
QC Passed → READY_TO_UPLOAD → Manual upload via Contributor Portal
```

Auto-upload adapters stay disabled until official supported methods are confirmed.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Provider research](docs/PROVIDER_RESEARCH.md)
- [Database](docs/DATABASE.md)
- [Quota](docs/QUOTA.md)
- [Security](docs/SECURITY.md)
- [Setup](docs/SETUP.md)
- [Marketplaces](docs/MARKETPLACES.md)
- [Operations](docs/OPERATIONS.md)

## Local development

```bash
npm install
npm run test
npm run typecheck
# Mock mode — no real API calls, no quota consumption
MOCK_MODE=true npm run dev
```

## License

Private / user project. Model licenses apply separately (FLUX.1 schnell = Apache-2.0).
