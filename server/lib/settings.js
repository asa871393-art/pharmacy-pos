'use strict';
// Reads settings as typed values. `ex` is the db or a transaction executor.
async function getSettings(ex) {
  const rows = await ex.all('SELECT setting_key, setting_value FROM settings');
  const s = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  return {
    pharmacy_name: s.pharmacy_name || '',
    max_discount_pct: Number(s.max_discount_pct) || 0,
    expiry_warn_days: Number(s.expiry_warn_days) || 90
  };
}

module.exports = { getSettings };
