// Sales screen: catalog, cart, customer picker, prescriptions dialog, checkout and receipt.
import { api } from '../api.js';
import { $, $$, esc, money, int, fmtMonth, toast, openDialog, debounce, todayIso, PAY_LABELS, ltr } from '../ui.js';
import { ctx } from '../state.js';
import { openShiftDialog, refreshShift } from '../shift.js';
import { printReceipt } from '../receipt.js';

const PAYS = ['cash', 'card', 'debt'];
const MAX_IMAGE = 5 * 1024 * 1024;
const state = {
  products: [], cats: [], cat: 'all', query: '',
  cart: new Map(),        // product_id -> quantity
  discount: 0, pay: 'cash', customer: null, lastSale: null, busy: false,
  suggest: [], suggestIndex: -1
};
const byId = (id) => state.products.find((p) => p.id === id);

export function init() {
  $('#cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.cat = b.dataset.cat;
    renderCats();
    renderProducts();
  });
  $('#products').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (b && !b.disabled) addToCart(Number(b.dataset.add), 1);
  });
  $('#cart').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.inc) addToCart(Number(t.dataset.inc), 1);
    if (t.dataset.dec) addToCart(Number(t.dataset.dec), -1);
    if (t.dataset.del) setQty(Number(t.dataset.del), 0);
  });
  $('#pays').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pay]');
    if (!b) return;
    state.pay = b.dataset.pay;
    renderPays();
  });
  $('#q').addEventListener('input', (e) => { state.query = e.target.value; renderProducts(); });
  $('#q').addEventListener('keydown', onSearchEnter);
  $('#scan').addEventListener('click', () => {
    $('#q').focus();
    $('#q').select();
    toast('جاهز للمسح: وجّه الماسح نحو الباركود');
  });
  $('#disc').addEventListener('input', (e) => { state.discount = e.target.value; renderTotals(); });
  $('#clear').addEventListener('click', () => { state.cart.clear(); renderProducts(); renderCart(); });
  $('#checkout').addEventListener('click', checkout);
  $('#done').addEventListener('click', (e) => {
    if (e.target.closest('[data-reprint]') && state.lastSale) printReceipt(state.lastSale, ctx.settings.pharmacy_name);
  });
  initCustomerPicker();

  document.addEventListener('keydown', (e) => {
    if (ctx.route !== 'sales' || document.querySelector('dialog[open]')) return;
    if (e.key === 'F2') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
    if (e.key === 'F9') { e.preventDefault(); checkout(); }
  });

  $('#disc-max').textContent = `(الحد ${ltr(ctx.settings.max_discount_pct + '%')})`;
  $('#disc').max = ctx.settings.max_discount_pct;
  renderPays();
}

export async function show() {
  await loadData();
  $('#q').focus();
  if (!ctx.shift) await openShiftDialog();
}

async function loadData() {
  const [cats, products] = await Promise.all([api('/categories'), api('/products')]);
  state.cats = cats;
  state.products = products;
  // Drop or trim cart lines whose product disappeared or lost stock.
  for (const [id, qty] of state.cart) {
    const p = byId(id);
    if (!p || p.stock === 0) state.cart.delete(id);
    else if (qty > p.stock) state.cart.set(id, p.stock);
  }
  renderCats();
  renderProducts();
  renderCart();
}

function addToCart(id, delta) {
  setQty(id, (state.cart.get(id) || 0) + delta);
}

function setQty(id, q) {
  const p = byId(id);
  if (!p) return;
  if (q > p.stock) {
    toast(`الكمية المتوفرة من «${p.brand_name}»: ${p.stock}`, 'error');
    q = p.stock;
  }
  if (q <= 0) state.cart.delete(id); else state.cart.set(id, q);
  $('#done').hidden = true;
  renderProducts();
  renderCart();
}

function onSearchEnter(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = e.target.value.trim();
  if (!q) return;
  // Barcode scanners type the code and press Enter: exact barcode match wins.
  let p = state.products.find((x) => x.barcode && x.barcode === q);
  if (!p && /^\d{6,}$/.test(q)) {
    toast('لا يوجد صنف بهذا الباركود: ' + q, 'error');
    e.target.select();
    return;
  }
  if (p && p.stock === 0) {
    toast(`«${p.brand_name}» نفد من المخزون`, 'error');
  } else {
    if (!p) {
      const first = $('#products [data-add]:not([disabled])');
      p = first && byId(Number(first.dataset.add));
    }
    if (p) addToCart(p.id, 1);
  }
  e.target.value = '';
  state.query = '';
  renderProducts();
}

function renderCats() {
  const all = [{ id: 'all', name: 'الكل' }, ...state.cats];
  $('#cats').innerHTML = all.map((c) => {
    const on = String(state.cat) === String(c.id);
    return `<button type="button" class="chip${on ? ' on' : ''}" data-cat="${c.id}" aria-pressed="${on}">${esc(c.name)}</button>`;
  }).join('');
}

function renderProducts() {
  const q = state.query.trim();
  const list = state.products.filter((p) =>
    (state.cat === 'all' || String(p.category_id) === String(state.cat)) &&
    (!q || p.brand_name.includes(q) || p.generic_name.includes(q) ||
      p.brand_name.toLowerCase().includes(q.toLowerCase()) || (p.barcode && p.barcode === q))
  );
  $('#noresults').hidden = list.length > 0;
  $('#products').innerHTML = list.map((p) => {
    const left = p.stock - (state.cart.get(p.id) || 0);
    let cls = 'stock';
    let label = 'متوفر: ' + left;
    if (p.stock === 0) { cls += ' out'; label = 'نفد'; }
    else if (left <= p.min_stock) { cls += ' low'; label = 'منخفض: ' + left; }
    const form = [p.dosage_form, p.pack_size].filter(Boolean).join(' · ');
    return `<button type="button" class="pcard" data-add="${p.id}" ${p.stock === 0 ? 'disabled' : ''} aria-label="إضافة ${esc(p.brand_name)} إلى الفاتورة">
      <div class="top">
        <div class="names"><strong>${esc(p.brand_name)}</strong><span>${esc(p.generic_name)}</span></div>
        ${p.requires_rx ? '<span class="badge-rx">وصفة</span>' : ''}
      </div>
      <span class="form">${esc(form)}</span>
      <div class="grow"></div>
      <div class="bottom"><strong class="price">${money(p.sale_price)}</strong><span class="${cls}">${label}</span></div>
      ${p.expiring_soon ? `<span class="badge-exp">ينتهي قريباً: ${fmtMonth(p.next_expiry)}</span>` : ''}
    </button>`;
  }).join('');
}

function renderCart() {
  const ids = [...state.cart.keys()];
  $('#count').textContent = ids.length + ' صنف';
  $('#cart').innerHTML = ids.length ? ids.map((id) => {
    const p = byId(id);
    const qty = state.cart.get(id);
    return `<div class="line">
      <div class="info">
        <b>${esc(p.brand_name)}</b>
        <span>${money(p.sale_price)} للوحدة</span>
        ${p.requires_rx ? '<span class="rxnote">يتطلب إرفاق وصفة طبية</span>' : ''}
      </div>
      <div class="qty">
        <button type="button" data-inc="${id}" aria-label="زيادة الكمية">+</button>
        <span>${qty}</span>
        <button type="button" data-dec="${id}" aria-label="إنقاص الكمية">−</button>
      </div>
      <strong class="amount">${money(p.sale_price * qty)}</strong>
      <button type="button" class="del" data-del="${id}" aria-label="حذف الصنف">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`;
  }).join('') : '<div class="empty">الفاتورة فارغة. اختر دواءً من القائمة لإضافته.</div>';
  renderTotals();
}

function discountPct() {
  return Math.max(0, Number(state.discount) || 0);
}

function renderTotals() {
  const subtotal = [...state.cart].reduce((a, [id, q]) => a + byId(id).sale_price * q, 0);
  const max = ctx.settings.max_discount_pct;
  const d = Math.min(max, discountPct());
  $('#disc').setAttribute('aria-invalid', String(discountPct() > max));
  $('#disc-max').classList.toggle('neg', discountPct() > max);
  $('#subtotal').textContent = money(subtotal);
  $('#total').textContent = money(subtotal - Math.round((subtotal * d) / 100));
}

function renderPays() {
  $('#pays').innerHTML = PAYS.map((m) =>
    `<button type="button" class="pay${state.pay === m ? ' on' : ''}" data-pay="${m}" aria-pressed="${state.pay === m}">${PAY_LABELS[m]}</button>`
  ).join('');
}

// ---- Customer picker -------------------------------------------------------

function initCustomerPicker() {
  const input = $('#cust');
  const list = $('#cust-list');
  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) { closeSuggest(); return; }
    try {
      state.suggest = await api('/customers', { query: { q } });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    state.suggestIndex = state.suggest.length ? 0 : -1;
    renderSuggest(q);
  });
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const n = state.suggest.length + 1; // + "add new" row
    if (e.key === 'ArrowDown') { e.preventDefault(); state.suggestIndex = (state.suggestIndex + 1) % n; renderSuggest(input.value.trim()); }
    if (e.key === 'ArrowUp') { e.preventDefault(); state.suggestIndex = (state.suggestIndex - 1 + n) % n; renderSuggest(input.value.trim()); }
    if (e.key === 'Escape') closeSuggest();
    if (e.key === 'Enter') {
      e.preventDefault();
      const i = state.suggestIndex;
      if (i >= 0 && i < state.suggest.length) pickCustomer(state.suggest[i]);
      else addCustomer(input.value.trim());
    }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    if (li.dataset.add !== undefined) addCustomer(input.value.trim());
    else pickCustomer(state.suggest[Number(li.dataset.i)]);
  });
  input.addEventListener('blur', () => setTimeout(closeSuggest, 150));
  $('#cust-picked').addEventListener('click', (e) => {
    if (e.target.closest('[data-unpick]')) pickCustomer(null);
  });
}

function renderSuggest(q) {
  const list = $('#cust-list');
  list.innerHTML = state.suggest.map((c, i) => `
    <li role="option" data-i="${i}" aria-selected="${i === state.suggestIndex}">
      <span>${esc(c.name)} ${c.phone ? `<small>${ltr(esc(c.phone))}</small>` : ''}</span>
      ${c.balance ? `<small>دين: ${money(c.balance)}</small>` : ''}
    </li>`).join('') +
    `<li role="option" class="add" data-add aria-selected="${state.suggestIndex === state.suggest.length}">+ إضافة زبون جديد «${esc(q)}»</li>`;
  list.hidden = false;
  $('#cust').setAttribute('aria-expanded', 'true');
}

function closeSuggest() {
  $('#cust-list').hidden = true;
  $('#cust').setAttribute('aria-expanded', 'false');
}

function pickCustomer(c) {
  state.customer = c;
  closeSuggest();
  $('#cust').value = '';
  $('#cust-search').hidden = !!c;
  $('#cust-picked').hidden = !c;
  $('#cust-picked').innerHTML = c ? `
    <span>${esc(c.name)} ${c.phone ? `<small>${ltr(esc(c.phone))}</small>` : ''}
      ${c.balance ? `<small> · دين: ${money(c.balance)}</small>` : ''}</span>
    <button type="button" data-unpick aria-label="إزالة الزبون">إزالة</button>` : '';
  if (!c) $('#cust').focus();
}

async function addCustomer(text) {
  closeSuggest();
  const isPhone = /^[+\d\s]+$/.test(text);
  const c = await openDialog({
    title: 'إضافة زبون جديد',
    body: `<div class="form-grid">
      <label class="field"><span>الاسم</span><input name="name" required maxlength="150" value="${isPhone ? '' : esc(text)}"></label>
      <label class="field"><span>رقم الهاتف (اختياري)</span><input name="phone" maxlength="30" inputmode="tel" dir="ltr" value="${isPhone ? esc(text) : ''}"></label>
    </div>`,
    onOpen: (form) => (isPhone ? form.name : form.phone).focus(),
    onSubmit: (form) => {
      if (!form.name.value.trim()) throw new Error('أدخل اسم الزبون');
      return api('/customers', { method: 'POST', body: { name: form.name.value, phone: form.phone.value } });
    }
  });
  if (c) pickCustomer(c);
}

// ---- Prescriptions dialog --------------------------------------------------

function rxBlock(n, patient) {
  return `<fieldset class="rx-block" data-rx>
    <h3><span>الوصفة ${n}</span>${n > 1 ? '<button type="button" class="btn-sm danger" data-remove-rx>حذف</button>' : ''}</h3>
    <div class="form-grid">
      <label class="field"><span>رقم الوصفة</span><input data-f="rx_number" required maxlength="50"></label>
      <label class="field"><span>اسم الطبيب</span><input data-f="doctor_name" required maxlength="150"></label>
      <label class="field"><span>اسم المريض</span><input data-f="patient_name" required maxlength="150" value="${esc(patient)}"></label>
      <label class="field"><span>تاريخ الوصفة</span><input data-f="rx_date" type="date" required max="${todayIso()}" value="${todayIso()}"></label>
      <label class="field wide"><span>صورة الوصفة (اختياري: JPG أو PNG أو WEBP، حتى 5 ميغابايت)</span>
        <input data-f="image" type="file" accept="image/jpeg,image/png,image/webp"></label>
    </div>
  </fieldset>`;
}

function prescriptionDialog(rxIds) {
  const patient = state.customer ? state.customer.name : '';
  return openDialog({
    title: 'بيانات الوصفة الطبية',
    submitLabel: 'متابعة البيع',
    wide: true,
    body: `
      <p class="muted">الأصناف التالية تُصرف بوصفة طبية فقط: ${rxIds.map((id) => '«' + esc(byId(id).brand_name) + '»').join('، ')}</p>
      <div data-blocks>${rxBlock(1, patient)}</div>
      <button type="button" class="btn-ghost" data-add-rx>+ إضافة وصفة أخرى</button>
      <div class="card" data-assign hidden><h2>ربط كل صنف بوصفته</h2><div class="form-grid" data-assign-list></div></div>`,
    onOpen: (form) => {
      const blocks = form.querySelector('[data-blocks]');
      const renumber = () => {
        const all = $$('[data-rx]', blocks);
        all.forEach((b, i) => { b.querySelector('h3 span').textContent = 'الوصفة ' + (i + 1); });
        const assign = form.querySelector('[data-assign]');
        assign.hidden = all.length < 2;
        const list = form.querySelector('[data-assign-list]');
        const prev = Object.fromEntries($$('select', list).map((s) => [s.name, s.value]));
        list.innerHTML = rxIds.map((id) => `
          <label class="field"><span>${esc(byId(id).brand_name)}</span>
            <select name="rx-${id}">${all.map((_, i) =>
              `<option value="${i}" ${String(prev['rx-' + id] ?? 0) === String(i) ? 'selected' : ''}>الوصفة ${i + 1}</option>`).join('')}
            </select></label>`).join('');
      };
      form.querySelector('[data-add-rx]').addEventListener('click', () => {
        blocks.insertAdjacentHTML('beforeend', rxBlock($$('[data-rx]', blocks).length + 1, patient));
        renumber();
      });
      blocks.addEventListener('click', (e) => {
        if (e.target.closest('[data-remove-rx]')) { e.target.closest('[data-rx]').remove(); renumber(); }
      });
      renumber();
      form.querySelector('[data-f=rx_number]').focus();
    },
    onSubmit: (form) => {
      const blocks = $$('[data-rx]', form);
      const prescriptions = [];
      const files = [];
      blocks.forEach((b, i) => {
        const f = (name) => b.querySelector(`[data-f=${name}]`);
        const rx = { ref: 'r' + (i + 1) };
        for (const k of ['rx_number', 'doctor_name', 'patient_name', 'rx_date']) {
          rx[k] = f(k).value.trim();
          if (!rx[k]) { f(k).focus(); throw new Error(`الوصفة ${i + 1}: أكمل جميع الحقول`); }
        }
        if (rx.rx_date > todayIso()) throw new Error(`الوصفة ${i + 1}: التاريخ في المستقبل`);
        const file = f('image').files[0] || null;
        if (file && file.size > MAX_IMAGE) throw new Error(`الوصفة ${i + 1}: حجم الصورة يتجاوز 5 ميغابايت`);
        prescriptions.push(rx);
        files.push(file);
      });
      const refs = new Map();
      for (const id of rxIds) {
        const sel = form.querySelector(`select[name="rx-${id}"]`);
        refs.set(id, prescriptions[sel ? Number(sel.value) : 0].ref);
      }
      const used = new Set(refs.values());
      const unused = prescriptions.findIndex((p) => !used.has(p.ref));
      if (unused >= 0) throw new Error(`الوصفة ${unused + 1} غير مرتبطة بأي صنف`);
      return { prescriptions, files, refs };
    }
  });
}

// ---- Checkout --------------------------------------------------------------

async function checkout() {
  if (state.busy) return;
  const entries = [...state.cart];
  if (!entries.length) { toast('الفاتورة فارغة', 'error'); return; }
  if (!ctx.shift && !(await openShiftDialog())) return;
  if (state.pay === 'debt' && !state.customer) {
    toast('البيع الآجل يتطلب اختيار زبون', 'error');
    $('#cust').focus();
    return;
  }
  if (discountPct() > ctx.settings.max_discount_pct) {
    toast(`الخصم يتجاوز الحد المسموح (${ctx.settings.max_discount_pct}%)`, 'error');
    $('#disc').focus();
    return;
  }
  const rxIds = entries.map(([id]) => id).filter((id) => byId(id).requires_rx);
  let rx = { prescriptions: [], files: [], refs: new Map() };
  if (rxIds.length) {
    rx = await prescriptionDialog(rxIds);
    if (!rx) return;
  }

  state.busy = true;
  $('#checkout').disabled = true;
  try {
    const sale = await api('/sales', {
      method: 'POST',
      body: {
        items: entries.map(([id, q]) => ({ product_id: id, quantity: q, prescription_ref: rx.refs.get(id) })),
        prescriptions: rx.prescriptions,
        customer_id: state.customer ? state.customer.id : null,
        discount_pct: discountPct(),
        payment_method: state.pay
      }
    });
    // Prescriptions come back in the order they were sent.
    for (let i = 0; i < rx.files.length; i++) {
      if (!rx.files[i]) continue;
      const form = new FormData();
      form.append('image', rx.files[i]);
      try {
        await api(`/prescriptions/${sale.prescriptions[i].id}/image`, { method: 'POST', form });
      } catch (err) {
        toast('تم حفظ الفاتورة، لكن تعذر رفع صورة الوصفة: ' + err.message, 'error');
      }
    }
    state.lastSale = sale;
    state.cart.clear();
    state.discount = 0;
    $('#disc').value = 0;
    state.pay = 'cash';
    renderPays();
    pickCustomer(null);
    $('#done').innerHTML = `تم حفظ الفاتورة رقم ${ltr(esc(sale.invoice_no))}
      <button type="button" class="btn-link" data-reprint>إعادة الطباعة</button>`;
    $('#done').hidden = false;
    await loadData();
    $('#q').focus();
    printReceipt(sale, ctx.settings.pharmacy_name);
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 409) { await refreshShift(); await loadData(); }
  } finally {
    state.busy = false;
    $('#checkout').disabled = false;
  }
}
