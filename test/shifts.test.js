'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

describe('shifts and customer payments', () => {
  let t;
  beforeEach(async () => { t = await setup(); });

  it('allows only one open shift per user', async () => {
    const agent = await t.login('cash1', { openShift: true });
    const res = await agent.post('/api/shifts/open').send({ opening_cash: 0 });
    assert.equal(res.status, 409);
  });

  it('validates the opening amount', async () => {
    const agent = await t.login('cash1');
    assert.equal((await agent.post('/api/shifts/open').send({ opening_cash: -5 })).status, 400);
    assert.equal((await agent.post('/api/shifts/open').send({})).status, 400);
  });

  it('computes expected cash and the difference on close', async () => {
    const cashier = await t.login('cash1', { openShift: true, openingCash: 50000 });
    const p = await t.addProduct({ price: 10000 });
    await t.addBatch(p, { qty: 100 });
    const debtor = await t.addCustomer('مدين', 30000);

    // Cash sales: 2 × 10000 = 20000, then 10000.
    const s1 = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 2 }], payment_method: 'cash' });
    await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash' });
    // Card and debt sales don't change drawer cash.
    await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 4 }], payment_method: 'card' });
    await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'debt', customer_id: debtor });
    // Customer pays 15000 cash and 5000 by card toward debt.
    assert.equal((await cashier.post(`/api/customers/${debtor}/payments`).send({ amount: 15000, method: 'cash' })).status, 201);
    assert.equal((await cashier.post(`/api/customers/${debtor}/payments`).send({ amount: 5000, method: 'card' })).status, 201);

    // A pharmacist refunds 10000 cash from the cashier's sale in the pharmacist's own shift:
    // that refund must not touch the cashier's drawer.
    const pharm = await t.login('pharm', { openShift: true });
    await pharm.post(`/api/sales/${s1.body.id}/returns`).send({ reason: 'x', items: [{ sale_item_id: s1.body.items[0].id, quantity: 1 }] });

    const cur = await cashier.get('/api/shifts/current');
    assert.equal(cur.body.cash_sales, 30000);
    assert.equal(cur.body.card_sales, 40000);
    assert.equal(cur.body.debt_sales, 10000);
    assert.equal(cur.body.cash_customer_payments, 15000);
    assert.equal(cur.body.cash_refunds, 0);
    assert.equal(cur.body.expected_cash, 50000 + 30000 + 15000);

    const closed = await cashier.post('/api/shifts/current/close').send({ counted_cash: 94000, notes: 'نقص ألف' });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.expected_cash, 95000);
    assert.equal(closed.body.counted_cash, 94000);
    assert.equal(closed.body.difference, -1000);
    assert.ok(closed.body.closed_at);

    const pharmShift = await pharm.get('/api/shifts/current');
    assert.equal(pharmShift.body.cash_refunds, 10000);
    assert.equal(pharmShift.body.expected_cash, -10000);

    // After closing: no current shift, and selling is blocked.
    assert.equal((await cashier.get('/api/shifts/current')).body, null);
    const blocked = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash' });
    assert.equal(blocked.status, 409);
  });

  it('rejects closing without an open shift', async () => {
    const agent = await t.login('cash1');
    assert.equal((await agent.post('/api/shifts/current/close').send({ counted_cash: 0 })).status, 404);
  });

  it('rejects payments larger than the debt, and cash payments without a shift', async () => {
    const c = await t.addCustomer('مدين', 5000);
    const withShift = await t.login('cash1', { openShift: true });
    assert.equal((await withShift.post(`/api/customers/${c}/payments`).send({ amount: 6000, method: 'cash' })).status, 400);
    const noShift = await t.login('cash2');
    assert.equal((await noShift.post(`/api/customers/${c}/payments`).send({ amount: 1000, method: 'cash' })).status, 409);
    assert.equal((await noShift.post(`/api/customers/${c}/payments`).send({ amount: 1000, method: 'card' })).status, 201);
    const cust = await t.db.get('SELECT balance FROM customers WHERE id = ?', [c]);
    assert.equal(cust.balance, 4000);
  });

  it('creates and searches customers, rejecting duplicate phones', async () => {
    const agent = await t.login('cash1');
    const created = await agent.post('/api/customers').send({ name: 'فاطمة علي', phone: '07701234567' });
    assert.equal(created.status, 201);
    assert.equal((await agent.post('/api/customers').send({ name: 'أخرى', phone: '07701234567' })).status, 409);
    assert.equal((await agent.post('/api/customers').send({ name: 'x', phone: 'abc' })).status, 400);
    const found = await agent.get('/api/customers').query({ q: '0770' });
    assert.equal(found.body.length, 1);
    assert.equal(found.body[0].name, 'فاطمة علي');
  });
});
