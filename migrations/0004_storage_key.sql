-- Provider-neutral storage key (rename from R2-specific column)
-- Domain uses storageKey; storage backend remains pluggable (R2/B2/etc).

ALTER TABLE generated_assets RENAME COLUMN r2_key TO storage_key;
