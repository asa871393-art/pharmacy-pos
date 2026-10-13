'use strict';
// SQLite adapter. Every module talks to the database only through the async interface
// returned here: all / get / run / transaction / close. A MySQL adapter (mysql2/promise)
// can implement the same five functions without touching routes or services.
//
// better-sqlite3 is synchronous and uses one connection, so all operations go through a
// FIFO queue. While a transaction is running, other requests wait for it to finish instead
// of slipping their statements into it.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function createSqliteDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  if (file !== ':memory:') raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };

  // Direct executor: used inside a transaction (already holding the queue).
  const direct = {
    async all(sql, params = []) { return stmt(sql).all(params); },
    async get(sql, params = []) { return stmt(sql).get(params); },
    async run(sql, params = []) {
      const r = stmt(sql).run(params);
      return { changes: r.changes, lastId: Number(r.lastInsertRowid) };
    }
  };

  let queue = Promise.resolve();
  function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  return {
    dialect: 'sqlite',
    all: (sql, params) => enqueue(() => direct.all(sql, params)),
    get: (sql, params) => enqueue(() => direct.get(sql, params)),
    run: (sql, params) => enqueue(() => direct.run(sql, params)),

    // fn receives an executor with all/get/run. Throwing rolls everything back.
    transaction(fn) {
      return enqueue(async () => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const out = await fn(direct);
          raw.exec('COMMIT');
          return out;
        } catch (err) {
          if (raw.inTransaction) raw.exec('ROLLBACK');
          throw err;
        }
      });
    },

    // Runs a multi-statement script (schema). Not part of the portable interface.
    exec: (sql) => enqueue(async () => raw.exec(sql)),
    close: () => enqueue(async () => raw.close())
  };
}

module.exports = { createSqliteDb };
