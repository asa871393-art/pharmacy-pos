// Inventory: product table with filters, add/edit/deactivate, batches, manual adjustments, alerts.
import { api } from '../api.js';
import {
  $, $$, esc, money, int, ltr, fmtDate, fmtDateTime, toast, openDialog, debounce, MOVEMENT_LABELS, signed
} from '../ui.js';

const DOSAGE_FORMS = ['أقراص', 'كبسول', 'أقراص فوارة', 'شراب', 'معلق', 'بخاخ', 'حقن', 'مرهم', 'كريم', 'قطرة', 'تحاميل', 'محلول'];
const STATUS = {
  all: 'كل الأصناف', low: 'مخزون منخفض', out: 'نفد من المخزون', expiring: 'ينتهي قريباً',
  expired: 'لديه دفعات منتهية', inactive: 'غير فعّال'
};
const state = { products: [], cats: [], alerts: null, q: '', cat: '', status: 'all' };
let root;

export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="page-head">
      <h1>المخزون</h1>
      <div class="toolbar">
        <button type="button" class="btn-ghost" data-cats>التصنيفات</button>
        <button type="button" class="btn-primary" data-new>+ إضافة صنف</button>
      </div>
    </div>
    <div class="stats" data-stats></div>
    <div class="toolbar">
      <label class="field grow"><span>بحث</span>
        <input type="search" data-q placeholder="الاسم التجاري أو العلمي أو الباركود"></label>
      <label class="field"><span>التصنيف</span><select data-cat></select></label>
      <label class="field"><span>الحالة</span>
        <select data-status>${Object.entries(STATUS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th>الصنف</th><th>الشكل</th><th>الباركود</th><th>التصنيف</th><th>سعر البيع</th>
          <th>المخزون</th><th>أقرب انتهاء</th><th>الحالة</th><th>إجراءات</th>
        </tr></thead>
        <tbody data-rows></tbody>
      </table>
    </div>
    <div class="empty-state" data-empty hidden>لا توجد أصناف مطابقة</div>`;

  $('[data-q]', root).addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); render(); }, 150));
  $('[data-cat]', root).addEventListener('change', (e) => { state.cat = e.target.value; render(); });
  $('[data-status]', root).addEventListener('change', (e) => { state.status = e.target.value; render(); });
  $('[data-new]', root).addEventListener('click', () => productDialog(null));
  $('[data-cats]', root).addEventListener('click', categoriesDialog);
  $('[data-stats]', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.status = b.dataset.filter;
    $('[data-status]', root).value = state.status;
    render();
  });
  $('[data-rows]', root).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const p = state.products.find((x) => x.id === Number(b.dataset.id));
    if (b.dataset.act === 'edit') productDialog(p);
    if (b.dataset.act === 'batches') batchesDialog(p);
    if (b.dataset.act === 'toggle') toggleActive(p);
  });
}

export async function show() {
  await load();
}

async function load() {
  const [products, cats, alerts] = await Promise.all([
    api('/products', { query: { include_inactive: 1 } }),
    api('/categories'),
    api('/inventory/alerts')
  ]);
  Object.assign(state, { products, cats, alerts });
  const catSel = $('[data-cat]', root);
  catSel.innerHTML = '<option value="">الكل</option>' +
    cats.map((c) => `<option value="${c.id}" ${String(c.id) === state.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  renderStats();
  render();
}

function renderStats() {
  const a = state.alerts;
  $('[data-stats]', root).innerHTML = `
    <button type="button" class="stat warn" data-filter="low"><span>مخزون منخفض</span><strong>${int(a.low_stock.length)}</strong></button>
    <button type="button" class="stat danger" data-filter="out"><span>نفد من المخزون</span><strong>${int(a.out_of_stock.length)}</strong></button>
    <button type="button" class="stat warn" data-filter="expiring"><span>دفعات تنتهي خلال ${int(a.expiry_warn_days)} يوماً</span><strong>${int(a.expiring.length)}</strong></button>
    <button type="button" class="stat danger" data-filter="expired"><span>دفعات منتهية الصلاحية</span><strong>${int(a.expired.length)}</strong></button>`;
}

function matches(p) {
  const q = state.q.toLowerCase();
  if (q && !(p.brand_name.toLowerCase().includes(q) || p.generic_name.toLowerCase().includes(q) || (p.barcode || '') === state.q)) return false;
  if (state.cat && String(p.category_id) !== state.cat) return false;
  switch (state.status) {
    case 'low': return p.active && p.stock > 0 && p.low_stock;
    case 'out': return p.active && p.stock === 0;
    case 'expiring': return p.active && p.expiring_soon;
    case 'expired': return p.expired_qty > 0;
    case 'inactive': return !p.active;
    default: return true;
  }
}

function stockTag(p) {
  if (p.stock === 0) return `<span class="tag danger">نفد</span>`;
  if (p.low_stock) return `<span class="tag warn">${int(p.stock)} منخفض</span>`;
  return `<span class="tag ok">${int(p.stock)}</span>`;
}

function render() {
  const list = state.products.filter(matches);
  $('[data-empty]', root).hidden = list.length > 0;
  $('[data-rows]', root).innerHTML = list.map((p) => `
    <tr class="${p.active ? '' : 'inactive'}">
      <td class="wrap"><strong>${esc(p.brand_name)}</strong> ${p.requires_rx ? '<span class="tag rx">وصفة</span>' : ''}<br>
        <small class="muted">${esc(p.generic_name)}</small></td>
      <td>${esc([p.dosage_form, p.pack_size].filter(Boolean).join(' · '))}</td>
      <td>${p.barcode ? ltr(esc(p.barcode)) : '—'}</td>
      <td>${esc(p.category_name || '—')}</td>
      <td>${money(p.sale_price)}</td>
      <td>${stockTag(p)} ${p.expired_qty ? `<span class="tag danger" title="كمية في دفعات منتهية">منتهي: ${int(p.expired_qty)}</span>` : ''}</td>
      <td>${p.next_expiry ? `<span class="${p.expiring_soon ? 'tag warn' : ''}">${fmtDate(p.next_expiry)}</span>` : '—'}</td>
      <td>${p.active ? '<span class="tag ok">فعّال</span>' : '<span class="tag">معطّل</span>'}</td>
      <td><div class="actions">
        <button type="button" class="btn-sm" data-act="edit" data-id="${p.id}">تعديل</button>
        <button type="button" class="btn-sm" data-act="batches" data-id="${p.id}">الدفعات</button>
        <button type="button" class="btn-sm ${p.active ? 'danger' : ''}" data-act="toggle" data-id="${p.id}">${p.active ? 'تعطيل' : 'تفعيل'}</button>
      </div></td>
    </tr>`).join('');
}

async function productDialog(p) {
  const val = (k, d = '') => esc(p ? (p[k] ?? d) : d);
  const saved = await openDialog({
    title: p ? 'تعديل صنف' : 'إضافة صنف جديد',
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>الاسم التجاري</span><input name="brand_name" required maxlength="150" value="${val('brand_name')}"></label>
        <label class="field"><span>الاسم العلمي</span><input name="generic_name" required maxlength="150" value="${val('generic_name')}"></label>
        <label class="field"><span>الشكل الدوائي</span><input name="dosage_form" required maxlength="50" list="dosage-forms" value="${val('dosage_form')}">
          <datalist id="dosage-forms">${DOSAGE_FORMS.map((f) => `<option value="${f}">`).join('')}</datalist></label>
        <label class="field"><span>حجم العبوة</span><input name="pack_size" maxlength="50" placeholder="مثال: 24 قرص" value="${val('pack_size')}"></label>
        <label class="field"><span>الباركود</span><input name="barcode" maxlength="50" dir="ltr" value="${val('barcode')}"></label>
        <label class="field"><span>التصنيف</span><select name="category_id"><option value="">بدون تصنيف</option>
          ${state.cats.map((c) => `<option value="${c.id}" ${p && p.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>سعر البيع (د.ع)</span><input name="sale_price" type="number" min="0" step="250" required value="${val('sale_price')}"></label>
        <label class="field"><span>الحد الأدنى للمخزون</span><input name="min_stock" type="number" min="0" step="1" required value="${val('min_stock', 5)}"></label>
        <label class="check wide"><input type="checkbox" name="requires_rx" ${p && p.requires_rx ? 'checked' : ''}> يُصرف بوصفة طبية فقط</label>
      </div>
      ${p ? '' : '<p class="hint">تُضاف الكميات عبر فاتورة شراء من شاشة المشتريات (كل سطر شراء يُنشئ دفعة).</p>'}`,
    onOpen: (form) => form.brand_name.focus(),
    onSubmit: (form) => {
      const body = {
        brand_name: form.brand_name.value, generic_name: form.generic_name.value,
        dosage_form: form.dosage_form.value, pack_size: form.pack_size.value,
        barcode: form.barcode.value.trim(), category_id: form.category_id.value || null,
        sale_price: form.sale_price.value === '' ? null : Number(form.sale_price.value),
        min_stock: form.min_stock.value === '' ? null : Number(form.min_stock.value),
        requires_rx: form.requires_rx.checked
      };
      return p ? api(`/products/${p.id}`, { method: 'PUT', body }) : api('/products', { method: 'POST', body });
    }
  });
  if (saved) {
    toast(p ? 'تم حفظ التعديلات' : 'تمت إضافة الصنف', 'ok');
    await load();
  }
}

async function toggleActive(p) {
  if (p.active) {
    const ok = await openDialog({
      title: 'تعطيل صنف', submitLabel: 'تعطيل', danger: true,
      body: `<p>سيختفي «${esc(p.brand_name)}» من شاشة البيع. يبقى في السجلات والتقارير ويمكن إعادة تفعيله لاحقاً.</p>`
    });
    if (!ok) return;
  }
  try {
    await api(`/products/${p.id}/active`, { method: 'PATCH', body: { active: !p.active } });
    toast(p.active ? 'تم تعطيل الصنف' : 'تم تفعيل الصنف', 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'error');
  }
}

const BATCH_STATUS = {
  expired: '<span class="tag danger">منتهية</span>',
  expiring: '<span class="tag warn">تنتهي قريباً</span>',
  ok: '<span class="tag ok">صالحة</span>'
};

async function batchesDialog(p) {
  let body;
  const refresh = async () => {
    const [batches, moves] = await Promise.all([api(`/products/${p.id}/batches`), api(`/products/${p.id}/movements`)]);
    body.querySelector('[data-batches]').innerHTML = batches.length ? `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>رقم الدفعة</th><th>تاريخ الانتهاء</th><th>الكمية</th><th>الكلفة</th><th>المورد</th><th>الاستلام</th><th>الحالة</th><th></th></tr></thead>
        <tbody>${batches.map((b) => `<tr>
          <td>${ltr(esc(b.batch_no))}</td><td>${fmtDate(b.expiry_date)}</td><td>${int(b.quantity)}</td>
          <td>${money(b.unit_cost)}</td><td>${esc(b.supplier_name || '—')}</td><td>${fmtDate(b.received_at)}</td>
          <td>${b.quantity ? BATCH_STATUS[b.status] : '<span class="tag">فارغة</span>'}</td>
          <td><button type="button" class="btn-sm" data-adjust="${b.id}">تعديل الكمية</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state">لا توجد دفعات لهذا الصنف. أضف الكمية عبر فاتورة شراء.</div>';
    body.querySelector('[data-moves]').innerHTML = moves.length ? `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>التاريخ</th><th>النوع</th><th>الدفعة</th><th>الكمية</th><th>السبب</th><th>المستخدم</th></tr></thead>
        <tbody>${moves.map((m) => `<tr>
          <td>${fmtDateTime(m.created_at)}</td><td>${MOVEMENT_LABELS[m.movement_type]}</td><td>${ltr(esc(m.batch_no))}</td>
          <td class="${m.qty_change < 0 ? 'neg' : 'pos'}">${signed(m.qty_change)}</td>
          <td class="wrap">${esc(m.reason || '')}</td><td>${esc(m.user_name)}</td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state">لا توجد حركات</div>';
    body._batches = batches;
  };

  await openDialog({
    title: `دفعات «${p.brand_name}»`,
    wide: true,
    noSubmit: true,
    cancelLabel: 'إغلاق',
    body: `
      <div class="tabs" role="tablist">
        <button type="button" class="tab" role="tab" aria-selected="true" data-tab="batches">الدفعات</button>
        <button type="button" class="tab" role="tab" aria-selected="false" data-tab="moves">سجل الحركات</button>
      </div>
      <div data-batches></div>
      <div data-moves hidden></div>`,
    onOpen: async (form) => {
      body = form;
      form.querySelector('.tabs').addEventListener('click', (e) => {
        const t = e.target.closest('[role=tab]');
        if (!t) return;
        $$('[role=tab]', form).forEach((x) => x.setAttribute('aria-selected', String(x === t)));
        form.querySelector('[data-batches]').hidden = t.dataset.tab !== 'batches';
        form.querySelector('[data-moves]').hidden = t.dataset.tab !== 'moves';
      });
      form.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-adjust]');
        if (!b) return;
        const batch = form._batches.find((x) => x.id === Number(b.dataset.adjust));
        if (await adjustDialog(p, batch)) { await refresh(); await load(); }
      });
      try { await refresh(); } catch (err) { toast(err.message, 'error'); }
    }
  });
}

function adjustDialog(p, batch) {
  const expired = batch.status === 'expired';
  return openDialog({
    title: `تعديل كمية الدفعة ${batch.batch_no}`,
    submitLabel: 'حفظ',
    body: `
      <dl class="kv"><dt>الصنف</dt><dd>${esc(p.brand_name)}</dd>
        <dt>الكمية الحالية</dt><dd>${int(batch.quantity)}</dd>
        <dt>تاريخ الانتهاء</dt><dd>${fmtDate(batch.expiry_date)}</dd></dl>
      <div class="form-grid">
        <label class="field"><span>نوع الحركة</span>
          <select name="type">
            <option value="adjustment" ${expired ? '' : 'selected'}>تصحيح جرد (إدخال الكمية الفعلية)</option>
            <option value="write_off" ${expired ? 'selected' : ''}>إتلاف (إنقاص كمية)</option>
          </select></label>
        <label class="field"><span data-qlabel></span>
          <input name="qty" type="number" min="0" step="1" required></label>
      </div>
      <div class="hint" data-preview></div>
      <label class="field"><span>السبب (مطلوب)</span>
        <textarea name="reason" required minlength="3" maxlength="500" placeholder="${expired ? 'مثال: انتهاء الصلاحية' : 'مثال: جرد شهري، تلف، كسر'}">${expired ? 'إتلاف دفعة منتهية الصلاحية' : ''}</textarea></label>`,
    onOpen: (form) => {
      const update = () => {
        const writeOff = form.type.value === 'write_off';
        form.querySelector('[data-qlabel]').textContent = writeOff ? 'الكمية المُتلفة' : 'الكمية الفعلية بعد الجرد';
        const n = Number(form.qty.value);
        const change = form.qty.value === '' ? null : writeOff ? -n : n - batch.quantity;
        form.querySelector('[data-preview]').innerHTML = change === null ? '' :
          `التغيير: <strong class="${change < 0 ? 'neg' : 'pos'}">${signed(change)}</strong> — الكمية بعد الحفظ: ${int(batch.quantity + change)}`;
      };
      form.type.addEventListener('change', () => {
        form.qty.value = form.type.value === 'write_off' && expired ? batch.quantity : '';
        update();
      });
      form.qty.addEventListener('input', update);
      if (expired) form.qty.value = batch.quantity;
      update();
      form.qty.focus();
    },
    onSubmit: async (form) => {
      if (form.qty.value === '') throw new Error('أدخل الكمية');
      const n = Number(form.qty.value);
      const writeOff = form.type.value === 'write_off';
      const change = writeOff ? -n : n - batch.quantity;
      if (!Number.isInteger(n) || n < 0) throw new Error('أدخل عدداً صحيحاً');
      if (change === 0) throw new Error('لم تتغير الكمية');
      if (form.reason.value.trim().length < 3) throw new Error('اكتب سبب التعديل');
      await api(`/batches/${batch.id}/adjust`, {
        method: 'POST', body: { type: form.type.value, qty_change: change, reason: form.reason.value }
      });
      toast('تم تعديل الكمية', 'ok');
      return true;
    }
  });
}

async function categoriesDialog() {
  const renderList = (form) => {
    form.querySelector('[data-list]').innerHTML = state.cats.map((c) => `
      <div class="toolbar"><input class="input" data-cat-id="${c.id}" value="${esc(c.name)}" maxlength="100" aria-label="اسم التصنيف">
        <button type="button" class="btn-sm" data-rename="${c.id}">حفظ</button></div>`).join('') ||
      '<p class="muted">لا توجد تصنيفات</p>';
  };
  await openDialog({
    title: 'التصنيفات',
    submitLabel: 'إضافة',
    cancelLabel: 'إغلاق',
    body: `<div data-list class="form"></div>
      <label class="field"><span>تصنيف جديد</span><input name="name" maxlength="100"></label>`,
    onOpen: (form) => {
      renderList(form);
      form.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-rename]');
        if (!b) return;
        const input = form.querySelector(`[data-cat-id="${b.dataset.rename}"]`);
        try {
          await api(`/categories/${b.dataset.rename}`, { method: 'PUT', body: { name: input.value } });
          state.cats = await api('/categories');
          toast('تم حفظ التصنيف', 'ok');
        } catch (err) { toast(err.message, 'error'); }
      });
    },
    onSubmit: async (form) => {
      if (!form.name.value.trim()) throw new Error('أدخل اسم التصنيف');
      await api('/categories', { method: 'POST', body: { name: form.name.value } });
      state.cats = await api('/categories');
      form.name.value = '';
      renderList(form);
      toast('تمت إضافة التصنيف', 'ok');
      return false; // keep the dialog open
    }
  });
  await load();
}
