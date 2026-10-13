'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { seedDatabase, testBarcode, ADMIN } = require('../scripts/seed');

describe('seed', () => {
  it('loads the data.js sample data and a working admin login', async () => {
    const db = await openDatabase(':memory:');
    await seedDatabase(db);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM products')).n, 8);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM categories')).n, 6);

    const agent = request.agent(createApp({ db, logErrors: false }));
    const login = await agent.post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password });
    assert.equal(login.status, 200);
    assert.equal(login.body.role, 'admin');

    const products = (await agent.get('/api/products')).body;
    const panadol = products.find((p) => p.brand_name === 'بنادول 500');
    assert.equal(panadol.stock, 48);
    assert.equal(panadol.dosage_form, 'أقراص');
    assert.equal(panadol.pack_size, '24 قرص');
    assert.equal(panadol.barcode, testBarcode(1));
    assert.equal(products.find((p) => p.brand_name === 'سيتريزين 10').stock, 0);
    const omeprazole = products.find((p) => p.brand_name === 'أوميبرازول 20');
    const batch = await db.get('SELECT expiry_date FROM batches WHERE product_id = ?', [omeprazole.id]);
    assert.equal(batch.expiry_date, '2026-11-30');
    assert.equal(products.find((p) => p.brand_name === 'أوگمنتين 1غ').requires_rx, true);

    await assert.rejects(seedDatabase(db), /بيانات بالفعل/);
  });

  it('generates valid EAN-13 barcodes', () => {
    assert.equal(testBarcode(1), '2000000000015');
    assert.equal(testBarcode(1).length, 13);
  });
});
