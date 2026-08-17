"use strict";

/*
 * Rollback / inspection tool for the sqlite store (docs/durable-ledger-design.md).
 *
 *   node scripts/db-export.js /var/lib/koinos/scheduler
 *
 * Re-derives every JSON ledger file (credits.json, workers.json, perf.json,
 * revoked.json, freeday.json, epoch-*.json) from kai-store.sqlite. Run it with
 * the service STOPPED to roll back to json mode:
 *
 *   systemctl stop koinos
 *   node scripts/db-export.js /var/lib/koinos/scheduler
 *   # set KAI_STORE=json (or remove the line) in the env file
 *   systemctl start koinos
 */

const { SqliteStore } = require("../lib/durable-store");

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/db-export.js <scheduler-data-dir>");
  process.exit(2);
}
const store = new SqliteStore(dir);
store.exportViews();
store.close();
console.log(`exported JSON views from kai-store.sqlite into ${dir}`);
