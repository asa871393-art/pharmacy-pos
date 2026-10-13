'use strict';
const crypto = require('crypto');
const { unauthorized, forbidden } = require('../lib/errors');
const { now } = require('../lib/time');

const COOKIE = 'sid';

// Screens each role can open. The server checks roles on every route; this list only
// drives which navigation links the UI shows.
const PERMISSIONS = {
  admin: ['sales', 'inventory', 'purchases', 'prescriptions', 'reports', 'invoices', 'settings'],
  pharmacist: ['sales', 'inventory', 'purchases', 'prescriptions', 'reports', 'invoices'],
  cashier: ['sales']
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Loads req.user from the session cookie, or responds 401.
function requireAuth(db) {
  return async (req, res, next) => {
    try {
      const token = readCookie(req, COOKIE);
      if (!token || !/^[a-f0-9]{64}$/.test(token)) throw unauthorized();
      const user = await db.get(
        `SELECT u.id, u.username, u.full_name, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
        [hashToken(token), now()]
      );
      if (!user) throw unauthorized('انتهت الجلسة، يرجى تسجيل الدخول مجدداً');
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

const requireRole = (...roles) => (req, res, next) =>
  next(roles.includes(req.user.role) ? undefined : forbidden());

module.exports = { COOKIE, PERMISSIONS, hashToken, readCookie, requireAuth, requireRole };
