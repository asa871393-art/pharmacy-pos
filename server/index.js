'use strict';
const config = require('./config');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

(async () => {
  const db = await openDatabase(config.dbFile);
  const users = await db.get('SELECT COUNT(*) AS n FROM users');
  if (!users.n) console.warn('تنبيه: لا يوجد مستخدمون. شغّل الأمر: npm run seed');

  createApp({ db }).listen(config.port, config.host, () => {
    console.log(`الخادم يعمل على http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`قاعدة البيانات: ${config.dbFile}`);
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
