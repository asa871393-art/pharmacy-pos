'use strict';
const express = require('express');
const { wrap } = require('../lib/http');
const v = require('../lib/validate');
const { badRequest, conflict, notFound } = require('../lib/errors');
const { now } = require('../lib/time');
const { getOpenShift } = require('../services/shifts');

const PHONE_RE = /^\+?[0-9 ]{7,20}$/;

function customerRoutes(db) {
  const router = express.Router();

  router.get('/customers', wrap(async (req, res) => {
    const q = v.str(req.query.q, 'البحث', { max: 100, optional: true });
    const rows = q
      ? await db.all(
        `SELECT id, name, phone, balance FROM customers
          WHERE name LIKE ? ESCAPE '!' OR phone LIKE ? ESCAPE '!'
          ORDER BY name LIMIT 20`,
        [v.likePattern(q), v.likePattern(q)]
      )
      : await db.all('SELECT id, name, phone, balance FROM customers ORDER BY name LIMIT 20');
    res.json(rows);
  }));

  router.get('/customers/:id', wrap(async (req, res) => {
    const c = await db.get('SELECT id, name, phone, balance, created_at FROM customers WHERE id = ?',
      [v.id(req.params.id, 'الزبون')]);
    if (!c) throw notFound('الزبون غير موجود');
    res.json(c);
  }));

  router.post('/customers', wrap(async (req, res) => {
    const body = req.body || {};
    const name = v.str(body.name, 'اسم الزبون', { max: 150 });
    const phone = v.str(body.phone, 'رقم الهاتف', { max: 30, optional: true });
    if (phone && !PHONE_RE.test(phone)) throw badRequest('رقم الهاتف غير صالح');
    const id = await db.transaction(async (tx) => {
      if (phone && await tx.get('SELECT id FROM customers WHERE phone = ?', [phone])) {
        throw conflict('رقم الهاتف مسجل لزبون آخر');
      }
      const r = await tx.run('INSERT INTO customers (name, phone, balance, created_at) VALUES (?, ?, 0, ?)',
        [name, phone, now()]);
      return r.lastId;
    });
    res.status(201).json(await db.get('SELECT id, name, phone, balance FROM customers WHERE id = ?', [id]));
  }));

  // Debt repayment. Cash payments count toward the receiving user's open shift.
  router.post('/customers/:id/payments', wrap(async (req, res) => {
    const customerId = v.id(req.params.id, 'الزبون');
    const body = req.body || {};
    const amount = v.int(body.amount, 'المبلغ', { min: 1, max: 1e10 });
    const method = v.oneOf(body.method || 'cash', 'طريقة الدفع', ['cash', 'card']);
    const note = v.str(body.note, 'الملاحظة', { max: 250, optional: true });
    const result = await db.transaction(async (tx) => {
      const c = await tx.get('SELECT id, balance FROM customers WHERE id = ?', [customerId]);
      if (!c) throw notFound('الزبون غير موجود');
      if (amount > c.balance) throw badRequest(`المبلغ أكبر من الدين المستحق (${c.balance})`);
      const shift = await getOpenShift(tx, req.user.id);
      if (method === 'cash' && !shift) throw conflict('استلام النقد يتطلب وردية مفتوحة');
      await tx.run(
        `INSERT INTO customer_payments (customer_id, amount, method, shift_id, paid_at, user_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [customerId, amount, method, shift ? shift.id : null, now(), req.user.id, note]
      );
      await tx.run('UPDATE customers SET balance = balance - ? WHERE id = ?', [amount, customerId]);
      return tx.get('SELECT id, name, phone, balance FROM customers WHERE id = ?', [customerId]);
    });
    res.status(201).json(result);
  }));

  return router;
}

module.exports = { customerRoutes };
