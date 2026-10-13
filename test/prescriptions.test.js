'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { setup } = require('./helpers');
const { today } = require('../server/lib/time');

// Smallest valid PNG header + padding is enough for type detection.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe('prescriptions', () => {
  let t, cashier, sale;
  beforeEach(async () => {
    t = await setup();
    cashier = await t.login('cash1', { openShift: true });
    const p = await t.addProduct({ rx: true, name: 'فنتولين' });
    await t.addBatch(p, { qty: 5 });
    const res = await cashier.post('/api/sales').send({
      items: [{ product_id: p, quantity: 1, prescription_ref: 'r1' }],
      prescriptions: [{ ref: 'r1', rx_number: 'RX-55', doctor_name: 'د. زينب', patient_name: 'مريم', rx_date: today() }],
      payment_method: 'cash'
    });
    sale = res.body;
  });

  it('lets the selling cashier attach an image, and stores it under uploads', async () => {
    const rxId = sale.prescriptions[0].id;
    const res = await cashier.post(`/api/prescriptions/${rxId}/image`).attach('image', PNG, 'rx.png');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.image_path, /^prescriptions\/\d+-[a-f0-9]{16}\.png$/);
    assert.ok(fs.existsSync(path.join(t.uploadsDir, res.body.image_path)));

    const img = await cashier.get(`/api/prescriptions/${rxId}/image`);
    assert.equal(img.status, 200);
    assert.match(img.headers['content-type'], /image\/png/);
  });

  it('rejects files that are not images regardless of their name', async () => {
    const rxId = sale.prescriptions[0].id;
    const res = await cashier.post(`/api/prescriptions/${rxId}/image`)
      .attach('image', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' });
    assert.equal(res.status, 400);
  });

  it('forbids other cashiers and unauthenticated users', async () => {
    const rxId = sale.prescriptions[0].id;
    const other = await t.login('cash2');
    assert.equal((await other.post(`/api/prescriptions/${rxId}/image`).attach('image', PNG, 'rx.png')).status, 403);
    assert.equal((await request(t.app).get(`/api/prescriptions/${rxId}/image`)).status, 401);
    // Uploaded files are not reachable as static files.
    assert.equal((await request(t.app).get('/uploads/prescriptions/x.png')).status, 404);
  });

  it('lists prescriptions with the linked invoice and products', async () => {
    const pharm = await t.login('pharm');
    const res = await pharm.get('/api/prescriptions').query({ q: 'زينب' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].invoice_no, sale.invoice_no);
    assert.equal(res.body[0].sale_id, sale.id);
    assert.deepEqual(res.body[0].items, [{ name: 'فنتولين', quantity: 1 }]);
    assert.equal((await cashier.get('/api/prescriptions')).status, 403);
  });
});

describe('frontend files', () => {
  it('serves the app shell, login page and modules with a strict CSP', async () => {
    const t = await setup();
    for (const file of ['/', '/login.html', '/js/main.js', '/js/pages/sales.js', '/css/style.css']) {
      const res = await request(t.app).get(file);
      assert.equal(res.status, 200, file);
    }
    const res = await request(t.app).get('/');
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  });
});
