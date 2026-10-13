'use strict';
const path = require('path');

const root = path.join(__dirname, '..');

module.exports = {
  root,
  port: Number(process.env.PORT) || 3000,
  // 127.0.0.1 = this computer only. Set HOST=0.0.0.0 to allow other devices on the local network.
  host: process.env.HOST || '127.0.0.1',
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'pharmacy.db'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(root, 'uploads'),
  publicDir: path.join(root, 'public'),
  sessionHours: 12,
  // Iraq is UTC+3 all year (no daylight saving).
  tzOffsetMinutes: Number(process.env.TZ_OFFSET_MINUTES) || 180
};
