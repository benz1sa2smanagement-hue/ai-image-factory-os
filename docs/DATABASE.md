# Database (Cloudflare D1)

Migrations live in `/migrations`.

## Core tables (v1)

- `settings` — factory flags (STOP/RESUME, mock, limits)
- `providers` / `provider_models` / `provider_health` / `provider_quotas` / `quota_reservations`
- `jobs` / `job_attempts`
- `generation_requests` / `generated_assets`
- `image_hashes` / `duplicate_results` / `qc_results`
- `prompts` / `prompt_versions`
- `strategies` / `trends` / `production_plans`
- `metadata`
- `marketplaces` / `marketplace_accounts` / `upload_jobs` / `upload_results`
- `sales` / `downloads` / `revenue`
- `audit_logs` / `system_events` / `watchdog_events`

See `migrations/0001_init.sql` for full DDL and indexes.

## Rules

- D1 is source of truth; Queues are delivery only
- All state transitions audited
- Migrations are versioned; avoid destructive changes without recovery plan
