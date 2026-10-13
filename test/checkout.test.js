'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { today } = require('../server/lib/time');

const rx = (ref = 'r1', extra = {}) => ({
  ref, rx_number: 'RX-100', doctor_name: 'د. أحمد', patient_name: 'علي حسن', rx_date: today(), ...extra
});

describe('checkout', () => {
  let t, cashier;
  beforeEach(async () => {
    t = await setup();
    cashier = await t.login('cash1', { openShift: true });
  });

  it('creates an invoice, deducts stock and logs movements', async () => {
    const p = await t.addProduct({ price: 3000 });
    const b = await t.addBatch(p, { qty: 10, cost: 2000 });
    const res = await cashier.post('/api/sales').send({
      items: [{ product_id: p, quantity: 3 }], payment_method: 'cash'
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const year = today().slice(0, 4);
    assert.equal(res.body.invoice_no, `${year}-000001`);
    assert.equal(res.body.subtotal, 9000);
    assert.equal(res.body.total, 9000);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].batch_id, b);
    assert.equal(await t.batchQty(b), 7);

    const mv = await t.db.all('SELECT * FROM stock_movements');
    assert.equal(mv.length, 1);
    assert.equal(mv[0].movement_type, 'sale');
    assert.equal(mv[0].qty_change, -3);
    assert.equal(mv[0].user_id, t.users.cash1);

    const cost = await t.db.get('SELECT unit_cost FROM sale_items');
    assert.equal(cost.unit_cost, 2000);

    const second = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'card' });
    assert.equal(second.body.invoice_no, `${year}-000002`);
  });

  it('ignores prices sent by the client', async () => {
    const p = await t.addProduct({ price: 5000 });
    await t.addBatch(p, { qty: 5 });
    const res = await cashier.post('/api/sales').send({
      items: [{ product_id: p, quantity: 1, unit_price: 1, sale_price: 1 }], payment_method: 'cash', total: 1
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.total, 5000);
  });

  it('requires an open shift', async () => {
    const p = await t.addProduct();
    await t.addBatch(p, { qty: 5 });
    const noShift = await t.login('cash2');
    const res = await noShift.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash' });
    assert.equal(res.status, 409);
    assert.equal(await t.count('sales'), 0);
  });

  describe('overselling prevention', () => {
    it('rejects a quantity larger than stock and changes nothing', async () => {
      const p = await t.addProduct({ name: 'بنادول' });
      const b = await t.addBatch(p, { qty: 4 });
      const res = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 5 }], payment_method: 'cash' });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /المتوفر: 4/);
      assert.equal(await t.batchQty(b), 4);
      assert.equal(await t.count('sales'), 0);
      assert.equal(await t.count('sale_items'), 0);
      assert.equal(await t.count('stock_movements'), 0);
    });

    it('rolls back earlier lines when a later line fails', async () => {
      const ok = await t.addProduct({ name: 'أ' });
      const okBatch = await t.addBatch(ok, { qty: 10 });
      const short = await t.addProduct({ name: 'ب' });
      await t.addBatch(short, { qty: 1 });
      const res = await cashier.post('/api/sales').send({
        items: [{ product_id: ok, quantity: 3 }, { product_id: short, quantity: 2 }], payment_method: 'cash'
      });
      assert.equal(res.status, 409);
      assert.equal(await t.batchQty(okBatch), 10);
      assert.equal(await t.count('sales'), 0);
      assert.equal(await t.count('stock_movements'), 0);
      // The invoice counter is rolled back too, so numbers stay gap-free.
      const next = await cashier.post('/api/sales').send({ items: [{ product_id: ok, quantity: 1 }], payment_method: 'cash' });
      assert.match(next.body.invoice_no, /-000001$/);
    });

    it('never sells from an expired batch', async () => {
      const p = await t.addProduct();
      const expired = await t.addBatch(p, { qty: 50, expiresInDays: -1, batchNo: 'OLD' });
      const res = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash' });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /المتوفر: 0/);
      assert.equal(await t.batchQty(expired), 50);
    });

    it('sells a batch on its expiry date but not the day after', async () => {
      const p = await t.addProduct();
      const b = await t.addBatch(p, { qty: 2, expiresInDays: 0 });
      const res = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash' });
      assert.equal(res.status, 201);
      assert.equal(await t.batchQty(b), 1);
    });

    it('excludes expired batches from product stock', async () => {
      const p = await t.addProduct({ name: 'ستوك', minStock: 5 });
      await t.addBatch(p, { qty: 50, expiresInDays: -10 });
      await t.addBatch(p, { qty: 3, expiresInDays: 30 });
      const res = await cashier.get('/api/products').query({ q: 'ستوك' });
      assert.equal(res.body[0].stock, 3);
      assert.equal(res.body[0].low_stock, true);
      assert.equal(res.body[0].expiring_soon, true);
    });

    it('rejects inactive products', async () => {
      const p = await t.addProduct({ active: false });
      await t.addBatch(p, { qty: 5 });
      const res = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash' });
      assert.equal(res.status, 400);
    });
  });

  describe('FEFO', () => {
    it('takes from the earliest-expiring batch first and splits across batches', async () => {
      const p = await t.addProduct({ price: 1000 });
      // Inserted out of expiry order on purpose.
      const late = await t.addBatch(p, { qty: 10, expiresInDays: 400, cost: 700, batchNo: 'LATE' });
      const early = await t.addBatch(p, { qty: 3, expiresInDays: 20, cost: 600, batchNo: 'EARLY' });
      const mid = await t.addBatch(p, { qty: 4, expiresInDays: 100, cost: 650, batchNo: 'MID' });
      const expired = await t.addBatch(p, { qty: 9, expiresInDays: -5, batchNo: 'EXPIRED' });

      const res = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 9 }], payment_method: 'cash' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.deepEqual(
        res.body.items.map((i) => [i.batch_no, i.quantity]),
        [['EARLY', 3], ['MID', 4], ['LATE', 2]]
      );
      assert.equal(await t.batchQty(early), 0);
      assert.equal(await t.batchQty(mid), 0);
      assert.equal(await t.batchQty(late), 8);
      assert.equal(await t.batchQty(expired), 9);
      assert.equal(res.body.subtotal, 9000);
      const costs = await t.db.all('SELECT unit_cost FROM sale_items ORDER BY id');
      assert.deepEqual(costs.map((c) => c.unit_cost), [600, 650, 700]);
      assert.equal(await t.count('stock_movements'), 3);
    });
  });

  describe('prescriptions', () => {
    it('blocks a prescription-only product without prescription details', async () => {
      const p = await t.addProduct({ rx: true, name: 'أوگمنتين' });
      await t.addBatch(p, { qty: 5 });
      const res = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /وصفة/);
    });

    it('rejects incomplete prescription details', async () => {
      const p = await t.addProduct({ rx: true });
      await t.addBatch(p, { qty: 5 });
      const res = await cashier.post('/api/sales').send({
        items: [{ product_id: p, quantity: 1, prescription_ref: 'r1' }],
        prescriptions: [rx('r1', { doctor_name: '  ' })],
        payment_method: 'cash'
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /اسم الطبيب/);
    });

    it('stores several prescriptions per sale and links each rx line to its own', async () => {
      const a = await t.addProduct({ rx: true, name: 'أ' });
      const b = await t.addProduct({ rx: true, name: 'ب' });
      const c = await t.addProduct({ name: 'ج' });
      for (const p of [a, b, c]) await t.addBatch(p, { qty: 5 });
      const res = await cashier.post('/api/sales').send({
        items: [
          { product_id: a, quantity: 1, prescription_ref: 'r1' },
          { product_id: b, quantity: 1, prescription_ref: 'r2' },
          { product_id: c, quantity: 1 }
        ],
        prescriptions: [rx('r1', { rx_number: 'RX-1' }), rx('r2', { rx_number: 'RX-2', doctor_name: 'د. سارة' })],
        payment_method: 'cash'
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.prescriptions.length, 2);
      const rxByNo = Object.fromEntries(res.body.prescriptions.map((p) => [p.rx_number, p.id]));
      const line = (pid) => res.body.items.find((i) => i.product_id === pid);
      assert.equal(line(a).prescription_id, rxByNo['RX-1']);
      assert.equal(line(b).prescription_id, rxByNo['RX-2']);
      assert.equal(line(c).prescription_id, null);
    });

    it('rejects a prescription dated in the future or a dangling reference', async () => {
      const p = await t.addProduct({ rx: true });
      await t.addBatch(p, { qty: 5 });
      const future = await cashier.post('/api/sales').send({
        items: [{ product_id: p, quantity: 1, prescription_ref: 'r1' }],
        prescriptions: [rx('r1', { rx_date: '2999-01-01' })], payment_method: 'cash'
      });
      assert.equal(future.status, 400);
      const dangling = await cashier.post('/api/sales').send({
        items: [{ product_id: p, quantity: 1, prescription_ref: 'nope' }],
        prescriptions: [rx('r1')], payment_method: 'cash'
      });
      assert.equal(dangling.status, 400);
    });
  });

  describe('credit sales and discount', () => {
    it('requires a customer for debt sales', async () => {
      const p = await t.addProduct();
      await t.addBatch(p, { qty: 5 });
      const res = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'debt' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /زبون/);
    });

    it('adds the debt sale total to the customer balance', async () => {
      const p = await t.addProduct({ price: 4000 });
      await t.addBatch(p, { qty: 5 });
      const c = await t.addCustomer('حسين', 1000);
      const res = await cashier.post('/api/sales').send({
        items: [{ product_id: p, quantity: 2 }], payment_method: 'debt', customer_id: c, discount_pct: 10
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.discount_amount, 800);
      assert.equal(res.body.total, 7200);
      const cust = await t.db.get('SELECT balance FROM customers WHERE id = ?', [c]);
      assert.equal(cust.balance, 8200);
    });

    it('caps the discount at the admin setting', async () => {
      const p = await t.addProduct();
      await t.addBatch(p, { qty: 5 });
      await t.db.run("UPDATE settings SET setting_value = '5' WHERE setting_key = 'max_discount_pct'");
      const res = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash', discount_pct: 6 });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /5%/);
      const ok = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash', discount_pct: 5 });
      assert.equal(ok.status, 201);
    });
  });

  describe('input validation', () => {
    const cases = [
      ['empty cart', { items: [], payment_method: 'cash' }],
      ['missing items', { payment_method: 'cash' }],
      ['zero quantity', { items: [{ product_id: 1, quantity: 0 }], payment_method: 'cash' }],
      ['fractional quantity', { items: [{ product_id: 1, quantity: 1.5 }], payment_method: 'cash' }],
      ['string product id', { items: [{ product_id: "1 OR 1=1", quantity: 1 }], payment_method: 'cash' }],
      ['bad payment method', { items: [{ product_id: 1, quantity: 1 }], payment_method: 'gold' }],
      ['negative discount', { items: [{ product_id: 1, quantity: 1 }], payment_method: 'cash', discount_pct: -1 }],
      ['duplicate product', { items: [{ product_id: 1, quantity: 1 }, { product_id: 1, quantity: 1 }], payment_method: 'cash' }],
      ['unknown customer', { items: [{ product_id: 1, quantity: 1 }], payment_method: 'cash', customer_id: 999 }]
    ];
    for (const [name, body] of cases) {
      it(`rejects ${name}`, async () => {
        const p = await t.addProduct();
        await t.addBatch(p, { qty: 5 });
        const res = await cashier.post('/api/sales').send(body);
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.ok(res.body.error);
        assert.equal(await t.count('sales'), 0);
      });
    }

    it('rejects malformed JSON with an Arabic message', async () => {
      const res = await cashier.post('/api/sales').set('Content-Type', 'application/json').send('{bad');
      assert.equal(res.status, 400);
      assert.match(res.body.error, /غير صالحة/);
    });

    it('treats SQL in search text as plain text', async () => {
      await t.addProduct({ name: 'بنادول' });
      const res = await cashier.get('/api/products').query({ q: "%' OR 1=1 --" });
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 0);
      const wildcard = await cashier.get('/api/products').query({ q: '%' });
      assert.equal(wildcard.body.length, 0);
    });
  });

  it('serializes concurrent checkouts so the last units are never oversold', async () => {
    const p = await t.addProduct();
    const b = await t.addBatch(p, { qty: 3 });
    const other = await t.login('cash2', { openShift: true });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? other : cashier)
        .post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash' }))
    );
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 201, 201, 409, 409, 409, 409, 409]);
    assert.equal(await t.batchQty(b), 0);
    const nos = results.filter((r) => r.status === 201).map((r) => r.body.invoice_no);
    assert.equal(new Set(nos).size, 3);
  });

  it('lets cashiers reprint only their own invoices', async () => {
    const p = await t.addProduct();
    await t.addBatch(p, { qty: 5 });
    const sale = await cashier.post('/api/sales').send({ items: [{ product_id: p, quantity: 1 }], payment_method: 'cash' });
    assert.equal((await cashier.get(`/api/sales/${sale.body.id}`)).status, 200);
    const other = await t.login('cash2');
    assert.equal((await other.get(`/api/sales/${sale.body.id}`)).status, 403);
  });

  it('finds products by exact barcode', async () => {
    await t.addProduct({ name: 'باركود', barcode: '2000000000017' });
    const res = await cashier.get('/api/products/barcode/2000000000017');
    assert.equal(res.status, 200);
    assert.equal(res.body.brand_name, 'باركود');
    assert.equal((await cashier.get('/api/products/barcode/200000000001')).status, 404);
  });
});
