// Shared UI helpers: escaping, number/date formatting for RTL, dialogs, toasts, CSV export.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Left-to-right isolate, so numbers, invoice numbers and dates keep their order inside Arabic text.
export const ltr = (s) => '⁦' + s + '⁩';
export const CURRENCY = 'د.ع';
export const int = (n) => ltr(Number(n || 0).toLocaleString('en-US'));
export const money = (n) => int(n) + ' ' + CURRENCY;

// 'YYYY-MM-DD' -> 'DD/MM/YYYY'; 'YYYY-MM-DD HH:MM:SS' -> 'DD/MM/YYYY HH:MM'.
export function fmtDate(s) {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-');
  return ltr(`${d}/${m}/${y}`);
}
export function fmtDateTime(s) {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-');
  return ltr(`${d}/${m}/${y} ${s.slice(11, 16)}`);
}
export const fmtMonth = (s) => (s ? ltr(`${s.slice(5, 7)}/${s.slice(0, 4)}`) : '');

// Today in local time as YYYY-MM-DD (for date inputs).
export function todayIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const PAY_LABELS = { cash: 'نقداً', card: 'بطاقة', debt: 'آجل' };
export const ROLE_LABELS = { admin: 'مدير', pharmacist: 'صيدلاني', cashier: 'كاشير' };

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

// Modal dialog. onSubmit(form, dialog) may throw to show an error and keep the dialog open;
// its return value resolves the promise. Resolves null when cancelled.
export function openDialog({ title, body, submitLabel = 'حفظ', cancelLabel = 'إلغاء', wide = false,
  onSubmit, onOpen, danger = false, noSubmit = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg' + (wide ? ' wide' : '');
    const titleId = 'dlg-' + Math.random().toString(36).slice(2);
    dlg.setAttribute('aria-labelledby', titleId);
    dlg.innerHTML = `
      <form class="dlg-form" novalidate>
        <div class="dlg-head"><h2 id="${titleId}">${esc(title)}</h2>
          <button type="button" class="dlg-x" data-cancel aria-label="إغلاق">×</button></div>
        <div class="dlg-body">${body}<div class="form-error" data-error role="alert" hidden></div></div>
        <div class="dlg-foot">
          ${noSubmit ? '' : `<button type="submit" class="${danger ? 'btn-danger' : 'btn-primary'}">${esc(submitLabel)}</button>`}
          <button type="button" class="btn-ghost" data-cancel>${esc(cancelLabel)}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const errBox = dlg.querySelector('[data-error]');
    let result = null;
    const close = () => dlg.close();
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', close));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const btn = form.querySelector('[type=submit]');
      if (btn) btn.disabled = true;
      try {
        result = onSubmit ? await onSubmit(form, dlg) : true;
        if (result !== undefined && result !== false) close();
        else result = null;
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    dlg.showModal();
    if (onOpen) onOpen(form, dlg);
  });
}

export const confirmDialog = (title, message, label = 'تأكيد', danger = true) =>
  openDialog({ title, body: `<p>${esc(message)}</p>`, submitLabel: label, danger });

export const formData = (form) => Object.fromEntries(new FormData(form).entries());

// CSV with a BOM so Excel opens Arabic text correctly.
export function downloadCsv(filename, headers, rows) {
  const cell = (v) => {
    const s = String(v ?? '').replace(/[⁦-⁩]/g, '');
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function setTabs(root, onChange) {
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[role=tab]');
    if (!t) return;
    $$('[role=tab]', root).forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    onChange(t.dataset.tab);
  });
}
