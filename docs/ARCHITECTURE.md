# Architecture

## Overview

AI Image Factory OS is a **policy-first** cloud automation system.

- **Infrastructure core**: Cloudflare (Workers, D1, R2, Queues, Cron, Workers AI)
- **Source of truth**: D1
- **Async work**: Queues (not the database)
- **Images**: R2 temporary → QC → metadata → READY_TO_UPLOAD → cleanup
- **AI proposes**; **Policy Engine decides**

```
Trend → Strategy → Production Plan → Queue → Generate → QC → Duplicate
  → Metadata → READY_TO_UPLOAD → [Manual Upload V1] → Track → Learn
```

## Layers

```
frontend/          Mobile-first dashboard (future)
packages/domain/   State machine, jobs, policies (pure TS)
packages/providers/ Provider interfaces + Cloudflare AI adapter + mock
packages/quota/    Reservation / commit / release
workers/           CF Workers entrypoints (API, queue consumers, cron)
migrations/        D1 SQL migrations
docs/              Architecture & research
tests/             Unit + policy tests
```

## State machine (assets / jobs)

```
PLANNED → QUEUED → GENERATING → GENERATED → QC
  → PASSED | REJECTED
PASSED → METADATA → READY_TO_UPLOAD → UPLOADING → UPLOADED → TRACKING
  → ARCHIVED | DELETED

Failure: FAILED → RETRY_WAIT → RETRY → DEAD_LETTER
```

Every transition writes `audit_logs`.

## AI roles (not many agents)

| Role | Responsibility |
|------|----------------|
| Strategy AI | Trends, concepts, plans, learning recommendations |
| Generation AI | Prompts / concepts for image models |
| QC AI | Commercial / stock suitability (after deterministic QC) |
| Metadata AI | Title, description, keywords, AI disclosure flags |
| Analytics AI | Performance summaries |

Deterministic code owns: queue, quota, security, state, duplicate hash layers, retry, policy, storage, logging, watchdog.

## Zero-cost gate

Before any external inference call:

1. `ALLOW_PAID_API === false`
2. Provider `free_available === true`
3. Quota reserve succeeds
4. Estimated cost ≤ 0 under free allocation

Else: `WAITING_FOR_QUOTA` or `BLOCKED` — never “try paid”.

## Kill switch

`factory_status = STOPPED` stops new generation / upload / non-critical jobs.
Existing in-flight jobs, cleanup, logging, and critical recovery continue per policy.
