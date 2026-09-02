# Provider Research

Verification date: **2026-09-03**

Official sources only. Do not treat this as permanent — re-verify before production.

---

## 1. Cloudflare Workers AI

| Item | Finding | Source |
|------|---------|--------|
| Free allocation | 10,000 Neurons / day (resets 00:00 UTC) | [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing) |
| Image free (doc note) | Sum of 250 steps, up to 1024×1024 (see official pricing page) | same |
| Overage | $0.011 / 1,000 Neurons on Workers Paid | same |
| Image model (primary candidate) | `@cf/black-forest-labs/flux-1-schnell` | [Model page](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/) |
| Model license (weights) | Apache-2.0 — commercial use allowed | [HF model card](https://huggingface.co/black-forest-labs/FLUX.1-schnell) |
| BFL Terms link on CF page | https://bfl.ai/legal/terms-of-service | CF model page |
| Paid-only models | Some frontier models require Workers Paid (403/5035 on Free) | [Changelog 2026-07-28](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/) |

**Decision**: Use `flux-1-schnell` as primary image provider **only within free Neurons**. Hard-block any path that would bill.

**Risk**: Neuron cost per image varies with size/steps. Quota manager must estimate before reserve.

---

## 2. Cloudflare D1 (Free)

| Limit | Value | Source |
|-------|-------|--------|
| Databases | 10 | [Limits](https://developers.cloudflare.com/d1/platform/limits/) |
| DB size | 500 MB | same |
| Account storage | 5 GB | same |
| Rows read | 5,000,000 / day | [Pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Rows written | 100,000 / day | same |
| Enforcement | Daily limits enforced from 2026-09-01 | [Changelog](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/) |

---

## 3. Cloudflare R2 (Free)

| Limit | Value | Notes |
|-------|-------|-------|
| Storage | 10 GB / month | Independent of Workers plan |
| Class A (write) | 1,000,000 / month | |
| Class B (read) | 10,000,000 / month | |
| Egress | $0 | Always free |

**Risk**: R2 bills automatically past free tier. Factory must track usage and stop writes near limit.

---

## 4. Cloudflare Queues (Free)

| Limit | Value |
|-------|-------|
| Operations | 10,000 / day |
| Retention | 24 hours |

Source: [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)

---

## 5. Adobe Stock (Contributor)

| Item | Finding |
|------|---------|
| AI content allowed? | Yes, with mandatory “Created using generative AI tools” label |
| Official bulk upload API for contributors? | **Not verified** as publicly available for automation |
| Policy docs | [Generative AI guidelines](https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/generative-ai-content-guidelines.html) (updated 2026-06-11) |
| Spam rule | Max ~3 similar iterations |
| Prompt restrictions | No artist names, real people, copyrighted characters, etc. |

**Decision V1**: `READY_TO_UPLOAD` + **manual** Contributor Portal upload. No unofficial automation.

---

## 6. Freepik

Must re-check official contributor docs before any adapter. Default = manual mode.

---

## 7. Google Gemini Free Tier

**Not yet verified in this pass.** Do not enable until official free-tier quota and commercial terms are confirmed and stored in `providers` config. Fallback = Workers AI text models on free Neurons only.

---

## 8. Policy defaults encoded in software

```
MAX_ALLOWED_COST = 0
ALLOW_PAID_API = false
PRIMARY_IMAGE_MODEL = @cf/black-forest-labs/flux-1-schnell
UPLOAD_MODE = manual  # until official API verified
MOCK_MODE supported for CI/dev
```
