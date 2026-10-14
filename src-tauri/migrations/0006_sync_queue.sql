-- Cloud sync outbox. Every write that the cloud should know about adds a row here in the same transaction as the
-- write itself, online or not, so nothing is lost if the connection drops mid-way. The sync worker (src/sync.rs)
-- pushes unsent rows in order and marks them sent; the cloud ignores an entry id it has already applied.
CREATE TABLE sync_queue (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('POST_SALE', 'UPDATE_PRODUCT', 'ADD_PURCHASE', 'STOCK_ADJUST', 'AUDIT_LOG')),
  payload    TEXT NOT NULL,              -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX idx_sync_queue_unsent ON sync_queue(seq) WHERE sent_at IS NULL;

-- Connection settings (entered by the admin) and sync progress.
INSERT OR IGNORE INTO settings(key, value) VALUES
  ('sync_enabled', '0'),
  ('sync_url', ''),
  ('sync_key', ''),
  ('sync_secret', ''),
  ('sync_device_name', ''),
  ('sync_cursor', '0'),
  ('sync_last_at', '');
