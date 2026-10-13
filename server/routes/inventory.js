'use strict';
const express = require('express');
const { wrap } = require('../lib/http');
const v = require('../lib/validate');
const { badRequest, conflict, notFound } = require('../lib/errors');
const { now, today, addDays } = require('../lib/time');
const { getSettings } = require('../lib/settings');
const { requireRole } = require('../middleware/auth');
const { queryProducts, getProduct } = require('./catalog');

const BARCODE_RE = /^[0-9A-Za-z-]{4,50}$/;

function parseProduct(body) {
  body = body || {};
  const barcode = v.str(body.barcode, 'الباركود', { max: 50, optional: true });
  if (barcode && !BARCODE_RE.test(barcode)) throw badRequest('الباركود: أرقام وحروف لاتينية فقط');
  return {
    brand_name: v.str(body.brand_name, 'الاسم التجاري', { max: 150 }),
    generic_name: v.str(body.generic_name, 'الاسم العلمي', { max: 150 }),
    dosage_form: v.str(body.dosage_form, 'الشكل الدوائي', { max: 50 }),
    pack_size: v.str(body.pack_size, 'حجم العبوة', { max: 50, optional: true }) || '',
    barcode,
    category_id: body.category_id == null || body.category_id === '' ? null : v.id(body.category_id, 'التصنيف'),
    sale_price: v.int(body.sale_price, 'سعر البيع', { min: 0, max: 1e9 }),
    min_stock: v.int(body.min_stock, 'الحد الأدنى للمخزون', { min: 0, max: 1e6 }),
    requires_rx: v.bool(body.requires_rx, 'يحتاج وصفة')
  };
}

async function checkProductRefs(tx, p, selfId = null) {
  if (p.category_id && !(await tx.get('SELECT id FROM categories WHERE id = ?', [p.category_id]))) {
    throw badRequest('التصنيف غير موجود');
  }
  if (p.barcode) {
    const dup = await tx.get('SELECT id, brand_name FROM products WHERE barcode = ?', [p.barcode]);
    if (dup && dup.id !== selfId) throw conflict(`الباركود مستخدم للصنف «${dup.brand_name}»`);
  }
}

function inventoryRoutes(db) {
  const router = express.Router();
  // Every inventory endpoint is for admins and pharmacists only.
  const staff = requireRole('admin', 'pharmacist');

  router.get('/products/:id', staff, wrap(async (req, res) => {
    res.json(await getProduct(db, v.id(req.params.id, 'الصنف')));
  }));

  router.post('/products', staff, wrap(async (req, res) => {
    const p = parseProduct(req.body);
    const id = await db.transaction(async (tx) => {
      await checkProductRefs(tx, p);
      const ts = now();
      const r = await tx.run(
        `INSERT INTO products (brand_name, generic_name, dosage_form, pack_size, barcode, category_id,
                               sale_price, min_stock, requires_rx, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [p.brand_name, p.generic_name, p.dosage_form, p.pack_size, p.barcode, p.category_id,
          p.sale_price, p.min_stock, p.requires_rx, ts, ts]
      );
      return r.lastId;
    });
    res.status(201).json(await getProduct(db, id));
  }));

  router.put('/products/:id', staff, wrap(async (req, res) => {
    const id = v.id(req.params.id, 'الصنف');
    const p = parseProduct(req.body);
    await db.transaction(async (tx) => {
      if (!(await tx.get('SELECT id FROM products WHERE id = ?', [id]))) throw notFound('الصنف غير موجود');
      await checkProductRefs(tx, p, id);
      await tx.run(
        `UPDATE products SET brand_name = ?, generic_name = ?, dosage_form = ?, pack_size = ?, barcode = ?,
                category_id = ?, sale_price = ?, min_stock = ?, requires_rx = ?, updated_at = ?
          WHERE id = ?`,
        [p.brand_name, p.generic_name, p.dosage_form, p.pack_size, p.barcode, p.category_id,
          p.sale_price, p.min_stock, p.requires_rx, now(), id]
      );
    });
    res.json(await getProduct(db, id));
  }));

  // Deactivate / reactivate. Products are never deleted: sales history references them.
  router.patch('/products/:id/active', staff, wrap(async (req, res) => {
    const id = v.id(req.params.id, 'الصنف');
    const active = v.bool((req.body || {}).active, 'الحالة');
    const r = await db.run('UPDATE products SET active = ?, updated_at = ? WHERE id = ?', [active, now(), id]);
    if (!r.changes) throw notFound('الصنف غير موجود');
    res.json(await getProduct(db, id));
  }));

  router.get('/products/:id/batches', staff, wrap(async (req, res) => {
    const id = v.id(req.params.id, 'الصنف');
    const day = today();
    const { expiry_warn_days } = await getSettings(db);
    const warnUntil = addDays(day, expiry_warn_days);
    const rows = await db.all(
      `SELECT b.id, b.batch_no, b.expiry_date, b.quantity, b.unit_cost, b.received_at,
              pu.id AS purchase_id, s.name AS supplier_name
         FROM batches b
         LEFT JOIN purchase_items pi ON pi.id = b.purchase_item_id
         LEFT JOIN purchases pu ON pu.id = pi.purchase_id
         LEFT JOIN suppliers s ON s.id = pu.supplier_id
        WHERE b.product_id = ?
        ORDER BY CASE WHEN b.quantity > 0 THEN 0 ELSE 1 END, b.expiry_date, b.id`,
      [id]
    );
    res.json(rows.map((b) => ({
      ...b,
      status: b.expiry_date < day ? 'expired' : b.expiry_date <= warnUntil ? 'expiring' : 'ok'
    })));
  }));

  router.get('/products/:id/movements', staff, wrap(async (req, res) => {
    res.json(await db.all(
      `SELECT m.id, m.movement_type, m.qty_change, m.reason, m.created_at, b.batch_no, u.full_name AS user_name
         FROM stock_movements m
         JOIN batches b ON b.id = m.batch_id
         JOIN users u ON u.id = m.user_id
        WHERE m.product_id = ?
        ORDER BY m.id DESC LIMIT 200`,
      [v.id(req.params.id, 'الصنف')]
    ));
  }));

  // Manual stock change on one batch: a stock-count correction (+/-) or a write-off (-).
  router.post('/batches/:id/adjust', staff, wrap(async (req, res) => {
    const batchId = v.id(req.params.id, 'الدفعة');
    const body = req.body || {};
    const type = v.oneOf(body.type, 'نوع الحركة', ['adjustment', 'write_off']);
    const change = v.int(body.qty_change, 'الكمية', { min: -1e6, max: 1e6 });
    if (change === 0) throw badRequest('الكمية: يجب ألا تكون صفراً');
    if (type === 'write_off' && change > 0) throw badRequest('الإتلاف يجب أن يُنقص الكمية');
    const reason = v.str(body.reason, 'السبب', { max: 500, min: 3 });

    const batch = await db.transaction(async (tx) => {
      const b = await tx.get('SELECT id, product_id, quantity FROM batches WHERE id = ?', [batchId]);
      if (!b) throw notFound('الدفعة غير موجودة');
      const upd = await tx.run(
        'UPDATE batches SET quantity = quantity + ? WHERE id = ? AND quantity + ? >= 0',
        [change, batchId, change]
      );
      if (upd.changes !== 1) throw conflict(`لا يمكن إنقاص أكثر من الكمية الموجودة (${b.quantity})`);
      await tx.run(
        `INSERT INTO stock_movements (product_id, batch_id, movement_type, qty_change, reason, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [b.product_id, batchId, type, change, reason, req.user.id, now()]
      );
      return tx.get('SELECT * FROM batches WHERE id = ?', [batchId]);
    });
    res.json(batch);
  }));

  // Low stock, expired and soon-to-expire batches.
  router.get('/inventory/alerts', staff, wrap(async (req, res) => {
    const day = today();
    const { expiry_warn_days } = await getSettings(db);
    const products = await queryProducts(db, { where: ['p.active = 1'] });
    const batches = await db.all(
      `SELECT b.id, b.product_id, p.brand_name, b.batch_no, b.expiry_date, b.quantity, b.unit_cost
         FROM batches b JOIN products p ON p.id = b.product_id
        WHERE b.quantity > 0 AND b.expiry_date <= ?
        ORDER BY b.expiry_date`,
      [addDays(day, expiry_warn_days)]
    );
    res.json({
      expiry_warn_days,
      low_stock: products.filter((p) => p.stock > 0 && p.low_stock),
      out_of_stock: products.filter((p) => p.stock === 0),
      expired: batches.filter((b) => b.expiry_date < day),
      expiring: batches.filter((b) => b.expiry_date >= day)
    });
  }));

  router.post('/categories', staff, wrap(async (req, res) => {
    const name = v.str((req.body || {}).name, 'اسم التصنيف', { max: 100 });
    const id = await db.transaction(async (tx) => {
      if (await tx.get('SELECT id FROM categories WHERE name = ?', [name])) throw conflict('التصنيف موجود بالفعل');
      const max = await tx.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories');
      return (await tx.run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name, max.m + 1])).lastId;
    });
    res.status(201).json(await db.get('SELECT id, name, sort_order FROM categories WHERE id = ?', [id]));
  }));

  router.put('/categories/:id', staff, wrap(async (req, res) => {
    const id = v.id(req.params.id, 'التصنيف');
    const name = v.str((req.body || {}).name, 'اسم التصنيف', { max: 100 });
    await db.transaction(async (tx) => {
      const dup = await tx.get('SELECT id FROM categories WHERE name = ?', [name]);
      if (dup && dup.id !== id) throw conflict('التصنيف موجود بالفعل');
      const r = await tx.run('UPDATE categories SET name = ? WHERE id = ?', [name, id]);
      if (!r.changes) throw notFound('التصنيف غير موجود');
    });
    res.json(await db.get('SELECT id, name, sort_order FROM categories WHERE id = ?', [id]));
  }));

  return router;
}

module.exports = { inventoryRoutes };
