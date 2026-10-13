'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

describe('returns', () => {
  let t, cashier, pharm;
  beforeEach(async () => {
    t = await setup();
    cashier = await t.login('cash1', { openShift: true });
    pharm = await t.login('pharm', { openShift: true });
  });

  async function sell(body) {
    const res = await cashier.post('/api/sales').send({ payment_method: 'cash', ...body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  it('puts quantity back into the same batch it was sold from', async () => {
    const p = await t.addProduct({ price: 1000 });
    const early = await t.addBatch(p, { qty: 2, expiresInDays: 30, batchNo: 'E' });
    const late = await t.addBatch(p, { qty: 10, expiresInDays: 300, batchNo: 'L' });
    const sale = await sell({ items: [{ product_id: p, quantity: 5 }] }); // 2 from E, 3 from L
    const lineE = sale.items.find((i) => i.batch_no === 'E');
    const lineL = sale.items.find((i) => i.batch_no === 'L');

    const res = await pharm.post(`/api/sales/${sale.id}/returns`).send({
      reason: 'الزبون لم يعد بحاجته',
      items: [{ sale_item_id: lineE.id, quantity: 1 }, { sale_item_id: lineL.id, quantity: 2 }]
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await t.batchQty(early), 1);
    assert.equal(await t.batchQty(late), 9);
    assert.equal(res.body.items.find((i) => i.id === lineE.id).returned_qty, 1);
    assert.equal(res.body.items.find((i) => i.id === lineL.id).returned_qty, 2);
    assert.equal(res.body.returns.length, 1);
    assert.equal(res.body.returns[0].refund_amount, 3000);

    const mv = await t.db.all("SELECT batch_id, qty_change FROM stock_movements WHERE movement_type = 'return' ORDER BY id");
    assert.deepEqual(mv.map((m) => [m.batch_id, m.qty_change]), [[early, 1], [late, 2]]);
  });

  it('refuses to return more than was sold, across several returns', async () => {
    const p = await t.addProduct();
    const b = await t.addBatch(p, { qty: 10 });
    const sale = await sell({ items: [{ product_id: p, quantity: 3 }] });
    const lineId = sale.items[0].id;

    const tooMany = await pharm.post(`/api/sales/${sale.id}/returns`).send({ reason: 'تالف', items: [{ sale_item_id: lineId, quantity: 4 }] });
    assert.equal(tooMany.status, 409);

    assert.equal((await pharm.post(`/api/sales/${sale.id}/returns`).send({ reason: 'تالف', items: [{ sale_item_id: lineId, quantity: 2 }] })).status, 201);
    const again = await pharm.post(`/api/sales/${sale.id}/returns`).send({ reason: 'تالف', items: [{ sale_item_id: lineId, quantity: 2 }] });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /\(1\)/);
    assert.equal(await t.batchQty(b), 9);
  });

  it('rejects items from another invoice and requires a reason', async () => {
    const p = await t.addProduct();
    await t.addBatch(p, { qty: 10 });
    const s1 = await sell({ items: [{ product_id: p, quantity: 1 }] });
    const s2 = await sell({ items: [{ product_id: p, quantity: 1 }] });
    const wrong = await pharm.post(`/api/sales/${s1.id}/returns`).send({ reason: 'x', items: [{ sale_item_id: s2.items[0].id, quantity: 1 }] });
    assert.equal(wrong.status, 400);
    const noReason = await pharm.post(`/api/sales/${s1.id}/returns`).send({ items: [{ sale_item_id: s1.items[0].id, quantity: 1 }] });
    assert.equal(noReason.status, 400);
    assert.equal(await t.count('sale_returns'), 0);
  });

  it('applies the invoice discount to refunds and never refunds more than was paid', async () => {
    const p = await t.addProduct({ price: 1000 });
    await t.addBatch(p, { qty: 10 });
    // 3 × 1000 = 3000, 7% off → 210 discount, total 2790 (not divisible by 3).
    const sale = await sell({ items: [{ product_id: p, quantity: 3 }], discount_pct: 7 });
    assert.equal(sale.total, 2790);
    const lineId = sale.items[0].id;
    let refunded = 0;
    for (let i = 0; i < 3; i++) {
      const res = await pharm.post(`/api/sales/${sale.id}/returns`).send({ reason: 'إرجاع', items: [{ sale_item_id: lineId, quantity: 1 }] });
      assert.equal(res.status, 201);
      refunded = res.body.refunded_total;
    }
    assert.equal(refunded, 2790);
  });

  it('reduces the customer balance when returning a debt sale', async () => {
    const p = await t.addProduct({ price: 2000 });
    await t.addBatch(p, { qty: 10 });
    const c = await t.addCustomer('زبون آجل');
    const sale = await sell({ items: [{ product_id: p, quantity: 3 }], payment_method: 'debt', customer_id: c });
    await pharm.post(`/api/sales/${sale.id}/returns`).send({ reason: 'إرجاع', items: [{ sale_item_id: sale.items[0].id, quantity: 1 }] });
    const cust = await t.db.get('SELECT balance FROM customers WHERE id = ?', [c]);
    assert.equal(cust.balance, 4000);
    const ret = await t.db.get('SELECT refund_method FROM sale_returns');
    assert.equal(ret.refund_method, 'debt');
  });

  it('requires an open shift for a cash refund', async () => {
    const p = await t.addProduct();
    await t.addBatch(p, { qty: 10 });
    const sale = await sell({ items: [{ product_id: p, quantity: 1 }] });
    const admin = await t.login('admin');
    const res = await admin.post(`/api/sales/${sale.id}/returns`).send({ reason: 'x', items: [{ sale_item_id: sale.items[0].id, quantity: 1 }] });
    assert.equal(res.status, 409);
  });

  it('allows returning stock into a batch that has since expired, without making it sellable', async () => {
    const p = await t.addProduct();
    const b = await t.addBatch(p, { qty: 5, expiresInDays: 10 });
    const sale = await sell({ items: [{ product_id: p, quantity: 2 }] });
    await t.db.run("UPDATE batches SET expiry_date = '2000-01-01' WHERE id = ?", [b]);
    const res = await pharm.post(`/api/sales/${sale.id}/returns`).send({ reason: 'x', items: [{ sale_item_id: sale.items[0].id, quantity: 2 }] });
    assert.equal(res.status, 201);
    assert.equal(await t.batchQty(b), 5);
    const prod = (await cashier.get('/api/products')).body.find((x) => x.id === p);
    assert.equal(prod.stock, 0);
  });
});
