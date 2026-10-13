// App shell: loads the user, shows the navigation links their role allows, and routes
// between pages by URL hash (#/sales, #/inventory, ...). Each page module exports
// init(root) (called once) and show() (called every time the page becomes visible).
import { api } from './api.js';
import { $, $$, toast, esc } from './ui.js';
import { ctx } from './state.js';
import { refreshShift, openShiftDialog, closeShiftDialog } from './shift.js';

const PAGES = {
  sales: () => import('./pages/sales.js'),
  inventory: () => import('./pages/inventory.js'),
  purchases: () => import('./pages/purchases.js'),
  prescriptions: () => import('./pages/prescriptions.js'),
  reports: () => import('./pages/reports.js'),
  invoices: () => import('./pages/invoices.js'),
  settings: () => import('./pages/settings.js')
};
const loaded = {};

async function route() {
  let name = location.hash.replace(/^#\/?/, '');
  if (!ctx.me.permissions.includes(name) || !PAGES[name]) {
    name = ctx.me.permissions[0];
    history.replaceState(null, '', '#/' + name);
  }
  ctx.route = name;
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$('#nav a').forEach((a) => {
    const on = a.dataset.route === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const root = $(`.view[data-view="${name}"]`);
  try {
    if (!loaded[name]) {
      const mod = await PAGES[name]();
      await mod.init(root);
      loaded[name] = mod;
    }
    if (loaded[name].show) await loaded[name].show();
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="empty-state">${esc(err.message || 'تعذر تحميل الصفحة')}</div>`;
  }
}

async function start() {
  ctx.me = await api('/auth/me');
  ctx.settings = await api('/settings');
  $('#pharmacy-name').textContent = ctx.settings.pharmacy_name;
  document.title = ctx.settings.pharmacy_name + ' - نقطة البيع';
  $('#user-name').textContent = ctx.me.full_name;
  $$('#nav a').forEach((a) => { a.hidden = !ctx.me.permissions.includes(a.dataset.route); });
  await refreshShift();
  $('#app').hidden = false;

  $('#shift-btn').addEventListener('click', () => (ctx.shift ? closeShiftDialog() : openShiftDialog()));
  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  });
  window.addEventListener('hashchange', route);
  await route();
}

start().catch((err) => {
  if (err.status !== 401) toast(err.message, 'error');
});
