'use strict';
// Each test gets a fresh in-memory database with one user per role.
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { now, today, addDays } = require('../server/lib/time');

const PASSWORD = 'pass1234';
const USERS = [
  ['admin', 'المدير', 'admin'],
  ['pharm', 'الصيدلاني', 'pharmacist'],
  ['cash1', 'الكاشير الأول', 'cashier'],
  ['cash2', 'الكاشير الثاني', 'cashier']
];

async function setup() {
  const db = await openDatabase(':memory:');
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const users = {};
  for (const [username, fullName, role] of USERS) {
    const r = await db.run(
      'INSERT INTO users (username, full_name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [username, fullName, hash, role, now()]
    );
    users[username] = r.lastId;
  }
  const app = createApp({ db, logErrors: false });

  // Logged-in supertest agent (keeps the session cookie).
  async function login(username, { openShift = false, openingCash = 0 } = {}) {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
    if (res.status !== 200) throw new Error('login failed: ' + JSON.stringify(res.body));
    if (openShift) {
      const s = await agent.post('/api/shifts/open').send({ opening_cash: openingCash });
      if (s.status !== 201) throw new Error('open shift failed: ' + JSON.stringify(s.body));
    }
    return agent;
  }

  async function addProduct({ name = 'صنف', price = 1000, rx = false, minStock = 5, active = true, barcode = null } = {}) {
    const ts = now();
    const r = await db.run(
      `INSERT INTO products (brand_name, generic_name, dosage_form, pack_size, barcode, category_id,
                             sale_price, min_stock, requires_rx, active, created_at, updated_at)
       VALUES (?, ?, 'أقراص', '', ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [name, name + ' علمي', barcode, price, minStock, rx ? 1 : 0, active ? 1 : 0, ts, ts]
    );
    return r.lastId;
  }

  // expiresInDays may be negative for an already-expired batch.
  async function addBatch(productId, { qty, expiresInDays = 365, cost = 500, batchNo = 'B' } = {}) {
    const r = await db.run(
      `INSERT INTO batches (product_id, batch_no, expiry_date, quantity, unit_cost, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [productId, batchNo, addDays(today(), expiresInDays), qty, cost, now()]
    );
    return r.lastId;
  }

  async function addCustomer(name = 'زبون', balance = 0) {
    const r = await db.run('INSERT INTO customers (name, phone, balance, created_at) VALUES (?, NULL, ?, ?)',
      [name, balance, now()]);
    return r.lastId;
  }

  const batchQty = async (id) => (await db.get('SELECT quantity FROM batches WHERE id = ?', [id])).quantity;
  const count = async (table) => (await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n;

  return { db, app, users, login, addProduct, addBatch, addCustomer, batchQty, count };
}

module.exports = { setup, PASSWORD };
