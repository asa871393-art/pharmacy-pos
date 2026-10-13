'use strict';
const express = require('express');
const { wrap } = require('../lib/http');
const v = require('../lib/validate');
const { notFound } = require('../lib/errors');
const { today, addDays } = require('../lib/time');
const { getSettings } = require('../lib/settings');

// Products with stock (sum of non-expired batch quantities), nearest valid expiry and the
// quantity still sitting in expired batches (to be written off).
async function queryProducts(ex, { where = [], params = [], order = 'p.brand_name' } = {}) {
  const day = today();
  const { expiry_warn_days } = await getSettings(ex);
  const warnUntil = addDays(day, expiry_warn_days);
  const rows = await ex.all(
    `SELECT p.id, p.brand_name, p.generic_name, p.dosage_form, p.pack_size, p.barcode,
            p.category_id, c.name AS category_name, p.sale_price, p.min_stock, p.requires_rx, p.active,
            COALESCE(SUM(CASE WHEN b.expiry_date >= ? THEN b.quantity ELSE 0 END), 0) AS stock,
            MIN(CASE WHEN b.expiry_date >= ? AND b.quantity > 0 THEN b.expiry_date END) AS next_expiry,
            COALESCE(SUM(CASE WHEN b.expiry_date < ? THEN b.quantity ELSE 0 END), 0) AS expired_qty
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN batches b ON b.product_id = p.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY p.id, c.name
      ORDER BY ${order}`,
    [day, day, day, ...params]
  );
  return rows.map((row) => ({
    ...row,
    requires_rx: !!row.requires_rx,
    active: !!row.active,
    low_stock: row.stock <= row.min_stock,
    expiring_soon: !!row.next_expiry && row.next_expiry <= warnUntil
  }));
}

async function getProduct(ex, id) {
  const [p] = await queryProducts(ex, { where: ['p.id = ?'], params: [id] });
  if (!p) throw notFound('الصنف غير موجود');
  return p;
}

function catalogRoutes(db) {
  const router = express.Router();

  router.get('/categories', wrap(async (req, res) => {
    res.json(await db.all('SELECT id, name, sort_order FROM categories ORDER BY sort_order, name'));
  }));

  router.get('/products', wrap(async (req, res) => {
    const where = [];
    const params = [];
    // Only inventory roles may list deactivated products.
    if (!(req.query.include_inactive === '1' && req.user.role !== 'cashier')) where.push('p.active = 1');
    if (req.query.category_id) {
      where.push('p.category_id = ?');
      params.push(v.id(req.query.category_id, 'التصنيف'));
    }
    const q = v.str(req.query.q, 'البحث', { max: 100, optional: true });
    if (q) {
      where.push(`(p.brand_name LIKE ? ESCAPE '!' OR p.generic_name LIKE ? ESCAPE '!' OR p.barcode = ?)`);
      params.push(v.likePattern(q), v.likePattern(q), q);
    }
    res.json(await queryProducts(db, { where, params }));
  }));

  // Exact barcode lookup for scanners.
  router.get('/products/barcode/:code', wrap(async (req, res) => {
    const code = v.str(req.params.code, 'الباركود', { max: 50 });
    const [p] = await queryProducts(db, { where: ['p.barcode = ?', 'p.active = 1'], params: [code] });
    if (!p) throw notFound('لا يوجد صنف بهذا الباركود');
    res.json(p);
  }));

  return router;
}

module.exports = { catalogRoutes, queryProducts, getProduct };
