# Provider Research Update — 2026-09-03 (Backend Core milestone)

## @cf/black-forest-labs/flux-1-schnell

| Check | Result | Source |
|-------|--------|--------|
| Listed in Workers AI catalog | Yes | https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/ |
| Requires Workers Paid plan? | **Not in Paid-only list** (Paid-only as of 2026-07-28: kimi-k2.6, kimi-k2.7-code, glm-5.2) | https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/ |
| Free allocation | **10,000 Neurons / day** (account-wide, 00:00 UTC reset) | https://developers.cloudflare.com/workers-ai/platform/pricing/ (updated 2026-08-28) |
| Neuron cost | 4.80 / 512×512 tile + 9.60 / step | same pricing page |
| Default steps | 4 (max 8) | model page |
| Est. 512×512 × 4 steps | ~44 neurons → headroom under 10k/day | derived |
| Commercial license (weights) | Apache-2.0 for schnell | HuggingFace BFL model card |
| Auto paid fallback | **Forbidden** by constitution | policy.ts |

**Caveat:** Some docs still mention an alternate “250 image steps/day” free table. Runtime must treat **Neurons as authoritative** and stop at quota errors rather than guessing.

**Decision:** Keep FLUX.1 Schnell as primary image model under MOCK + live-with-quota paths. Re-verify before production enable.
