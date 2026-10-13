-- Pharmacy POS — initial schema (MVP, single branch, offline-first)
-- Conventions: ids are UUIDv7 text, money is INTEGER dinars (IQD has no fractions in practice),
-- dates are ISO 'YYYY-MM-DD', timestamps are ISO-8601 UTC text.
-- Stock is the sum of stock_movements; batches.qty_on_hand is a cached value kept in step inside the same transaction.

PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE branches (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'store' CHECK (kind IN ('store','warehouse')),
  license_no TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  username              TEXT NOT NULL UNIQUE,
  full_name             TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('admin','chief_pharmacist','pharmacist','cashier','storekeeper')),
  password_hash         TEXT,
  pin_hash              TEXT,
  pharmacist_license_no TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── Catalog ────────────────────────────────────────────────────────────
CREATE TABLE categories (
  id        TEXT PRIMARY KEY,
  name_ar   TEXT NOT NULL,
  name_en   TEXT,
  parent_id TEXT REFERENCES categories(id)
);

CREATE TABLE manufacturers (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  country TEXT
);

CREATE TABLE active_ingredients (
  id         TEXT PRIMARY KEY,
  name_inn   TEXT NOT NULL UNIQUE,   -- international non-proprietary name, e.g. 'Metformin'
  name_ar    TEXT,
  atc_code   TEXT,
  drug_class TEXT                    -- used for allergy matching, e.g. 'penicillin'
);

CREATE TABLE products (
  id               TEXT PRIMARY KEY,
  trade_name       TEXT NOT NULL,
  trade_name_ar    TEXT,
  category_id      TEXT REFERENCES categories(id),
  manufacturer_id  TEXT REFERENCES manufacturers(id),
  dosage_form      TEXT NOT NULL,          -- tablet, capsule, syrup, injection, inhaler, cream…
  strength_label   TEXT NOT NULL,          -- display text, e.g. '850 mg'
  pack_size        INTEGER NOT NULL DEFAULT 1,
  pack_unit        TEXT NOT NULL DEFAULT 'علبة',
  allow_strip_sale INTEGER NOT NULL DEFAULT 0,
  requires_rx      INTEGER NOT NULL DEFAULT 0,
  is_controlled    INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp      INTEGER NOT NULL DEFAULT 0,  -- basis points, 100 = 1%
  sell_price       INTEGER NOT NULL,            -- default price per pack
  composition_key  TEXT NOT NULL DEFAULT '',    -- normalized ingredients+strengths; equal key = substitutable
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_products_trade ON products(trade_name);
CREATE INDEX idx_products_composition ON products(composition_key);

CREATE TABLE product_ingredients (
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id  TEXT NOT NULL REFERENCES active_ingredients(id),
  strength_value REAL NOT NULL,
  strength_unit  TEXT NOT NULL,           -- mg, mcg, ml, %, IU
  PRIMARY KEY (product_id, ingredient_id)
);

CREATE TABLE product_barcodes (
  code           TEXT PRIMARY KEY,        -- GTIN-13/14 or internal code
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'gtin' CHECK (kind IN ('gtin','ean','internal')),
  units_per_scan INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_barcodes_product ON product_barcodes(product_id);

-- ── Suppliers & purchasing ────────────────────────────────────────────
CREATE TABLE suppliers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  phone              TEXT,
  tax_no             TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  min_expiry_months  INTEGER NOT NULL DEFAULT 6,
  balance            INTEGER NOT NULL DEFAULT 0,   -- what we owe them
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE purchase_invoices (
  id                  TEXT PRIMARY KEY,
  branch_id           TEXT NOT NULL REFERENCES branches(id),
  supplier_id         TEXT NOT NULL REFERENCES suppliers(id),
  supplier_invoice_no TEXT NOT NULL,
  invoice_date        TEXT NOT NULL,
  due_date            TEXT,
  subtotal            INTEGER NOT NULL DEFAULT 0,
  discount            INTEGER NOT NULL DEFAULT 0,
  tax                 INTEGER NOT NULL DEFAULT 0,
  total               INTEGER NOT NULL DEFAULT 0,
  paid                INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','paid')),
  posted_by           TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (supplier_id, supplier_invoice_no)
);

-- One row per batch received (a product delivered in three batches = three rows).
CREATE TABLE purchase_invoice_items (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id),
  batch_no    TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  bonus_qty   INTEGER NOT NULL DEFAULT 0,
  unit_cost   INTEGER NOT NULL,
  sell_price  INTEGER NOT NULL,
  gs1_raw     TEXT
);

CREATE TABLE supplier_ledger (
  id          TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  entry_type  TEXT NOT NULL CHECK (entry_type IN ('invoice','payment','return','credit','opening')),
  ref_id      TEXT,
  debit       INTEGER NOT NULL DEFAULT 0,
  credit      INTEGER NOT NULL DEFAULT 0,
  entry_date  TEXT NOT NULL,
  note        TEXT
);
CREATE INDEX idx_supplier_ledger ON supplier_ledger(supplier_id, entry_date);

-- ── Inventory ─────────────────────────────────────────────────────────
CREATE TABLE batches (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id),
  branch_id     TEXT NOT NULL REFERENCES branches(id),
  batch_no      TEXT NOT NULL,
  expiry_date   TEXT NOT NULL,
  unit_cost     INTEGER NOT NULL,
  sell_price    INTEGER NOT NULL,
  qty_on_hand   INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  supplier_id   TEXT REFERENCES suppliers(id),
  source_item_id TEXT REFERENCES purchase_invoice_items(id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantine','expired')),
  received_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (product_id, branch_id, batch_no)
);
CREATE INDEX idx_batches_fefo ON batches(product_id, branch_id, expiry_date);

CREATE TABLE stock_movements (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL REFERENCES batches(id),
  type        TEXT NOT NULL CHECK (type IN ('opening','purchase','sale','return_in','return_out',
                                             'transfer_in','transfer_out','adjust','destroy','damage','sample')),
  qty         INTEGER NOT NULL,          -- signed: + in, − out
  unit_cost   INTEGER NOT NULL,
  ref_type    TEXT,
  ref_id      TEXT,
  user_id     TEXT REFERENCES users(id),
  device_id   TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_movements_batch ON stock_movements(batch_id, occurred_at);

CREATE TABLE reorder_rules (
  product_id            TEXT NOT NULL REFERENCES products(id),
  branch_id             TEXT NOT NULL REFERENCES branches(id),
  min_qty               INTEGER NOT NULL DEFAULT 0,
  reorder_level         INTEGER NOT NULL DEFAULT 0,
  max_qty               INTEGER NOT NULL DEFAULT 0,
  preferred_supplier_id TEXT REFERENCES suppliers(id),
  PRIMARY KEY (product_id, branch_id)
);

-- ── Customers ─────────────────────────────────────────────────────────
CREATE TABLE patients (
  id             TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  phone          TEXT UNIQUE,
  birth_date     TEXT,
  credit_limit   INTEGER NOT NULL DEFAULT 0,
  balance        INTEGER NOT NULL DEFAULT 0,   -- what they owe us
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE patient_allergies (
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  ingredient_id TEXT REFERENCES active_ingredients(id),
  drug_class    TEXT,
  severity      TEXT NOT NULL DEFAULT 'severe'
);

-- ── Sales ─────────────────────────────────────────────────────────────
CREATE TABLE shifts (
  id            TEXT PRIMARY KEY,
  branch_id     TEXT NOT NULL REFERENCES branches(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  opened_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at     TEXT,
  opening_cash  INTEGER NOT NULL DEFAULT 0,
  expected_cash INTEGER,
  counted_cash  INTEGER
);

CREATE TABLE sales (
  id             TEXT PRIMARY KEY,
  invoice_no     TEXT NOT NULL UNIQUE,
  branch_id      TEXT NOT NULL REFERENCES branches(id),
  shift_id       TEXT REFERENCES shifts(id),
  patient_id     TEXT REFERENCES patients(id),
  cashier_id     TEXT REFERENCES users(id),
  subtotal       INTEGER NOT NULL,
  discount_total INTEGER NOT NULL DEFAULT 0,
  tax_total      INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL,
  paid           INTEGER NOT NULL,
  change_given   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('held','paid','void','returned')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sales_created ON sales(created_at);

CREATE TABLE sale_items (
  id                   TEXT PRIMARY KEY,
  sale_id              TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id           TEXT NOT NULL REFERENCES products(id),
  batch_id             TEXT NOT NULL REFERENCES batches(id),
  qty                  INTEGER NOT NULL CHECK (qty > 0),
  unit_price           INTEGER NOT NULL,
  unit_cost            INTEGER NOT NULL,
  discount             INTEGER NOT NULL DEFAULT 0,
  line_total           INTEGER NOT NULL,
  fefo_override_reason TEXT
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE payments (
  id        TEXT PRIMARY KEY,
  sale_id   TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method    TEXT NOT NULL CHECK (method IN ('cash','card','credit','insurance')),
  amount    INTEGER NOT NULL,
  reference TEXT
);

CREATE TABLE returns (
  id               TEXT PRIMARY KEY,
  original_sale_id TEXT NOT NULL REFERENCES sales(id),
  reason           TEXT,
  refund_method    TEXT NOT NULL CHECK (refund_method IN ('cash','card','credit')),
  refund_total     INTEGER NOT NULL,
  user_id          TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE return_items (
  id           TEXT PRIMARY KEY,
  return_id    TEXT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
  batch_id     TEXT NOT NULL REFERENCES batches(id),
  qty          INTEGER NOT NULL CHECK (qty > 0),
  amount       INTEGER NOT NULL,
  restock      INTEGER NOT NULL DEFAULT 1
);

-- ── Audit (append-only, hash-chained) ─────────────────────────────────
CREATE TABLE audit_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  payload     TEXT,               -- JSON
  device_id   TEXT,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- ── Sync outbox (filled from phase 4) ─────────────────────────────────
CREATE TABLE sync_outbox (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op        TEXT NOT NULL,
  payload   TEXT NOT NULL,
  synced_at TEXT
);

INSERT INTO settings(key, value) VALUES
  ('invoice_prefix', 'MB'),
  ('invoice_counter', '0'),
  ('currency', 'IQD'),
  ('expiry_watch_days', '180'),
  ('expiry_warning_days', '90'),
  ('expiry_critical_days', '30');
