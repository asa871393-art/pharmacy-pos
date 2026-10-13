// 80mm thermal receipt. Renders a sale into #receipt and opens the print dialog.
import { $, esc, money, int, fmtDateTime, ltr, PAY_LABELS } from './ui.js';

export function printReceipt(sale, pharmacyName) {
  // Lines are stored per batch; group them back by product for the receipt.
  const byProduct = new Map();
  for (const it of sale.items) {
    const g = byProduct.get(it.product_id) || { name: it.brand_name, price: it.unit_price, qty: 0, returned: 0 };
    g.qty += it.quantity;
    g.returned += it.returned_qty;
    byProduct.set(it.product_id, g);
  }
  const lines = [...byProduct.values()].map((g) => `
    <tr><td colspan="2">${esc(g.name)}</td></tr>
    <tr class="sub"><td>${int(g.qty)} × ${money(g.price)}${g.returned ? ` (مرتجع ${int(g.returned)})` : ''}</td>
        <td class="amt">${money(g.qty * g.price)}</td></tr>`).join('');

  $('#receipt').innerHTML = `
    <h1>${esc(pharmacyName)}</h1>
    <div class="c">فاتورة بيع</div>
    <hr>
    <div>رقم الفاتورة: ${ltr(esc(sale.invoice_no))}</div>
    <div>التاريخ: ${fmtDateTime(sale.sold_at)}</div>
    <div>البائع: ${esc(sale.user_name)}</div>
    ${sale.customer_name ? `<div>الزبون: ${esc(sale.customer_name)}</div>` : ''}
    <hr>
    <table>${lines}</table>
    <hr>
    <table>
      <tr><td>المجموع</td><td class="amt">${money(sale.subtotal)}</td></tr>
      ${sale.discount_amount ? `<tr><td>الخصم (${ltr(sale.discount_pct + '%')})</td><td class="amt">${money(sale.discount_amount)}</td></tr>` : ''}
      <tr class="tot"><td>الصافي</td><td class="amt">${money(sale.total)}</td></tr>
      <tr><td>طريقة الدفع</td><td class="amt">${PAY_LABELS[sale.payment_method]}</td></tr>
      ${sale.refunded_total ? `<tr><td>المبلغ المرتجع</td><td class="amt">${money(sale.refunded_total)}</td></tr>` : ''}
    </table>
    ${sale.prescriptions.length ? `<hr><div>صُرف بموجب ${int(sale.prescriptions.length)} وصفة طبية</div>` : ''}
    <hr>
    <div class="c">شكراً لزيارتكم — نتمنى لكم الشفاء العاجل</div>`;
  window.print();
}
