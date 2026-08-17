"use strict";

/*
 * Rollback / inspection tool for the sqlite store (docs/durable-ledger-design.md).
 *
 *   node scripts/db-export.js /var/lib/koinos/scheduler
 *
 * Re-derives every JSON ledger file from kai-store.sqlite, then RETIRES the
 * database (renamed *.rolledback, along with its -wal/-shm) so that:
 *  - json mode boots from the freshly exported, current state, and
 *  - a LATER re-enable of KAI_STORE=sqlite re-migrates from the then-current
 *    JSON instead of silently resurrecting this stale DB (review finding:
 *    that resurrection would re-credit spent deposits and erase newer state).
 *
 * Run with the service STOPPED:
 *   systemctl stop koinos
 *   node scripts/db-export.js /var/lib/koinos/scheduler
 *   # set KAI_STORE=json (or remove the line) in the env file
 *   systemctl start koinos
 */

const fs = require("fs");
const path = require("path");
const { SqliteStore } = require("../lib/durable-store");

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/db-export.js <scheduler-data-dir>");
  process.exit(2);
}
const dbPath = path.join(dir, "kai-store.sqlite");
if (!fs.existsSync(dbPath)) {
  // Refuse rather than let SqliteStore CREATE a db here and "migrate" the
  // json-mode ledgers into it (review finding) — that would be a cutover,
  // not an export.
  console.error(`no ${dbPath} — this directory is not in sqlite mode; nothing to export`);
  process.exit(1);
}
const store = new SqliteStore(dir);
store.exportViews();
store.close();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const suffix of ["", "-wal", "-shm"]) {
  const f = dbPath + suffix;
  if (fs.existsSync(f)) fs.renameSync(f, `${f}.rolledback-${stamp}`);
}
console.log(`exported JSON views from kai-store.sqlite into ${dir}`);
console.log(`database retired as kai-store.sqlite.rolledback-${stamp} — json mode now owns the state`);
