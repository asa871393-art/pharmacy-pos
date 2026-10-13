'use strict';
const fs = require('fs');
const path = require('path');
const { createSqliteDb } = require('./sqlite');

const DEFAULT_SETTINGS = {
  pharmacy_name: '[اسم الصيدلية]',
  max_discount_pct: '10',
  expiry_warn_days: '90'
};

// Opens the database, creates missing tables and inserts default settings.
async function openDatabase(file) {
  const db = createSqliteDb(file);
  await db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const row = await db.get('SELECT setting_key FROM settings WHERE setting_key = ?', [key]);
    if (!row) await db.run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
  }
  return db;
}

module.exports = { openDatabase, DEFAULT_SETTINGS };
