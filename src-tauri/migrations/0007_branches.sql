-- Multi-branch. Every device works for one branch at a time (settings 'branch_id', chosen at sign-in by an admin);
-- stock is per batch and every batch belongs to a branch, so selling, receiving and counting only touch that branch.
-- Stock moves between branches by transfer: the sending branch ships (transfer_out movements), the other receives
-- (transfer_in movements into its own batch of the same batch number).

ALTER TABLE branches ADD COLUMN address TEXT;
ALTER TABLE branches ADD COLUMN phone TEXT;
ALTER TABLE branches ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

-- Which device wrote the row. Filled by the triggers below when the code leaves it empty; rows pulled from the
-- cloud carry the other device's id.
ALTER TABLE sales ADD COLUMN device_id TEXT;
ALTER TABLE purchase_invoices ADD COLUMN device_id TEXT;

CREATE TRIGGER sales_device AFTER INSERT ON sales WHEN NEW.device_id IS NULL
BEGIN UPDATE sales SET device_id = (SELECT value FROM settings WHERE key = 'sync_device_id') WHERE id = NEW.id; END;
CREATE TRIGGER purchase_invoices_device AFTER INSERT ON purchase_invoices WHEN NEW.device_id IS NULL
BEGIN UPDATE purchase_invoices SET device_id = (SELECT value FROM settings WHERE key = 'sync_device_id') WHERE id = NEW.id; END;
CREATE TRIGGER stock_movements_device AFTER INSERT ON stock_movements WHEN NEW.device_id IS NULL
BEGIN UPDATE stock_movements SET device_id = (SELECT value FROM settings WHERE key = 'sync_device_id') WHERE id = NEW.id; END;

UPDATE sales SET device_id = (SELECT value FROM settings WHERE key = 'sync_device_id') WHERE device_id IS NULL;
UPDATE purchase_invoices SET device_id = (SELECT value FROM settings WHERE key = 'sync_device_id') WHERE device_id IS NULL;
UPDATE stock_movements SET device_id = (SELECT value FROM settings WHERE key = 'sync_device_id') WHERE device_id IS NULL;

CREATE INDEX idx_sales_branch ON sales(branch_id, created_at);
CREATE INDEX idx_batches_branch ON batches(branch_id, product_id);

-- requested (by the receiving branch) → shipped (stock left the sender) → received (stock is on the receiver's shelf).
-- A request can be cancelled before it ships. User columns hold names: the users table is per device.
CREATE TABLE stock_transfers (
  id                 TEXT PRIMARY KEY,
  transfer_no        TEXT NOT NULL UNIQUE,
  from_branch_id     TEXT NOT NULL REFERENCES branches(id),
  to_branch_id       TEXT NOT NULL REFERENCES branches(id),
  status             TEXT NOT NULL CHECK (status IN ('requested','shipped','received','cancelled')),
  note               TEXT,
  requested_by       TEXT,
  requested_at       TEXT,
  shipped_by         TEXT,
  shipped_at         TEXT,
  received_by        TEXT,
  received_at        TEXT,
  created_at         TEXT NOT NULL,
  CHECK (from_branch_id <> to_branch_id)
);
CREATE INDEX idx_transfers_from ON stock_transfers(from_branch_id, status);
CREATE INDEX idx_transfers_to ON stock_transfers(to_branch_id, status);

-- Request lines have requested_qty and no batch; shipped lines have qty, the sender's batch and its details (the
-- receiver creates or tops up its own batch with the same number, expiry and cost).
CREATE TABLE stock_transfer_items (
  id            TEXT PRIMARY KEY,
  transfer_id   TEXT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL REFERENCES products(id),
  requested_qty INTEGER NOT NULL DEFAULT 0 CHECK (requested_qty >= 0),
  qty           INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  from_batch_id TEXT REFERENCES batches(id),
  batch_no      TEXT,
  expiry_date   TEXT,
  unit_cost     INTEGER,
  sell_price    INTEGER,
  to_batch_id   TEXT REFERENCES batches(id)
);
CREATE INDEX idx_transfer_items ON stock_transfer_items(transfer_id);

-- The outbox gets the branch and device of each entry, and two new kinds. SQLite cannot change a CHECK, so the table
-- is rebuilt. Branch rows go first so the cloud knows a branch before any entry that names it.
CREATE TABLE sync_queue_new (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('POST_SALE', 'UPDATE_PRODUCT', 'ADD_PURCHASE', 'STOCK_ADJUST', 'AUDIT_LOG',
                                           'UPSERT_BRANCH', 'TRANSFER')),
  payload    TEXT NOT NULL,              -- JSON
  branch_id  TEXT,                       -- the device's branch when the entry was written
  device_id  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
INSERT INTO sync_queue_new(id, kind, payload, branch_id, device_id)
  SELECT lower(hex(randomblob(16))), 'UPSERT_BRANCH', json_object('branch', json_object(
           'id', id, 'code', code, 'name', name, 'kind', kind, 'license_no', license_no, 'address', address,
           'phone', phone, 'is_active', is_active, 'created_at', created_at)),
         id, (SELECT value FROM settings WHERE key = 'sync_device_id')
  FROM branches ORDER BY created_at, id;
INSERT INTO sync_queue_new(id, kind, payload, branch_id, device_id, created_at, sent_at, attempts, last_error)
  SELECT id, kind, payload, (SELECT id FROM branches ORDER BY created_at, id LIMIT 1),
         (SELECT value FROM settings WHERE key = 'sync_device_id'), created_at, sent_at, attempts, last_error
  FROM sync_queue ORDER BY seq;
DROP TABLE sync_queue;
ALTER TABLE sync_queue_new RENAME TO sync_queue;
CREATE INDEX idx_sync_queue_unsent ON sync_queue(seq) WHERE sent_at IS NULL;

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('transfer_counter', '0'),
  ('sync_sales_cursor', '0');
