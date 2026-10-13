'use strict';
const express = require('express');
const { wrap } = require('../lib/http');
const v = require('../lib/validate');
const { forbidden } = require('../lib/errors');
const { requireRole } = require('../middleware/auth');
const { checkout } = require('../services/checkout');
const { createReturn } = require('../services/returns');
const { getSale } = require('../services/sales');

function salesRoutes(db) {
  const router = express.Router();

  router.post('/sales', wrap(async (req, res) => {
    res.status(201).json(await checkout(db, req.user, req.body));
  }));

  // Invoice history: search by invoice number and/or date range.
  router.get('/sales', requireRole('admin', 'pharmacist'), wrap(async (req, res) => {
    const where = [];
    const params = [];
    const q = v.str(req.query.q, 'رقم الفاتورة', { max: 30, optional: true });
    const from = v.date(req.query.from, 'من تاريخ', { optional: true });
    const to = v.date(req.query.to, 'إلى تاريخ', { optional: true });
    if (q) { where.push(`s.invoice_no LIKE ? ESCAPE '!'`); params.push(v.likePattern(q)); }
    if (from) { where.push('s.sold_at >= ?'); params.push(from + ' 00:00:00'); }
    if (to) { where.push('s.sold_at <= ?'); params.push(to + ' 23:59:59'); }
    const rows = await db.all(
      `SELECT s.id, s.invoice_no, s.sold_at, s.total, s.payment_method, c.name AS customer_name,
              u.full_name AS user_name,
              (SELECT COALESCE(SUM(r.refund_amount), 0) FROM sale_returns r WHERE r.sale_id = s.id) AS refunded_total
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         JOIN users u ON u.id = s.user_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY s.id DESC LIMIT 200`,
      params
    );
    res.json(rows);
  }));

  // Cashiers may only open (reprint) their own invoices.
  router.get('/sales/:id', wrap(async (req, res) => {
    const sale = await getSale(db, v.id(req.params.id, 'الفاتورة'));
    if (req.user.role === 'cashier' && sale.user_id !== req.user.id) throw forbidden();
    res.json(sale);
  }));

  router.post('/sales/:id/returns', requireRole('admin', 'pharmacist'), wrap(async (req, res) => {
    res.status(201).json(await createReturn(db, req.user, v.id(req.params.id, 'الفاتورة'), req.body));
  }));

  return router;
}

module.exports = { salesRoutes };
