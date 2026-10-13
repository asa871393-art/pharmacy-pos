'use strict';
const v = require('../lib/validate');
const { badRequest, conflict, notFound } = require('../lib/errors');
const { now } = require('../lib/time');
const { getOpenShift } = require('./shifts');
const { getSale } = require('./sales');

function parseReturn(body) {
  body = body || {};
  const seen = new Set();
  const items = v.array(body.items, 'الأصناف المرتجعة', { min: 1, max: 200 }).map((it, i) => {
    it = it || {};
    const item = {
      sale_item_id: v.id(it.sale_item_id, `السطر ${i + 1} - الصنف`),
      quantity: v.int(it.quantity, `السطر ${i + 1} - الكمية`, { min: 1, max: 100000 })
    };
    if (seen.has(item.sale_item_id)) throw badRequest('الصنف مكرر في المرتجع');
    seen.add(item.sale_item_id);
    return item;
  });
  return { items, reason: v.str(body.reason, 'سبب الإرجاع', { max: 500 }) };
}

// Returns items from a sale in one transaction. Quantities go back to the same batch they were
// sold from. The refund keeps the invoice's discount ratio and is paid the same way as the sale:
// cash (from the refunding user's open shift), card, or deducted from the customer's debt.
async function createReturn(db, user, saleId, body) {
  const input = parseReturn(body);

  await db.transaction(async (tx) => {
    const sale = await tx.get('SELECT * FROM sales WHERE id = ?', [saleId]);
    if (!sale) throw notFound('الفاتورة غير موجودة');

    const saleItems = await tx.all('SELECT * FROM sale_items WHERE sale_id = ?', [saleId]);
    const byId = new Map(saleItems.map((si) => [si.id, si]));

    const lines = input.items.map((it) => {
      const si = byId.get(it.sale_item_id);
      if (!si) throw badRequest('الصنف المرتجع لا ينتمي إلى هذه الفاتورة');
      const left = si.quantity - si.returned_qty;
      if (it.quantity > left) throw conflict(`لا يمكن إرجاع أكثر من الكمية المتبقية (${left})`);
      const gross = si.unit_price * it.quantity;
      const refund = sale.subtotal > 0 ? Math.round((gross * sale.total) / sale.subtotal) : 0;
      return { si, quantity: it.quantity, refund };
    });

    // Never refund more than was paid. When this return empties the invoice, the last line
    // absorbs rounding so the refunds add up exactly to the invoice total.
    const prev = await tx.get(
      'SELECT COALESCE(SUM(refund_amount), 0) AS amount FROM sale_returns WHERE sale_id = ?',
      [saleId]
    );
    const remaining = sale.total - prev.amount;
    const returnedNow = new Map(lines.map((l) => [l.si.id, l.quantity]));
    const fullyReturned = saleItems.every(
      (si) => si.quantity - si.returned_qty === (returnedNow.get(si.id) || 0)
    );
    let refundTotal = lines.reduce((a, l) => a + l.refund, 0);
    const target = fullyReturned ? remaining : Math.min(refundTotal, remaining);
    if (target !== refundTotal) {
      const last = lines[lines.length - 1];
      last.refund = Math.max(0, last.refund + (target - refundTotal));
      refundTotal = lines.reduce((a, l) => a + l.refund, 0);
    }

    let shiftId = null;
    const shift = await getOpenShift(tx, user.id);
    if (sale.payment_method === 'cash' && !shift) {
      throw conflict('الإرجاع النقدي يتطلب وردية مفتوحة');
    }
    if (shift) shiftId = shift.id;

    const ts = now();
    const ret = await tx.run(
      `INSERT INTO sale_returns (sale_id, returned_at, reason, refund_amount, refund_method, shift_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [saleId, ts, input.reason, refundTotal, sale.payment_method, shiftId, user.id]
    );

    for (const { si, quantity, refund } of lines) {
      await tx.run(
        'INSERT INTO sale_return_items (return_id, sale_item_id, quantity, refund_amount) VALUES (?, ?, ?, ?)',
        [ret.lastId, si.id, quantity, refund]
      );
      const upd = await tx.run(
        'UPDATE sale_items SET returned_qty = returned_qty + ? WHERE id = ? AND returned_qty + ? <= quantity',
        [quantity, si.id, quantity]
      );
      if (upd.changes !== 1) throw conflict('تغيّرت الكمية المرتجعة، أعد المحاولة');
      await tx.run('UPDATE batches SET quantity = quantity + ? WHERE id = ?', [quantity, si.batch_id]);
      await tx.run(
        `INSERT INTO stock_movements (product_id, batch_id, movement_type, qty_change, reason,
                                      ref_id, user_id, created_at)
         VALUES (?, ?, 'return', ?, ?, ?, ?, ?)`,
        [si.product_id, si.batch_id, quantity, `إرجاع من فاتورة ${sale.invoice_no}: ${input.reason}`,
          ret.lastId, user.id, ts]
      );
    }

    if (sale.payment_method === 'debt' && sale.customer_id) {
      await tx.run('UPDATE customers SET balance = balance - ? WHERE id = ?', [refundTotal, sale.customer_id]);
    }
  });

  return getSale(db, saleId);
}

module.exports = { createReturn, parseReturn };
