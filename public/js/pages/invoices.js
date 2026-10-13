// Invoice history: search by number or date range, view, reprint, and return items.
import { api } from '../api.js';
import { $, esc, money, int, ltr, fmtDate, fmtDateTime, toast, openDialog, todayIso, addDaysIso, PAY_LABELS } from '../ui.js';
import { ctx } from '../state.js';
import { printReceipt } from '../receipt.js';
import { refreshShift } from '../shift.js';

let root;

export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="page-head"><h1>الفواتير</h1></div>
    <form class="toolbar" data-search>
      <label class="field grow"><span>رقم الفاتورة</span><input name="q" dir="ltr" placeholder="2026-000123"></label>
      <label class="field"><span>من تاريخ</span><input name="from" type="date"></label>
      <label class="field"><span>إلى تاريخ</span><input name="to" type="date"></label>
      <button type="submit" class="btn-primary">بحث</button>
    </form>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>رقم الفاتورة</th><th>التاريخ</th><th>الزبون</th><th>البائع</th><th>الدفع</th><th>الإجمالي</th><th>المرتجع</th><th></th></tr></thead>
      <tbody data-rows></tbody>
    </table></div>
    <div class="empty-state" data-empty hidden>لا توجد فواتير مطابقة</div>`;
  const form = $('[data-search]', root);
  form.from.value = addDaysIso(todayIso(), -6);
  form.to.value = todayIso();
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  $('[data-rows]', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openInvoice(Number(b.dataset.open));
  });
}

export async function show() {
  await load();
}

async function load() {
  const f = $('[data-search]', root);
  try {
    // Searching by number ignores the date range.
    const q = f.q.value.trim();
    const rows = await api('/sales', { query: q ? { q } : { from: f.from.value, to: f.to.value } });
    $('[data-empty]', root).hidden = rows.length > 0;
    $('[data-rows]', root).innerHTML = rows.map((s) => `
      <tr>
        <td>${ltr(esc(s.invoice_no))}</td><td>${fmtDateTime(s.sold_at)}</td>
        <td>${esc(s.customer_name || '—')}</td><td>${esc(s.user_name)}</td>
        <td>${PAY_LABELS[s.payment_method]}</td><td>${money(s.total)}</td>
        <td>${s.refunded_total ? `<span class="tag warn">${money(s.refunded_total)}</span>` : '—'}</td>
        <td><button type="button" class="btn-sm" data-open="${s.id}">عرض</button></td>
      </tr>`).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function openInvoice(id) {
  let sale;
  try { sale = await api(`/sales/${id}`); } catch (err) { toast(err.message, 'error'); return; }
  const returnable = sale.items.some((i) => i.quantity > i.returned_qty);
  const rxById = Object.fromEntries(sale.prescriptions.map((p, i) => [p.id, i + 1]));
  let wantReturn = false;
  await openDialog({
    title: 'فاتورة رقم ' + sale.invoice_no,
    wide: true,
    noSubmit: true,
    cancelLabel: 'إغلاق',
    body: `
      <dl class="kv">
        <dt>التاريخ</dt><dd>${fmtDateTime(sale.sold_at)}</dd>
        <dt>البائع</dt><dd>${esc(sale.user_name)}</dd>
        <dt>الزبون</dt><dd>${esc(sale.customer_name || '—')}</dd>
        <dt>طريقة الدفع</dt><dd>${PAY_LABELS[sale.payment_method]}</dd>
      </dl>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>الصنف</th><th>الدفعة</th><th>الكمية</th><th>المرتجع</th><th>السعر</th><th>المبلغ</th><th>الوصفة</th></tr></thead>
        <tbody>${sale.items.map((i) => `<tr>
          <td>${esc(i.brand_name)}</td><td>${ltr(esc(i.batch_no))}</td><td>${int(i.quantity)}</td>
          <td>${i.returned_qty ? int(i.returned_qty) : '—'}</td><td>${money(i.unit_price)}</td><td>${money(i.line_total)}</td>
          <td>${i.prescription_id ? 'الوصفة ' + rxById[i.prescription_id] : '—'}</td></tr>`).join('')}</tbody>
        <tfoot>
          <tr><td colspan="5">المجموع</td><td colspan="2">${money(sale.subtotal)}</td></tr>
          ${sale.discount_amount ? `<tr><td colspan="5">الخصم (${ltr(sale.discount_pct + '%')})</td><td colspan="2">${money(sale.discount_amount)}</td></tr>` : ''}
          <tr><td colspan="5">الصافي</td><td colspan="2">${money(sale.total)}</td></tr>
          ${sale.refunded_total ? `<tr><td colspan="5">إجمالي المرتجع</td><td colspan="2" class="neg">${money(sale.refunded_total)}</td></tr>` : ''}
        </tfoot>
      </table></div>
      ${sale.prescriptions.length ? `<div class="card"><h2>الوصفات الطبية</h2>${sale.prescriptions.map((p, i) => `
        <p>الوصفة ${i + 1}: رقم ${ltr(esc(p.rx_number))} — د. ${esc(p.doctor_name)} — المريض: ${esc(p.patient_name)} — ${fmtDate(p.rx_date)}
        ${p.image_path ? ` — <a href="/api/prescriptions/${p.id}/image" target="_blank" rel="noopener">عرض الصورة</a>` : ''}</p>`).join('')}</div>` : ''}
      ${sale.returns.length ? `<div class="card"><h2>المرتجعات</h2>${sale.returns.map((r) => `
        <p>${fmtDateTime(r.returned_at)} — ${money(r.refund_amount)} (${PAY_LABELS[r.refund_method]}) — ${esc(r.user_name)}<br>
        <small class="muted">السبب: ${esc(r.reason)}</small></p>`).join('')}</div>` : ''}
      <div class="toolbar">
        <button type="button" class="btn-ghost" data-reprint>إعادة طباعة</button>
        ${returnable ? '<button type="button" class="btn-danger" data-return>إرجاع أصناف</button>' : ''}
      </div>`,
    onOpen: (form, dlg) => {
      form.querySelector('[data-reprint]').addEventListener('click', () => printReceipt(sale, ctx.settings.pharmacy_name));
      const r = form.querySelector('[data-return]');
      if (r) r.addEventListener('click', () => { wantReturn = true; dlg.close(); });
    }
  });
  // The detail dialog closes before the return form opens, so the two never stack.
  if (wantReturn) await returnDialog(sale);
}

async function returnDialog(sale) {
  const lines = sale.items.filter((i) => i.quantity > i.returned_qty);
  const ratio = sale.subtotal ? sale.total / sale.subtotal : 0;
  const done = await openDialog({
    title: 'إرجاع من الفاتورة ' + sale.invoice_no,
    submitLabel: 'تأكيد الإرجاع',
    danger: true,
    wide: true,
    body: `
      <p class="muted">تعود الكمية المرتجعة إلى نفس الدفعة التي بيعت منها. يُسترد المبلغ بنفس طريقة الدفع (${PAY_LABELS[sale.payment_method]}).</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>الصنف</th><th>الدفعة</th><th>المتبقي</th><th>كمية الإرجاع</th></tr></thead>
        <tbody>${lines.map((i) => `<tr>
          <td>${esc(i.brand_name)}</td><td>${ltr(esc(i.batch_no))}</td><td>${int(i.quantity - i.returned_qty)}</td>
          <td><input class="input" style="width:100px" type="number" min="0" max="${i.quantity - i.returned_qty}" step="1" value="0"
              data-line="${i.id}" data-price="${i.unit_price}" aria-label="كمية الإرجاع"></td></tr>`).join('')}</tbody>
      </table></div>
      <div class="hint" data-refund></div>
      <label class="field"><span>سبب الإرجاع (مطلوب)</span><textarea name="reason" required maxlength="500"></textarea></label>`,
    onOpen: (form) => {
      const update = () => {
        const gross = [...form.querySelectorAll('[data-line]')].reduce((a, i) => a + (Number(i.value) || 0) * Number(i.dataset.price), 0);
        form.querySelector('[data-refund]').innerHTML = gross ? `المبلغ المسترد التقريبي: <strong>${money(Math.round(gross * ratio))}</strong>` : '';
      };
      form.addEventListener('input', update);
    },
    onSubmit: async (form) => {
      const items = [...form.querySelectorAll('[data-line]')]
        .map((i) => ({ sale_item_id: Number(i.dataset.line), quantity: Number(i.value), max: Number(i.max) }))
        .filter((i) => i.quantity);
      if (!items.length) throw new Error('حدد كمية صنف واحد على الأقل');
      for (const i of items) {
        if (!Number.isInteger(i.quantity) || i.quantity < 0 || i.quantity > i.max) throw new Error('كمية الإرجاع غير صحيحة');
      }
      if (!form.reason.value.trim()) throw new Error('اكتب سبب الإرجاع');
      return api(`/sales/${sale.id}/returns`, {
        method: 'POST',
        body: { reason: form.reason.value, items: items.map(({ sale_item_id, quantity }) => ({ sale_item_id, quantity })) }
      });
    }
  });
  if (done) {
    toast('تم تسجيل الإرجاع', 'ok');
    await refreshShift();
    await load();
    await openInvoice(sale.id);
  }
}
