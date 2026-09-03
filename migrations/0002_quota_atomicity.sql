-- Quota atomicity / idempotency helpers for D1
-- Keeps provider_quotas + quota_reservations as source of truth.

PRAGMA foreign_keys = ON;

-- Fast lookup by job for idempotent reserve/commit/release
CREATE INDEX IF NOT EXISTS idx_quota_res_job
  ON quota_reservations(job_id, status);

-- One active (reserved) reservation per job_id (SQLite partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_res_job_reserved_unique
  ON quota_reservations(job_id)
  WHERE status = 'reserved' AND job_id IS NOT NULL AND job_id != '';

-- Optional explicit idempotency key (safe retries across workers)
ALTER TABLE quota_reservations ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_res_idempotency
  ON quota_reservations(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key != '';

-- Seed default daily free neuron quota for Workers AI (limit from Official CF docs)
INSERT OR IGNORE INTO provider_quotas (
  id, provider_id, model_id, window, limit_units, used_units, reserved_units, reset_at
) VALUES (
  'cf_workers_ai_daily',
  'cf_workers_ai',
  '@cf/black-forest-labs/flux-1-schnell',
  'daily',
  10000,
  0,
  0,
  datetime('now', '+1 day')
);
