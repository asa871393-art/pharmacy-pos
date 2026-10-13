// Opening and closing the current user's cash shift.
import { api } from './api.js';
import { $, esc, money, fmtDateTime, openDialog, toast } from './ui.js';
import { ctx } from './state.js';

export async function refreshShift() {
  ctx.shift = await api('/shifts/current');
  const info = $('#shift-info');
  info.textContent = ctx.shift
    ? 'الوردية مفتوحة منذ ' + fmtDateTime(ctx.shift.opened_at)
    : 'لا توجد وردية مفتوحة';
  $('#shift-btn').textContent = ctx.shift ? 'إغلاق الوردية' : 'فتح وردية';
  return ctx.shift;
}

export async function openShiftDialog() {
  const ok = await openDialog({
    title: 'فتح وردية جديدة',
    submitLabel: 'فتح الوردية',
    body: `
      <p class="muted">أدخل مبلغ النقد الموجود في الدرج عند بداية الوردية.</p>
      <label class="field"><span>المبلغ الافتتاحي (د.ع)</span>
        <input name="opening_cash" type="number" min="0" step="250" required value="0" inputmode="numeric"></label>`,
    onOpen: (form) => form.opening_cash.select(),
    onSubmit: async (form) => {
      const value = form.opening_cash.value.trim();
      if (value === '' || Number(value) < 0) throw new Error('أدخل مبلغاً صحيحاً');
      await api('/shifts/open', { method: 'POST', body: { opening_cash: Number(value) } });
      return true;
    }
  });
  if (ok) {
    await refreshShift();
    toast('تم فتح الوردية', 'ok');
  }
  return !!ok;
}

function summaryRows(s) {
  return `
    <dt>بداية الوردية</dt><dd>${fmtDateTime(s.opened_at)}</dd>
    <dt>عدد الفواتير</dt><dd>${s.sales_count}</dd>
    <dt>المبلغ الافتتاحي</dt><dd>${money(s.opening_cash)}</dd>
    <dt>مبيعات نقدية</dt><dd>${money(s.cash_sales)}</dd>
    <dt>مبيعات بالبطاقة</dt><dd>${money(s.card_sales)}</dd>
    <dt>مبيعات آجلة</dt><dd>${money(s.debt_sales)}</dd>
    <dt>مرتجعات نقدية</dt><dd>${money(s.cash_refunds)}</dd>
    <dt>تسديدات ديون نقداً</dt><dd>${money(s.cash_customer_payments)}</dd>
    <dt class="total-row">النقد المتوقع في الدرج</dt><dd class="total-row">${money(s.expected_cash)}</dd>`;
}

export async function closeShiftDialog() {
  const s = await refreshShift();
  if (!s) return;
  const closed = await openDialog({
    title: 'إغلاق الوردية',
    submitLabel: 'إغلاق الوردية',
    body: `
      <dl class="kv">${summaryRows(s)}</dl>
      <label class="field"><span>النقد المعدود فعلياً (د.ع)</span>
        <input name="counted_cash" type="number" min="0" step="250" required inputmode="numeric"></label>
      <div class="hint" data-diff></div>
      <label class="field"><span>ملاحظات (اختياري)</span><textarea name="notes" maxlength="500"></textarea></label>`,
    onOpen: (form) => {
      const out = form.querySelector('[data-diff]');
      form.counted_cash.addEventListener('input', () => {
        const v = form.counted_cash.value;
        if (v === '') { out.textContent = ''; return; }
        const d = Number(v) - s.expected_cash;
        out.innerHTML = 'الفرق: <strong class="' + (d < 0 ? 'neg' : 'pos') + '">' + money(d) + '</strong>' +
          (d === 0 ? ' (مطابق)' : d < 0 ? ' (عجز)' : ' (زيادة)');
      });
      form.counted_cash.focus();
    },
    onSubmit: async (form) => {
      if (form.counted_cash.value === '') throw new Error('أدخل النقد المعدود');
      return api('/shifts/current/close', {
        method: 'POST',
        body: { counted_cash: Number(form.counted_cash.value), notes: form.notes.value }
      });
    }
  });
  if (!closed) return;
  await refreshShift();
  const d = closed.difference;
  await openDialog({
    title: 'تم إغلاق الوردية',
    noSubmit: true,
    cancelLabel: 'تم',
    body: `<dl class="kv">${summaryRows(closed)}
      <dt>النقد المعدود</dt><dd>${money(closed.counted_cash)}</dd>
      <dt>الفرق</dt><dd class="${d < 0 ? 'neg' : 'pos'}">${money(d)} ${d === 0 ? '(مطابق)' : d < 0 ? '(عجز)' : '(زيادة)'}</dd>
      ${closed.notes ? `<dt>ملاحظات</dt><dd>${esc(closed.notes)}</dd>` : ''}</dl>`
  });
}
