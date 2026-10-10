#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { snapshot, hash } = require("../lib/kai-earned-snapshot");
const { FILE, load } = require("../lib/legacy-reward-cutoff");
function readJson(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 100000000) throw Error("Expected a bounded regular snapshot source");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function readRecords(directory, mode) {
  if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw Error("Absolute backup directory required");
  if (mode === "sqlite") {
    const { DatabaseSync } = require("node:sqlite");
    // Unlike openStore, this cannot create, migrate or export a database.
    const db = new DatabaseSync(path.join(directory, "kai-store.sqlite"), { readOnly: true });
    try {
      db.exec("BEGIN");
      if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Damaged scheduler database");
      return db.prepare("SELECT epoch,data FROM epochs ORDER BY epoch").all().map(row => {
        const record = JSON.parse(row.data);
        if (record.epoch !== row.epoch) throw Error("Database epoch key mismatch");
        return record;
      });
    } finally { db.close(); }
  }
  if (mode !== "json") throw Error("Explicit --store json or sqlite required");
  if (fs.existsSync(path.join(directory, "kai-store.sqlite"))) throw Error("SQLite exists; do not snapshot potentially stale JSON views");
  return fs.readdirSync(directory).filter(n => /^epoch-\d+\.json$/.test(n)).map(n => {
    const record = readJson(path.join(directory, n));
    if (n !== `epoch-${record.epoch}.json`) throw Error("Epoch filename mismatch");
    return record;
  });
}
function write(directory, value) {
  if (!path.isAbsolute(directory)) throw Error("Absolute new output directory required");
  fs.mkdirSync(directory, { mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + "\n";
  fs.writeFileSync(path.join(directory, "snapshot.json"), text, { mode: 0o600, flag: "wx" });
  const sha256 = hash(text);
  fs.writeFileSync(path.join(directory, "snapshot.sha256"), sha256 + "\n", { mode: 0o600, flag: "wx" });
  return sha256;
}
function main() {
  const opts = {}, args = process.argv.slice(2), keys = ["backup", "store", "first-epoch", "final-epoch", "out", "chain-balances"];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith("--") || !keys.includes(key) || args[i + 1] === undefined || key in opts) throw Error("Use --backup DIR --store json|sqlite --first-epoch N --final-epoch N --out NEW_DIR [--chain-balances FILE]");
    opts[key] = args[i + 1];
  }
  for (const key of keys.slice(0, 5)) if (!opts[key]) throw Error(`Missing --${key}`);
  for (const key of ["first-epoch", "final-epoch"]) if (!/^(0|[1-9]\d*)$/.test(opts[key])) throw Error("Canonical epoch number required");
  const records = readRecords(opts.backup, opts.store);
  const store = { latestEpochNumber: () => records.reduce((max, r) => Math.max(max, r.epoch), -1), readEpoch: e => records.find(r => r.epoch === e) };
  const cutoff = fs.existsSync(path.join(opts.backup, FILE)) ? load(opts.backup, store) : null;
  const value = snapshot(records, { firstEpoch: Number(opts["first-epoch"]), finalEpoch: Number(opts["final-epoch"]), cutoff,
    chainBalances: opts["chain-balances"] ? readJson(opts["chain-balances"]) : null });
  const sha256 = write(opts.out, value);
  console.log(JSON.stringify({ mode: value.mode, payoutEnabled: false, sha256, wallets: value.rows.length, totals: value.totals, blockers: value.blockers }, null, 2));
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { readRecords, write };
