'use strict';
// Server-side input validation. Each helper returns the cleaned value or throws a 400
// with an Arabic message naming the field (label).
const { badRequest } = require('./errors');
const { isValidDate } = require('./time');

const isEmpty = (v) => v === undefined || v === null || v === '';

function int(v, label, { min = 0, max = 1e12, optional = false } = {}) {
  if (isEmpty(v)) {
    if (optional) return null;
    throw badRequest(`${label}: الحقل مطلوب`);
  }
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw badRequest(`${label}: يجب أن يكون عدداً صحيحاً`);
  if (n < min) throw badRequest(`${label}: يجب ألا يقل عن ${min}`);
  if (n > max) throw badRequest(`${label}: يجب ألا يزيد عن ${max}`);
  return n;
}

function num(v, label, { min = 0, max = 1e12, decimals = 2, optional = false } = {}) {
  if (isEmpty(v)) {
    if (optional) return null;
    throw badRequest(`${label}: الحقل مطلوب`);
  }
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw badRequest(`${label}: يجب أن يكون رقماً`);
  if (n < min) throw badRequest(`${label}: يجب ألا يقل عن ${min}`);
  if (n > max) throw badRequest(`${label}: يجب ألا يزيد عن ${max}`);
  const f = 10 ** decimals;
  if (Math.round(n * f) / f !== n) throw badRequest(`${label}: عدد المراتب العشرية كبير`);
  return n;
}

function str(v, label, { max = 255, min = 1, optional = false } = {}) {
  if (isEmpty(v) || (typeof v === 'string' && v.trim() === '')) {
    if (optional) return null;
    throw badRequest(`${label}: الحقل مطلوب`);
  }
  if (typeof v !== 'string') throw badRequest(`${label}: قيمة غير صالحة`);
  const s = v.trim();
  if (s.length < min) throw badRequest(`${label}: قصير جداً`);
  if (s.length > max) throw badRequest(`${label}: يجب ألا يزيد عن ${max} حرفاً`);
  return s;
}

function date(v, label, { optional = false } = {}) {
  if (isEmpty(v)) {
    if (optional) return null;
    throw badRequest(`${label}: الحقل مطلوب`);
  }
  if (!isValidDate(v)) throw badRequest(`${label}: تاريخ غير صالح`);
  return v;
}

function oneOf(v, label, values) {
  if (!values.includes(v)) throw badRequest(`${label}: قيمة غير صالحة`);
  return v;
}

function bool(v, label, { optional = false } = {}) {
  if (isEmpty(v)) {
    if (optional) return null;
    throw badRequest(`${label}: الحقل مطلوب`);
  }
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  throw badRequest(`${label}: قيمة غير صالحة`);
}

function array(v, label, { min = 0, max = 500 } = {}) {
  if (!Array.isArray(v)) throw badRequest(`${label}: يجب أن تكون قائمة`);
  if (v.length < min) throw badRequest(`${label}: القائمة فارغة`);
  if (v.length > max) throw badRequest(`${label}: عدد العناصر كبير جداً`);
  return v;
}

const id = (v, label) => int(v, label, { min: 1, max: 2147483647 });

// Escapes LIKE wildcards so user text is matched literally. Use with ESCAPE '!'
// ('!' rather than backslash, which MySQL treats as an escape inside string literals).
const likePattern = (s) => '%' + String(s).replace(/[!%_]/g, (c) => '!' + c) + '%';

module.exports = { int, num, str, date, oneOf, bool, array, id, likePattern };
