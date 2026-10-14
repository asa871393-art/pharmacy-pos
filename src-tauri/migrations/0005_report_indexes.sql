-- Indexes for reports and the audit log screen. Report queries compare the stored UTC timestamps against UTC bounds
-- (see utc_range in src/lib.rs) instead of converting every row to local time, so these ranges can use an index.
CREATE INDEX IF NOT EXISTS idx_movements_occurred ON stock_movements(occurred_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_log(occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, occurred_at);
