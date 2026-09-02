-- AI Image Factory OS — initial schema
-- D1 / SQLite

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('factory_status', 'STOPPED'),
  ('max_allowed_cost', '0'),
  ('allow_paid_api', 'false'),
  ('mock_mode', 'true'),
  ('upload_mode', 'manual');

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL, -- image | text | vision
  enabled INTEGER NOT NULL DEFAULT 0,
  free_available INTEGER NOT NULL DEFAULT 1,
  paid_available INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  model_id TEXT NOT NULL,
  display_name TEXT,
  free_ok INTEGER NOT NULL DEFAULT 1,
  commercial_license_ok INTEGER NOT NULL DEFAULT 0,
  estimated_unit_cost REAL NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS provider_quotas (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  model_id TEXT,
  window TEXT NOT NULL, -- daily | monthly | per_minute
  limit_units REAL NOT NULL,
  used_units REAL NOT NULL DEFAULT 0,
  reserved_units REAL NOT NULL DEFAULT 0,
  reset_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quota_reservations (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  units REAL NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL, -- reserved | committed | released | expired
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quota_res_status ON quota_reservations(status, expires_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  request_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type, status);

CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS generated_assets (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  status TEXT NOT NULL,
  r2_key TEXT,
  width INTEGER,
  height INTEGER,
  mime_type TEXT,
  byte_size INTEGER,
  sha256 TEXT,
  phash TEXT,
  prompt_version_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  qc_score REAL,
  keep INTEGER NOT NULL DEFAULT 0,
  uploaded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_status ON generated_assets(status);
CREATE INDEX IF NOT EXISTS idx_assets_sha ON generated_assets(sha256);
CREATE INDEX IF NOT EXISTS idx_assets_phash ON generated_assets(phash);

CREATE TABLE IF NOT EXISTS image_hashes (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES generated_assets(id),
  hash_type TEXT NOT NULL, -- sha256 | phash
  hash_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hashes_value ON image_hashes(hash_type, hash_value);

CREATE TABLE IF NOT EXISTS qc_results (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES generated_assets(id),
  level INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS duplicate_results (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  matched_asset_id TEXT,
  layer TEXT NOT NULL, -- exact | phash | semantic
  score REAL,
  is_duplicate INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  concept TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  version INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  negative_prompt TEXT,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  model_id TEXT,
  provider_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(prompt_id, version)
);

CREATE TABLE IF NOT EXISTS trends (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  keyword TEXT,
  signal TEXT,
  confidence REAL,
  source TEXT NOT NULL,
  evidence TEXT,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  summary TEXT,
  allocation_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_plans (
  id TEXT PRIMARY KEY,
  strategy_id TEXT,
  concept TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metadata (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES generated_assets(id),
  title TEXT,
  description TEXT,
  keywords_json TEXT,
  category TEXT,
  ai_generated INTEGER NOT NULL DEFAULT 1,
  ai_disclosure TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS marketplaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  upload_mode TEXT NOT NULL DEFAULT 'manual', -- manual | api | disabled
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}'
);

INSERT OR IGNORE INTO marketplaces (id, name, upload_mode, enabled) VALUES
  ('adobe_stock', 'Adobe Stock', 'manual', 1),
  ('freepik', 'Freepik', 'manual', 0);

CREATE TABLE IF NOT EXISTS upload_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at);

CREATE TABLE IF NOT EXISTS system_events (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watchdog_events (
  id TEXT PRIMARY KEY,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed Cloudflare Workers AI provider (disabled until user enables after setup)
INSERT OR IGNORE INTO providers (id, name, kind, enabled, free_available, paid_available, priority) VALUES
  ('cf_workers_ai', 'Cloudflare Workers AI', 'image', 0, 1, 1, 10);

INSERT OR IGNORE INTO provider_models (id, provider_id, model_id, display_name, free_ok, commercial_license_ok, estimated_unit_cost) VALUES
  ('cf_flux_schnell', 'cf_workers_ai', '@cf/black-forest-labs/flux-1-schnell', 'FLUX.1 Schnell', 1, 1, 0);
