'use strict';
const v = require('../lib/validate');
const { badRequest, conflict } = require('../lib/errors');
const { now, today } = require('../lib/time');
const { getSettings } = require('../lib/settings');
const { getOpenShift } = require('./shifts');
const { getSale, nextInvoiceNo } = require('./sales');

const PAYMENT_METHODS = ['cash', 'card', 'debt'];

// Shape/type checks only; anything that needs the database happens in the transaction.
// Prices and costs from the client are ignored: they always come from the database.
function parseCheckout(body) {
  body = body || {};
  const prescriptions = v.array(body.prescriptions || [], 'الوصفات', { max: 20 }).map((p, i) => {
    const label = `الوصفة ${i + 1}`;
    p = p || {};
    const rx = {
      ref: v.str(p.ref, `${label} - المعرّف`, { max: 20 }),
      rx_number: v.str(p.rx_number, `${label} - رقم الوصفة`, { max: 50 }),
      doctor_name: v.str(p.doctor_name, `${label} - اسم الطبيب`, { max: 150 }),
      patient_name: v.str(p.patient_name, `${label} - اسم المريض`, { max: 150 }),
      rx_date: v.date(p.rx_date, `${label} - تاريخ الوصفة`)
    };
    if (rx.rx_date > today()) throw badRequest(`${label}: تاريخ الوصفة في المستقبل`);
    return rx;
  });
  const refs = new Set();
  for (const p of prescriptions) {
    if (refs.has(p.ref)) throw badRequest('معرّف الوصفة مكرر');
    refs.add(p.ref);
  }

  const seen = new Set();
  const usedRefs = new Set();
  const items = v.array(body.items, 'أصناف الفاتورة', { min: 1, max: 200 }).map((it, i) => {
    it = it || {};
    const label = `السطر ${i + 1}`;
    const item = {
      product_id: v.id(it.product_id, `${label} - الصنف`),
      quantity: v.int(it.quantity, `${label} - الكمية`, { min: 1, max: 100000 }),
      prescription_ref: v.str(it.prescription_ref, `${label} - الوصفة`, { max: 20, optional: true })
    };
    if (seen.has(item.product_id)) throw badRequest('الصنف مكرر في الفاتورة');
    seen.add(item.product_id);
    if (item.prescription_ref) {
      if (!refs.has(item.prescription_ref)) throw badRequest(`${label}: الوصفة المحددة غير موجودة`);
      usedRefs.add(item.prescription_ref);
    }
    return item;
  });
  for (const ref of refs) {
    if (!usedRefs.has(ref)) throw badRequest('توجد وصفة غير مرتبطة بأي صنف');
  }

  return {
    items,
    prescriptions,
    customer_id: body.customer_id == null || body.customer_id === '' ? null : v.id(body.customer_id, 'الزبون'),
    discount_pct: v.num(body.discount_pct == null ? 0 : body.discount_pct, 'الخصم', { min: 0, max: 100 }),
    payment_method: v.oneOf(body.payment_method, 'طريقة الدفع', PAYMENT_METHODS)
  };
}

// Creates the invoice in a single transaction: lines taken from batches earliest-expiry-first
// (FEFO), batch quantities deducted, stock movements logged, customer balance updated for debt
// sales. Any failure rolls back everything.
async function checkout(db, user, body) {
  const input = parseCheckout(body);

  const saleId = await db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    if (input.discount_pct > settings.max_discount_pct) {
      throw badRequest(`الخصم يتجاوز الحد المسموح (${settings.max_discount_pct}%)`);
    }
    const shift = await getOpenShift(tx, user.id);
    if (!shift) throw conflict('يجب فتح وردية قبل البيع');

    let customer = null;
    if (input.customer_id) {
      customer = await tx.get('SELECT id FROM customers WHERE id = ?', [input.customer_id]);
      if (!customer) throw badRequest('الزبون غير موجود');
    }
    if (input.payment_method === 'debt' && !customer) {
      throw badRequest('البيع الآجل يتطلب اختيار زبون');
    }

    const day = today();
    const ts = now();
    const lines = [];
    for (const item of input.items) {
      const p = await tx.get(
        'SELECT id, brand_name, sale_price, requires_rx, active FROM products WHERE id = ?',
        [item.product_id]
      );
      if (!p || !p.active) throw badRequest(`الصنف رقم ${item.product_id} غير موجود أو غير فعّال`);
      if (p.requires_rx && !item.prescription_ref) {
        throw badRequest(`«${p.brand_name}» يُصرف بوصفة طبية. أدخل بيانات الوصفة أولاً`);
      }
      // Non-expired batches with stock, earliest expiry first.
      const batches = await tx.all(
        `SELECT id, quantity, unit_cost FROM batches
          WHERE product_id = ? AND quantity > 0 AND expiry_date >= ?
          ORDER BY expiry_date, id`,
        [p.id, day]
      );
      const available = batches.reduce((a, b) => a + b.quantity, 0);
      if (available < item.quantity) {
        throw conflict(`الكمية المطلوبة من «${p.brand_name}» غير متوفرة. المتوفر: ${available}`);
      }
      let need = item.quantity;
      const takes = [];
      for (const b of batches) {
        if (need === 0) break;
        const qty = Math.min(need, b.quantity);
        takes.push({ batch_id: b.id, quantity: qty, unit_cost: b.unit_cost });
        need -= qty;
      }
      lines.push({ product: p, item, takes });
    }

    const subtotal = lines.reduce((a, l) => a + l.product.sale_price * l.item.quantity, 0);
    const discountAmount = Math.round((subtotal * input.discount_pct) / 100);
    const total = subtotal - discountAmount;
    const invoiceNo = await nextInvoiceNo(tx, day.slice(0, 4));

    const sale = await tx.run(
      `INSERT INTO sales (invoice_no, sold_at, customer_id, subtotal, discount_pct, discount_amount,
                          total, payment_method, shift_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceNo, ts, input.customer_id, subtotal, input.discount_pct, discountAmount, total,
        input.payment_method, shift.id, user.id]
    );

    const rxIds = new Map();
    for (const rx of input.prescriptions) {
      const r = await tx.run(
        `INSERT INTO prescriptions (sale_id, rx_number, doctor_name, patient_name, rx_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [sale.lastId, rx.rx_number, rx.doctor_name, rx.patient_name, rx.rx_date, ts]
      );
      rxIds.set(rx.ref, r.lastId);
    }

    for (const { product, item, takes } of lines) {
      for (const t of takes) {
        await tx.run(
          `INSERT INTO sale_items (sale_id, product_id, batch_id, prescription_id, quantity,
                                   unit_price, unit_cost, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [sale.lastId, product.id, t.batch_id, rxIds.get(item.prescription_ref) || null, t.quantity,
            product.sale_price, t.unit_cost, product.sale_price * t.quantity]
        );
        // The quantity guard makes the update fail rather than go negative.
        const upd = await tx.run(
          'UPDATE batches SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
          [t.quantity, t.batch_id, t.quantity]
        );
        if (upd.changes !== 1) throw conflict(`تغيّر مخزون «${product.brand_name}»، أعد المحاولة`);
        await tx.run(
          `INSERT INTO stock_movements (product_id, batch_id, movement_type, qty_change, reason,
                                        ref_id, user_id, created_at)
           VALUES (?, ?, 'sale', ?, ?, ?, ?, ?)`,
          [product.id, t.batch_id, -t.quantity, `فاتورة بيع ${invoiceNo}`, sale.lastId, user.id, ts]
        );
      }
    }

    if (input.payment_method === 'debt') {
      await tx.run('UPDATE customers SET balance = balance + ? WHERE id = ?', [total, customer.id]);
    }
    return sale.lastId;
  });

  return getSale(db, saleId);
}

module.exports = { checkout, parseCheckout, PAYMENT_METHODS };
