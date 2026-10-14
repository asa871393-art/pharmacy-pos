-- Sale controls: discount ceiling and prescription records.

-- Largest total discount (line + invoice) as a percentage of the invoice subtotal.
-- Applies to every role except admin and chief_pharmacist.
INSERT OR IGNORE INTO settings(key, value) VALUES ('max_discount_pct', '10');

-- One prescription per sale that contains prescription-only items.
CREATE TABLE sale_prescriptions (
  sale_id     TEXT PRIMARY KEY REFERENCES sales(id) ON DELETE CASCADE,
  rx_no       TEXT NOT NULL,
  prescriber  TEXT NOT NULL,
  verified_by TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
