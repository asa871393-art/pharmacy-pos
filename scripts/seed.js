'use strict';
// Fills the database with the sample data that used to live in public/js/data.js, plus a
// default admin user.
//   npm run seed             -> refuses if the database already has products or users
//   npm run seed -- --reset  -> deletes the database file first (all data is lost)
const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('../server/config');
const { openDatabase } = require('../server/db');
const { now } = require('../server/lib/time');

const ADMIN = { username: 'admin', password: 'Admin@2026', full_name: 'مدير النظام' };

const CATEGORIES = [
  { key: 'pain', name: 'مسكنات' },
  { key: 'anti', name: 'مضادات حيوية' },
  { key: 'stomach', name: 'الجهاز الهضمي' },
  { key: 'resp', name: 'تنفسي وحساسية' },
  { key: 'chronic', name: 'أمراض مزمنة' },
  { key: 'vit', name: 'فيتامينات' }
];

// From data.js. exp 'MM/YYYY' becomes the last day of that month; products without one get a
// distant expiry. Costs were not in data.js, so the seed assumes 70% of the sale price.
const PRODUCTS = [
  { name: 'بنادول 500', generic: 'باراسيتامول', form: 'أقراص · 24 قرص', cat: 'pain', price: 3000, stock: 48, rx: false, exp: '' },
  { name: 'أوگمنتين 1غ', generic: 'أموكسيسيلين + كلافيولانيك', form: 'أقراص · 14 قرص', cat: 'anti', price: 9500, stock: 6, rx: true, exp: '' },
  { name: 'بروفين 400', generic: 'آيبوبروفين', form: 'أقراص · 30 قرص', cat: 'pain', price: 2500, stock: 35, rx: false, exp: '' },
  { name: 'أوميبرازول 20', generic: 'أوميبرازول', form: 'كبسول · 14 كبسولة', cat: 'stomach', price: 4000, stock: 22, rx: false, exp: '11/2026' },
  { name: 'فنتولين', generic: 'سالبيوتامول', form: 'بخاخ · 200 جرعة', cat: 'resp', price: 6500, stock: 4, rx: true, exp: '' },
  { name: 'فيتامين C 1000', generic: 'حمض الأسكوربيك', form: 'أقراص فوارة · 20', cat: 'vit', price: 5000, stock: 60, rx: false, exp: '' },
  { name: 'سيتريزين 10', generic: 'سيتريزين', form: 'أقراص · 10 أقراص', cat: 'resp', price: 1500, stock: 0, rx: false, exp: '' },
  { name: 'ميتفورمين 850', generic: 'ميتفورمين', form: 'أقراص · 30 قرص', cat: 'chronic', price: 3500, stock: 18, rx: true, exp: '12/2026' }
];
const LOW_STOCK = 6;
const DEFAULT_EXPIRY = '2028-06-30';

// Test barcodes in the GS1 "restricted circulation" range (prefix 200), valid EAN-13.
function testBarcode(n) {
  const body = '200' + String(n).padStart(9, '0');
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

function monthEnd(mmYyyy) {
  const [m, y] = mmYyyy.split('/').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

async function seedDatabase(db, { adminPassword = ADMIN.password } = {}) {
  await db.transaction(async (tx) => {
    const existing = await tx.get(
      'SELECT (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM users) AS u'
    );
    if (existing.p || existing.u) {
      throw new Error('قاعدة البيانات تحتوي على بيانات بالفعل. استخدم: npm run seed -- --reset');
    }
    const ts = now();
    const admin = await tx.run(
      'INSERT INTO users (username, full_name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [ADMIN.username, ADMIN.full_name, bcrypt.hashSync(adminPassword, 10), 'admin', ts]
    );

    const catIds = {};
    for (const [i, c] of CATEGORIES.entries()) {
      const r = await tx.run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [c.name, i + 1]);
      catIds[c.key] = r.lastId;
    }

    for (const [i, p] of PRODUCTS.entries()) {
      const [dosageForm, packSize = ''] = p.form.split(' · ');
      const prod = await tx.run(
        `INSERT INTO products (brand_name, generic_name, dosage_form, pack_size, barcode, category_id,
                               sale_price, min_stock, requires_rx, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [p.name, p.generic, dosageForm, packSize, testBarcode(i + 1), catIds[p.cat], p.price, LOW_STOCK,
          p.rx ? 1 : 0, ts, ts]
      );
      if (p.stock > 0) {
        const batch = await tx.run(
          `INSERT INTO batches (product_id, batch_no, expiry_date, quantity, unit_cost, received_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [prod.lastId, `OPEN-${i + 1}`, p.exp ? monthEnd(p.exp) : DEFAULT_EXPIRY, p.stock,
            Math.round(p.price * 0.7), ts]
        );
        await tx.run(
          `INSERT INTO stock_movements (product_id, batch_id, movement_type, qty_change, reason, user_id, created_at)
           VALUES (?, ?, 'opening', ?, ?, ?, ?)`,
          [prod.lastId, batch.lastId, p.stock, 'رصيد افتتاحي', admin.lastId, ts]
        );
      }
    }
  });
}

module.exports = { seedDatabase, testBarcode, ADMIN };

if (require.main === module) {
  (async () => {
    if (process.argv.includes('--reset')) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbFile + suffix, { force: true });
      console.log('تم حذف قاعدة البيانات القديمة.');
    }
    const db = await openDatabase(config.dbFile);
    await seedDatabase(db);
    await db.close();
    console.log(`تمت تعبئة قاعدة البيانات: ${config.dbFile}`);
    console.log(`المستخدم: ${ADMIN.username}  كلمة المرور: ${ADMIN.password}  (غيّرها بعد أول دخول)`);
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
