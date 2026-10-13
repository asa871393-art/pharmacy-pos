(function () {
  const state = { cart: {}, cat: 'all', query: '', discount: 0, pay: 'cash' };
  const PAYS = [{ id: 'cash', label: 'نقداً' }, { id: 'card', label: 'بطاقة' }, { id: 'debt', label: 'آجل' }];

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString('en-US') + ' ' + window.CURRENCY;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const byId = (id) => window.PRODUCTS.find((p) => p.id === id);

  function setQty(id, q) {
    const p = byId(id);
    if (q > p.stock) q = p.stock;
    if (q <= 0) delete state.cart[id]; else state.cart[id] = q;
    $('done').hidden = true;
    renderProducts();
    renderCart();
  }

  function renderCats() {
    $('cats').innerHTML = window.CATEGORIES.map((c) =>
      `<button type="button" class="chip${state.cat === c.id ? ' on' : ''}" data-cat="${c.id}" aria-pressed="${state.cat === c.id}">${esc(c.label)}</button>`
    ).join('');
  }

  function renderProducts() {
    const q = state.query.trim();
    const list = window.PRODUCTS.filter((p) =>
      (state.cat === 'all' || p.cat === state.cat) &&
      (!q || p.name.includes(q) || p.generic.includes(q) || (p.barcode && p.barcode === q))
    );
    $('noresults').hidden = list.length > 0;
    $('products').innerHTML = list.map((p) => {
      const inCart = state.cart[p.id] || 0;
      const left = p.stock - inCart;
      let cls = 'stock', label = 'متوفر: ' + left;
      if (p.stock === 0) { cls += ' out'; label = 'نفد'; }
      else if (left <= window.LOW_STOCK) { cls += ' low'; label = 'منخفض: ' + left; }
      return `<button type="button" class="pcard" data-add="${p.id}" ${p.stock === 0 ? 'disabled' : ''} aria-label="إضافة ${esc(p.name)} إلى الفاتورة">
        <div class="top">
          <div class="names"><strong>${esc(p.name)}</strong><span>${esc(p.generic)}</span></div>
          ${p.rx ? '<span class="badge-rx">وصفة</span>' : ''}
        </div>
        <span class="form">${esc(p.form)}</span>
        <div class="grow"></div>
        <div class="bottom"><strong class="price">${fmt(p.price)}</strong><span class="${cls}">${label}</span></div>
        ${p.exp ? `<span class="badge-exp">ينتهي قريباً: ${esc(p.exp)}</span>` : ''}
      </button>`;
    }).join('');
  }

  function renderCart() {
    const ids = Object.keys(state.cart);
    $('count').textContent = ids.length + ' صنف';
    if (!ids.length) {
      $('cart').innerHTML = '<div class="empty">الفاتورة فارغة. اختر دواءً من القائمة لإضافته.</div>';
    } else {
      $('cart').innerHTML = ids.map((id) => {
        const p = byId(id), qty = state.cart[id];
        return `<div class="line">
          <div class="info">
            <b>${esc(p.name)}</b>
            <span>${fmt(p.price)} للوحدة</span>
            ${p.rx ? '<span class="rxnote">يتطلب إرفاق وصفة طبية</span>' : ''}
          </div>
          <div class="qty">
            <button type="button" data-inc="${id}" aria-label="زيادة الكمية">+</button>
            <span>${qty}</span>
            <button type="button" data-dec="${id}" aria-label="إنقاص الكمية">−</button>
          </div>
          <strong class="amount">${fmt(p.price * qty)}</strong>
          <button type="button" class="del" data-del="${id}" aria-label="حذف الصنف">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>`;
      }).join('');
    }
    const subtotal = ids.reduce((a, id) => a + byId(id).price * state.cart[id], 0);
    const d = Math.min(100, Math.max(0, Number(state.discount) || 0));
    $('subtotal').textContent = fmt(subtotal);
    $('total').textContent = fmt(Math.round(subtotal * (1 - d / 100)));
  }

  function renderPays() {
    $('pays').innerHTML = PAYS.map((m) =>
      `<button type="button" class="pay${state.pay === m.id ? ' on' : ''}" data-pay="${m.id}" aria-pressed="${state.pay === m.id}">${m.label}</button>`
    ).join('');
  }

  function checkout() {
    const ids = Object.keys(state.cart);
    if (!ids.length) return;
    // هنا يُرسل البيع إلى الخادم/قاعدة البيانات لاحقاً
    ids.forEach((id) => { byId(id).stock -= state.cart[id]; });
    window.print();
    state.cart = {};
    state.discount = 0;
    $('disc').value = 0;
    $('cust').value = '';
    $('done').hidden = false;
    renderProducts();
    renderCart();
  }

  // Events
  $('cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    state.cat = b.dataset.cat; renderCats(); renderProducts();
  });
  $('products').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]'); if (!b || b.disabled) return;
    const id = b.dataset.add; setQty(id, (state.cart[id] || 0) + 1);
  });
  $('cart').addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.inc) setQty(t.dataset.inc, state.cart[t.dataset.inc] + 1);
    if (t.dataset.dec) setQty(t.dataset.dec, state.cart[t.dataset.dec] - 1);
    if (t.dataset.del) setQty(t.dataset.del, 0);
  });
  $('pays').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pay]'); if (!b) return;
    state.pay = b.dataset.pay; renderPays();
  });
  $('q').addEventListener('input', (e) => { state.query = e.target.value; renderProducts(); });
  $('q').addEventListener('keydown', (e) => {
    // Enter بعد مسح الباركود يضيف أول نتيجة مباشرة
    if (e.key !== 'Enter') return;
    const first = $('products').querySelector('[data-add]:not([disabled])');
    if (first) { first.click(); e.target.value = ''; state.query = ''; renderProducts(); }
  });
  $('disc').addEventListener('input', (e) => { state.discount = e.target.value; renderCart(); });
  $('clear').addEventListener('click', () => { state.cart = {}; renderProducts(); renderCart(); });
  $('checkout').addEventListener('click', checkout);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F2') { e.preventDefault(); $('q').focus(); $('q').select(); }
    if (e.key === 'F9') { e.preventDefault(); checkout(); }
  });

  renderCats();
  renderProducts();
  renderCart();
  renderPays();
})();
