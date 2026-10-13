'use strict';
const express = require('express');
const { wrap } = require('../lib/http');
const v = require('../lib/validate');
const { notFound } = require('../lib/errors');
const { requireRole } = require('../middleware/auth');
const { getOpenShift, shiftSummary, openShift, closeShift } = require('../services/shifts');

function shiftRoutes(db) {
  const router = express.Router();

  // The current user's open shift, or null.
  router.get('/shifts/current', wrap(async (req, res) => {
    const shift = await getOpenShift(db, req.user.id);
    res.json(shift ? await shiftSummary(db, shift) : null);
  }));

  router.post('/shifts/open', wrap(async (req, res) => {
    res.status(201).json(await openShift(db, req.user, req.body));
  }));

  router.post('/shifts/current/close', wrap(async (req, res) => {
    res.json(await closeShift(db, req.user, req.body));
  }));

  router.get('/shifts', requireRole('admin', 'pharmacist'), wrap(async (req, res) => {
    const rows = await db.all(
      `SELECT s.*, u.full_name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id
        ORDER BY s.id DESC LIMIT 100`
    );
    res.json(rows);
  }));

  router.get('/shifts/:id', requireRole('admin', 'pharmacist'), wrap(async (req, res) => {
    const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [v.id(req.params.id, 'الوردية')]);
    if (!shift) throw notFound('الوردية غير موجودة');
    res.json(await shiftSummary(db, shift));
  }));

  return router;
}

module.exports = { shiftRoutes };
