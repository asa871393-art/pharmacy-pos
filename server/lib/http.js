'use strict';
// Express 4 does not catch rejected promises; wrap async handlers so errors reach the handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { wrap };
