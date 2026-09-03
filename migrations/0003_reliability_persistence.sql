-- Reliability persistence: DLQ + job timing columns for watchdog
PRAGMA foreign_keys = ON;

ALTER TABLE jobs ADD COLUMN state_entered_at TEXT;
ALTER TABLE jobs ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE jobs ADD COLUMN provider TEXT;
ALTER TABLE jobs ADD COLUMN asset_state TEXT;

UPDATE jobs SET state_entered_at = COALESCE(state_entered_at, updated_at, created_at)
WHERE state_entered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_watchdog ON jobs(status, state_entered_at);
CREATE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key);

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  request_id TEXT,
  idempotency_key TEXT,
  job_type TEXT,
  reason TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  failed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dlq_status ON dead_letter_jobs(status, failed_at);
CREATE INDEX IF NOT EXISTS idx_dlq_job ON dead_letter_jobs(job_id);

CREATE TABLE IF NOT EXISTS watchdog_actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  from_status TEXT,
  to_status TEXT,
  actor TEXT NOT NULL DEFAULT 'watchdog',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_watchdog_actions_job ON watchdog_actions(job_id, created_at);
