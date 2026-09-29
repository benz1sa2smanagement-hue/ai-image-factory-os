# AI Image Factory OS

Zero-cost autonomous AI image production platform for stock marketplaces.

**Policy: MAX_ALLOWED_COST = 0 · ALLOW_PAID_API = FALSE**

## Status

Foundation + ephemeral-asset architecture phase.

| Area | Status |
|------|--------|
| Architecture docs | Done |
| Provider research | Done |
| D1 schema / migrations | Done |
| State machine | Done |
| Quota manager | Done |
| Provider router | Done |
| Workers / Queues | Scaffold |
| Image generation (Workers AI) | Scaffold + mock |
| QC / Duplicate | Scaffold |
| **Persistent image storage** | **Disabled by design** |
| Marketplace upload | **MANUAL MODE** |
| Dashboard | Not started |
| Tests | Partial |

## Ephemeral image policy

Generated image bytes are not written to Google Drive, R2, B2, or another persistent object store.

```text
Generate → QC → Duplicate check → Metadata → Present to user
       → user uploads to marketplace manually
       → release/discard transient bytes
```

D1 stores job/state/metadata, not image binaries.

## Stack

- **Compute**: Cloudflare Workers
- **DB**: Cloudflare D1 (state/metadata only)
- **Queue**: Cloudflare Queues
- **Cron**: Cloudflare Cron Triggers
- **AI**: Cloudflare Workers AI (`@cf/black-forest-labs/flux-1-schnell`)
- **Source / CI**: GitHub
- **Persistent image storage**: none

## Zero-cost constitution

1. Target cost = 0 THB
2. Never call paid APIs without explicit user authorization
3. Never exceed free quota
4. Block duplicate / near-duplicate spam
5. Never upload QC failures
6. Never persist image binaries
7. Provider failure must not kill the whole factory
8. AI never deploys production code
9. Every job is auditable
10. Important decisions are logged
11. Kill switch (STOP / RESUME) must work
12. If unsure → STOP / LOG / ALERT

## Marketplace policy (V1)

Adobe Stock and Freepik are **MANUAL MODE** in this project. The system does not automate contributor uploads.

```text
QC Passed → READY_TO_UPLOAD → user receives/selects image → manual marketplace upload
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Ephemeral asset flow](docs/EPHEMERAL_ASSET_FLOW.md)
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
MOCK_MODE=true npm run dev
```

## License

Private / user project. Model licenses apply separately (FLUX.1 schnell = Apache-2.0).