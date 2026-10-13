'use strict';
const v = require('../lib/validate');
const { conflict, notFound } = require('../lib/errors');
const { now } = require('../lib/time');

// `ex` is the db or a transaction executor.
const getOpenShift = (ex, userId) =>
  ex.get('SELECT * FROM shifts WHERE user_id = ? AND closed_at IS NULL', [userId]);

// Totals for a shift. Expected cash in the drawer =
//   opening cash + cash sales − cash refunds + customer payments received in cash.
async function shiftSummary(ex, shift) {
  const sales = await ex.all(
    `SELECT payment_method, COUNT(*) AS cnt, COALESCE(SUM(total), 0) AS amount
       FROM sales WHERE shift_id = ? GROUP BY payment_method`,
    [shift.id]
  );
  const byMethod = { cash: 0, card: 0, debt: 0 };
  let salesCount = 0;
  for (const r of sales) { byMethod[r.payment_method] = r.amount; salesCount += r.cnt; }

  const refunds = await ex.get(
    `SELECT COALESCE(SUM(refund_amount), 0) AS amount FROM sale_returns
      WHERE shift_id = ? AND refund_method = 'cash'`,
    [shift.id]
  );
  const payments = await ex.get(
    `SELECT COALESCE(SUM(amount), 0) AS amount FROM customer_payments
      WHERE shift_id = ? AND method = 'cash'`,
    [shift.id]
  );
  const expected = shift.opening_cash + byMethod.cash - refunds.amount + payments.amount;
  return {
    id: shift.id,
    user_id: shift.user_id,
    opened_at: shift.opened_at,
    closed_at: shift.closed_at,
    opening_cash: shift.opening_cash,
    sales_count: salesCount,
    cash_sales: byMethod.cash,
    card_sales: byMethod.card,
    debt_sales: byMethod.debt,
    cash_refunds: refunds.amount,
    cash_customer_payments: payments.amount,
    expected_cash: shift.closed_at ? shift.expected_cash : expected,
    counted_cash: shift.counted_cash,
    difference: shift.difference,
    notes: shift.notes
  };
}

function openShift(db, user, body) {
  const openingCash = v.int((body || {}).opening_cash, 'المبلغ الافتتاحي', { min: 0, max: 1e10 });
  return db.transaction(async (tx) => {
    if (await getOpenShift(tx, user.id)) throw conflict('لديك وردية مفتوحة بالفعل');
    const r = await tx.run(
      'INSERT INTO shifts (user_id, opened_at, opening_cash) VALUES (?, ?, ?)',
      [user.id, now(), openingCash]
    );
    const shift = await tx.get('SELECT * FROM shifts WHERE id = ?', [r.lastId]);
    return shiftSummary(tx, shift);
  });
}

function closeShift(db, user, body) {
  body = body || {};
  const counted = v.int(body.counted_cash, 'النقد المعدود', { min: 0, max: 1e10 });
  const notes = v.str(body.notes, 'الملاحظات', { max: 500, optional: true });
  return db.transaction(async (tx) => {
    const shift = await getOpenShift(tx, user.id);
    if (!shift) throw notFound('لا توجد وردية مفتوحة');
    const summary = await shiftSummary(tx, shift);
    await tx.run(
      `UPDATE shifts SET closed_at = ?, expected_cash = ?, counted_cash = ?, difference = ?, notes = ?
        WHERE id = ?`,
      [now(), summary.expected_cash, counted, counted - summary.expected_cash, notes, shift.id]
    );
    return shiftSummary(tx, await tx.get('SELECT * FROM shifts WHERE id = ?', [shift.id]));
  });
}

module.exports = { getOpenShift, shiftSummary, openShift, closeShift };
