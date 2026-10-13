'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { wrap } = require('../lib/http');
const v = require('../lib/validate');
const { AppError, unauthorized } = require('../lib/errors');
const { now } = require('../lib/time');
const config = require('../config');
const { COOKIE, PERMISSIONS, hashToken, readCookie, requireAuth } = require('../middleware/auth');

const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;
// Compared against when the username doesn't exist, so response time doesn't reveal it.
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

function authRoutes(db) {
  const router = express.Router();
  const failures = new Map(); // "ip|username" -> { count, until }

  router.post('/auth/login', wrap(async (req, res) => {
    const body = req.body || {};
    const username = v.str(body.username, 'اسم المستخدم', { max: 50 }).toLowerCase();
    const password = v.str(body.password, 'كلمة المرور', { max: 200 });

    const key = `${req.ip}|${username}`;
    const f = failures.get(key);
    if (f && f.until > Date.now()) {
      throw new AppError(429, 'محاولات كثيرة خاطئة. حاول مجدداً بعد 5 دقائق');
    }

    const user = await db.get(
      'SELECT id, username, full_name, role, password_hash FROM users WHERE username = ? AND active = 1',
      [username]
    );
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      const count = (f ? f.count : 0) + 1;
      failures.set(key, { count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
      throw unauthorized('اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    failures.delete(key);

    const token = crypto.randomBytes(32).toString('hex');
    const ts = now();
    const expires = now(new Date(Date.now() + config.sessionHours * 3600 * 1000));
    await db.run('DELETE FROM sessions WHERE expires_at <= ?', [ts]);
    await db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [hashToken(token), user.id, ts, expires]
    );
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: config.sessionHours * 3600 * 1000
    });
    res.json(publicUser(user));
  }));

  router.post('/auth/logout', wrap(async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }));

  router.get('/auth/me', requireAuth(db), (req, res) => res.json(publicUser(req.user)));

  return router;
}

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  full_name: u.full_name,
  role: u.role,
  permissions: PERMISSIONS[u.role] || []
});

module.exports = { authRoutes };
