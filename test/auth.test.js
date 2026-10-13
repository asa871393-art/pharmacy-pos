'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, PASSWORD } = require('./helpers');

describe('auth and roles', () => {
  let t;
  beforeEach(async () => { t = await setup(); });

  it('rejects unauthenticated API calls', async () => {
    const res = await request(t.app).get('/api/products');
    assert.equal(res.status, 401);
    assert.ok(res.body.error);
  });

  it('rejects a wrong password with a generic message', async () => {
    const res = await request(t.app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
    assert.equal(res.status, 401);
    const unknown = await request(t.app).post('/api/auth/login').send({ username: 'nobody', password: 'x' });
    assert.equal(unknown.body.error, res.body.error);
  });

  it('locks login after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await request(t.app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
    }
    const res = await request(t.app).post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    assert.equal(res.status, 429);
  });

  it('logs in, returns role permissions, and logs out', async () => {
    const agent = await t.login('cash1');
    const me = await agent.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.role, 'cashier');
    assert.deepEqual(me.body.permissions, ['sales']);
    assert.equal(me.body.password_hash, undefined);

    const admin = await (await t.login('admin')).get('/api/auth/me');
    assert.ok(admin.body.permissions.includes('settings'));

    await agent.post('/api/auth/logout');
    assert.equal((await agent.get('/api/auth/me')).status, 401);
  });

  it('sets an httpOnly SameSite=Strict session cookie', async () => {
    const res = await request(t.app).post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it('blocks cashiers from invoice history and returns', async () => {
    const cashier = await t.login('cash1');
    assert.equal((await cashier.get('/api/sales')).status, 403);
    assert.equal((await cashier.post('/api/sales/1/returns').send({})).status, 403);
    assert.equal((await cashier.get('/api/shifts')).status, 403);
  });

  it('rejects deactivated users and their existing sessions', async () => {
    const agent = await t.login('cash1');
    await t.db.run('UPDATE users SET active = 0 WHERE username = ?', ['cash1']);
    assert.equal((await agent.get('/api/auth/me')).status, 401);
    const res = await request(t.app).post('/api/auth/login').send({ username: 'cash1', password: PASSWORD });
    assert.equal(res.status, 401);
  });
});
