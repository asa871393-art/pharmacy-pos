'use strict';
// All timestamps are local pharmacy time (Baghdad), formatted for DATE / DATETIME columns.
const { tzOffsetMinutes } = require('../config');

function local(date = new Date()) {
  return new Date(date.getTime() + tzOffsetMinutes * 60000).toISOString();
}

const now = (date) => local(date).slice(0, 19).replace('T', ' ');
const today = (date) => local(date).slice(0, 10);

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

module.exports = { now, today, addDays, isValidDate };
