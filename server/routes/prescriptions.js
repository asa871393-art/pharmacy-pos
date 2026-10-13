'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { wrap } = require('../lib/http');
const v = require('../lib/validate');
const { badRequest, forbidden, notFound } = require('../lib/errors');
const { requireRole } = require('../middleware/auth');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

// Identify the image by its first bytes rather than trusting the file name or MIME type.
function imageExtension(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function prescriptionRoutes(db, uploadsDir) {
  const router = express.Router();
  const rxDir = path.join(uploadsDir, 'prescriptions');

  // Admin/pharmacist, or the user who made the sale (so a cashier can attach the image at checkout).
  async function loadAllowed(req) {
    const rx = await db.get(
      `SELECT p.id, p.image_path, s.user_id AS sale_user_id
         FROM prescriptions p JOIN sales s ON s.id = p.sale_id WHERE p.id = ?`,
      [v.id(req.params.id, 'الوصفة')]
    );
    if (!rx) throw notFound('الوصفة غير موجودة');
    if (req.user.role === 'cashier' && rx.sale_user_id !== req.user.id) throw forbidden();
    return rx;
  }

  const resolveImage = (rel) => {
    const full = path.resolve(uploadsDir, rel);
    return full.startsWith(path.resolve(rxDir) + path.sep) ? full : null;
  };

  router.post('/prescriptions/:id/image',
    (req, res, next) => upload.single('image')(req, res, (err) => {
      if (!err) return next();
      next(badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'حجم الصورة يتجاوز 5 ميغابايت' : 'تعذر رفع الصورة'));
    }),
    wrap(async (req, res) => {
      const rx = await loadAllowed(req);
      if (!req.file) throw badRequest('اختر صورة الوصفة');
      const ext = imageExtension(req.file.buffer);
      if (!ext) throw badRequest('صيغة الصورة غير مدعومة (JPG أو PNG أو WEBP)');

      fs.mkdirSync(rxDir, { recursive: true });
      const name = `${rx.id}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(rxDir, name), req.file.buffer);
      await db.run('UPDATE prescriptions SET image_path = ? WHERE id = ?', ['prescriptions/' + name, rx.id]);
      if (rx.image_path) {
        const old = resolveImage(rx.image_path);
        if (old) fs.rmSync(old, { force: true });
      }
      res.status(201).json({ id: rx.id, image_path: 'prescriptions/' + name });
    })
  );

  router.get('/prescriptions/:id/image', wrap(async (req, res) => {
    const rx = await loadAllowed(req);
    const file = rx.image_path && resolveImage(rx.image_path);
    if (!file || !fs.existsSync(file)) throw notFound('لا توجد صورة لهذه الوصفة');
    res.sendFile(file);
  }));

  // Prescription log with the linked invoice and the products dispensed under each prescription.
  router.get('/prescriptions', requireRole('admin', 'pharmacist'), wrap(async (req, res) => {
    const where = [];
    const params = [];
    const q = v.str(req.query.q, 'البحث', { max: 100, optional: true });
    const from = v.date(req.query.from, 'من تاريخ', { optional: true });
    const to = v.date(req.query.to, 'إلى تاريخ', { optional: true });
    if (q) {
      const like = v.likePattern(q);
      where.push(`(p.rx_number LIKE ? ESCAPE '!' OR p.doctor_name LIKE ? ESCAPE '!'
                   OR p.patient_name LIKE ? ESCAPE '!' OR s.invoice_no LIKE ? ESCAPE '!')`);
      params.push(like, like, like, like);
    }
    if (from) { where.push('s.sold_at >= ?'); params.push(from + ' 00:00:00'); }
    if (to) { where.push('s.sold_at <= ?'); params.push(to + ' 23:59:59'); }
    const rows = await db.all(
      `SELECT p.id, p.rx_number, p.doctor_name, p.patient_name, p.rx_date, p.image_path,
              s.id AS sale_id, s.invoice_no, s.sold_at, u.full_name AS user_name
         FROM prescriptions p
         JOIN sales s ON s.id = p.sale_id
         JOIN users u ON u.id = s.user_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY p.id DESC LIMIT 300`,
      params
    );
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const items = await db.all(
        `SELECT si.prescription_id, pr.brand_name, SUM(si.quantity) AS quantity
           FROM sale_items si JOIN products pr ON pr.id = si.product_id
          WHERE si.prescription_id IN (${ids.map(() => '?').join(', ')})
          GROUP BY si.prescription_id, pr.brand_name`,
        ids
      );
      for (const r of rows) {
        r.has_image = !!r.image_path;
        delete r.image_path;
        r.items = items.filter((i) => i.prescription_id === r.id).map((i) => ({ name: i.brand_name, quantity: i.quantity }));
      }
    }
    res.json(rows);
  }));

  return router;
}

module.exports = { prescriptionRoutes, imageExtension };
