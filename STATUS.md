# Project status — 2026-09-03

Repository: https://github.com/benz1sa2smanagement-hue/ai-image-factory-os

## Completed this phase

1. **Repo created** (empty → initialized)
2. **Official docs verified** (Workers AI, D1, R2, Queues, FLUX schnell Apache-2.0, Adobe Stock AI labeling)
3. **docs/PROVIDER_RESEARCH.md** with sources + dates
4. **Architecture + constitution** documented
5. **D1 migration 0001** — full core schema + seeds
6. **Domain package**: state machine, zero-cost policy, quota helpers, provider scoring
7. **Unit tests** for policy + transitions
8. **Mock image provider** + CF FLUX adapter stub
9. **API Worker scaffold**: `/health`, `/factory/status|stop|resume`, mock `/v1/generate`
10. **CI workflow** skeleton
11. Marketplace **MANUAL MODE** (no fake auto-upload)

## Not done yet (honest)

- Full queue consumers / cron watchdog
- Real quota reservation transactions end-to-end
- Live Workers AI generate path behind reserve+commit
- QC L1–L3 implementation
- pHash / semantic duplicate
- Metadata AI
- Mobile dashboard + setup wizard
- E2E / security test suites
- Staging deploy

## User must configure after deploy

1. Cloudflare account + create D1, R2, Queue
2. Fill `wrangler.toml` IDs
3. `wrangler secret` for tokens if using REST
4. Run migrations on D1
5. Set `factory_status` RUNNING only after smoke tests
6. Upload to Adobe/Freepik **manually** in V1

## Free-tier services verified for design

| Service | Free |
|---------|------|
| Workers AI Neurons | 10k/day |
| D1 | 5M read / 100k write / day, 5GB |
| R2 | 10GB + ops |
| Queues | 10k ops/day |
| FLUX.1 schnell on CF | Candidate model; Apache-2.0 weights |

## Known limitations

- Neuron cost per image is not a fixed “0 THB unit” — must stay inside daily free Neurons or stop
- R2 can bill if storage/ops exceed free — monitor
- No official Adobe contributor bulk API → manual upload
- Gemini not enabled pending verification
