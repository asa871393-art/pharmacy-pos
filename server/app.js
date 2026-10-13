'use strict';
const express = require('express');
const config = require('./config');
const { wrap } = require('./lib/http');
const { AppError } = require('./lib/errors');
const { getSettings } = require('./lib/settings');
const { requireAuth } = require('./middleware/auth');
const { authRoutes } = require('./routes/auth');
const { catalogRoutes } = require('./routes/catalog');
const { customerRoutes } = require('./routes/customers');
const { shiftRoutes } = require('./routes/shifts');
const { salesRoutes } = require('./routes/sales');
const { prescriptionRoutes } = require('./routes/prescriptions');

function createApp({ db, publicDir = config.publicDir, uploadsDir = config.uploadsDir, logErrors = true }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "frame-ancestors 'none'"
      ].join('; ')
    });
    next();
  });

  const api = express.Router();
  api.use(express.json({ limit: '200kb' }));
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(authRoutes(db));
  api.use(requireAuth(db));
  api.get('/settings', wrap(async (req, res) => res.json(await getSettings(db))));
  api.use(catalogRoutes(db));
  api.use(customerRoutes(db));
  api.use(shiftRoutes(db));
  api.use(salesRoutes(db));
  api.use(prescriptionRoutes(db, uploadsDir));
  api.use((req, res) =>res.status(404).json({ error: 'المسار غير موجود' }));
  app.use('/api', api);

  app.use(express.static(publicDir));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'بيانات الطلب غير صالحة' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'حجم الطلب كبير جداً' });
    if (logErrors) console.error(err);
    res.status(500).json({ error: 'حدث خطأ داخلي في الخادم' });
  });

  return app;
}

module.exports = { createApp };
