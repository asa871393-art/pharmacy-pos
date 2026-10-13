'use strict';
const { notFound } = require('../lib/errors');

// Full invoice: header, lines (one per batch taken), prescriptions and returns.
async function getSale(ex, id) {
  const sale = await ex.get(
    `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, u.full_name AS user_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    [id]
  );
  if (!sale) throw notFound('الفاتورة غير موجودة');
  sale.discount_pct = Number(sale.discount_pct);
  sale.items = await ex.all(
    `SELECT si.id, si.product_id, si.batch_id, si.prescription_id, si.quantity, si.unit_price,
            si.line_total, si.returned_qty, p.brand_name, p.generic_name, b.batch_no, b.expiry_date
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       JOIN batches b ON b.id = si.batch_id
      WHERE si.sale_id = ?
      ORDER BY si.id`,
    [id]
  );
  sale.prescriptions = await ex.all(
    `SELECT id, rx_number, doctor_name, patient_name, rx_date, image_path
       FROM prescriptions WHERE sale_id = ? ORDER BY id`,
    [id]
  );
  sale.returns = await ex.all(
    `SELECT r.id, r.returned_at, r.reason, r.refund_amount, r.refund_method, u.full_name AS user_name
       FROM sale_returns r JOIN users u ON u.id = r.user_id
      WHERE r.sale_id = ? ORDER BY r.id`,
    [id]
  );
  sale.refunded_total = sale.returns.reduce((a, r) => a + r.refund_amount, 0);
  return sale;
}

// Next invoice number for the year, e.g. "2026-000123". The UPDATE row-locks the counter,
// so this stays correct under concurrent transactions on MySQL as well.
async function nextInvoiceNo(tx, year) {
  const name = 'invoice_' + year;
  const r = await tx.run('UPDATE sequences SET value = value + 1 WHERE name = ?', [name]);
  if (r.changes === 0) await tx.run('INSERT INTO sequences (name, value) VALUES (?, 1)', [name]);
  const row = await tx.get('SELECT value FROM sequences WHERE name = ?', [name]);
  return `${year}-${String(row.value).padStart(6, '0')}`;
}

module.exports = { getSale, nextInvoiceNo };
