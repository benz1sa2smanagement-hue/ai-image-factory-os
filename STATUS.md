# Project Status — AI Image Factory OS

Updated: 2026-09-03

## Phase progress

| Phase | Item | Status |
|-------|------|--------|
| 1 | Inspect repository | Done |
| 2 | Verify official APIs / free tiers / licenses | Done (docs/PROVIDER_RESEARCH.md) |
| 3 | Architecture documentation | Done |
| 4 | Database schema / migrations | Done |
| 5 | Core domain / state machine | Done + tests |
| 6 | Provider router + quota types | Done + tests |
| 7 | Queue / Workers API scaffold | Done (health, STOP/RESUME, mock generate) |
| 8 | Image generation | Mock + CF FLUX adapter scaffold |
| 9 | QC + Duplicate | QC level-1 + cleanup safety; pHash/semantic pending |
| 10 | Metadata | Schema only |
| 11 | Marketplace adapters | MANUAL MODE |
| 12–15 | Analytics / Watchdog / Dashboard / Setup | Schema / not started |
| 16 | Testing | Domain unit tests expanded |

## Constitution in code

- MAX_ALLOWED_COST = 0
- ALLOW_PAID_API = false
- No upload if QC fail
- No delete if uploaded / KEEP / pending job
- STOP/RESUME audited when DB bound

## Manual / blocked

- Adobe Stock & Freepik auto-upload (no official bulk API verified)
- Gemini (free tier not verified in registry)
- Real Workers AI production binding (user must create CF resources)

## Next steps

1. npm install --legacy-peer-deps && npm test
2. Create D1/R2/Queue in Cloudflare; bind in wrangler.toml
3. Confirm flux-1-schnell still on Free plan
4. Queue consumer: GENERATE → QC → METADATA
5. Mobile dashboard against API
