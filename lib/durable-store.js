"use strict";

const fs = require("fs");
const path = require("path");

/*
 * Durable storage for the scheduler's mutable state (phase 1 of
 * docs/durable-ledger-design.md). Two backends behind one interface:
 *
 *  - JsonStore   (KAI_STORE unset or "json" — the DEFAULT): exactly the flat
 *    files the scheduler has always used (credits.json, workers.json,
 *    perf.json, revoked.json, freeday.json, epoch-*.json), all written
 *    atomically (tmp+rename). Deploying the store refactor changes NOTHING
 *    in this mode — the regression suite proves it.
 *
 *  - SqliteStore (KAI_STORE=sqlite): one WAL database (node:sqlite, built
 *    into Node 22 — no native deps) is the AUTHORITY. Ledger objects live in
 *    a kv table, epochs in their own table; grouped writes commit in one
 *    transaction (cross-"file" consistency JSON can never give). On first
 *    open with an empty DB, existing JSON files are imported inside a single
 *    transaction and renamed to *.json.migrated (kept, never deleted).
 *    JSON views of every ledger are re-exported on demand / at epoch close so
 *    the backup/export/shadow-trends tooling — which reads files — keeps
 *    working unchanged; the views are derived, the DB is truth on boot.
 *    Rollback: scripts/db-export.js dumps the DB back to the JSON shapes,
 *    then flip KAI_STORE back.
 *
 * The interface is whole-object per ledger — the same granularity as the
 * files today — so the scheduler's in-memory model is untouched. Per-row
 * normalization is a later optimization, not a correctness need.
 */

const LEDGERS = {
  balances: "credits.json",
  workers: "workers.json",
  perf: "perf.json",
  revoked: "revoked.json",
  freeday: "freeday.json",
};

function atomicWrite(dir, file, data) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class JsonStore {
  constructor(dataDir) {
    this.mode = "json";
    this.dataDir = dataDir;
  }
  _load(name) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.dataDir, LEDGERS[name]), "utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  _save(name, obj) {
    atomicWrite(this.dataDir, path.join(this.dataDir, LEDGERS[name]), JSON.stringify(obj, null, name === "perf" || name === "freeday" ? 0 : 2));
  }
  loadBalances() { return this._load("balances"); }
  saveBalances(o) { this._save("balances", o); }
  loadWorkers() { return this._load("workers"); }
  saveWorkers(o) { this._save("workers", o); }
  loadPerf() { return this._load("perf"); }
  savePerf(o) { this._save("perf", o); }
  loadRevoked() { return this._load("revoked"); }
  saveRevoked(o) { this._save("revoked", o); }
  loadFreeDay() { return this._load("freeday"); }
  saveFreeDay(o) { this._save("freeday", o); }

  saveEpoch(epoch, data) {
    atomicWrite(this.dataDir, path.join(this.dataDir, `epoch-${epoch}.json`), JSON.stringify(data, null, 2));
  }
  readEpoch(epoch) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, `epoch-${epoch}.json`), "utf8"));
    } catch {
      return null;
    }
  }
  latestEpochNumber() {
    let latest = null;
    try {
      for (const n of fs.readdirSync(this.dataDir)) {
        const m = n.match(/^epoch-(\d+)\.json$/);
        if (m && (latest == null || Number(m[1]) > latest)) latest = Number(m[1]);
      }
    } catch {
      /* no dir yet */
    }
    return latest;
  }
  listEpochSummaries() {
    const out = [];
    try {
      for (const n of fs.readdirSync(this.dataDir)) {
        if (!/^epoch-\d+\.json$/.test(n)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.dataDir, n), "utf8"));
          if (j.summary) out.push(j.summary);
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* none */
    }
    return out;
  }
  transaction(fn) { return fn(); } // files have no cross-write atomicity — documented json-mode limit
  exportViews() { /* json mode IS the views */ }
  close() { /* nothing to release */ }
}

class SqliteStore {
  constructor(dataDir) {
    const { DatabaseSync } = require("node:sqlite");
    this.mode = "sqlite";
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "kai-store.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS epochs (epoch INTEGER PRIMARY KEY, data TEXT NOT NULL);"
    );
    this._getStmt = this.db.prepare("SELECT v FROM kv WHERE k = ?");
    this._putStmt = this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
    this._epochPut = this.db.prepare("INSERT INTO epochs (epoch, data) VALUES (?, ?) ON CONFLICT(epoch) DO UPDATE SET data = excluded.data");
    this._epochGet = this.db.prepare("SELECT data FROM epochs WHERE epoch = ?");
    this._migrateFromJson();
  }

  _kvGet(k) {
    const row = this._getStmt.get(k);
    if (!row) return null;
    try {
      const v = JSON.parse(row.v);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  _kvPut(k, obj) { this._putStmt.run(k, JSON.stringify(obj)); }

  /** One-time import of the flat-file state, inside a single transaction —
   *  either everything migrates or nothing does. Files become *.json.migrated
   *  (kept for rollback), only after the transaction committed. */
  _migrateFromJson() {
    if (this._kvGet("__meta")) return; // already migrated / born sqlite
    const json = new JsonStore(this.dataDir);
    const found = {};
    for (const name of Object.keys(LEDGERS)) {
      const v = json._load(name);
      if (v) found[name] = v;
    }
    const epochFiles = [];
    try {
      for (const n of fs.readdirSync(this.dataDir)) {
        const m = n.match(/^epoch-(\d+)\.json$/);
        if (m) epochFiles.push(Number(m[1]));
      }
    } catch {
      /* none */
    }
    this.transaction(() => {
      for (const [name, v] of Object.entries(found)) this._kvPut(name, v);
      for (const e of epochFiles) {
        const j = json.readEpoch(e);
        if (j) this._epochPut.run(e, JSON.stringify(j));
      }
      this._kvPut("__meta", { migratedAt: new Date().toISOString(), ledgers: Object.keys(found).length, epochs: epochFiles.length });
    });
    // Rename the sources only AFTER the commit — a crash mid-migration leaves
    // the JSON files untouched and the next boot simply retries.
    for (const name of Object.keys(found)) {
      const f = path.join(this.dataDir, LEDGERS[name]);
      try { fs.renameSync(f, f + ".migrated"); } catch { /* best-effort */ }
    }
    for (const e of epochFiles) {
      const f = path.join(this.dataDir, `epoch-${e}.json`);
      try { fs.renameSync(f, f + ".migrated"); } catch { /* best-effort */ }
    }
  }

  loadBalances() { return this._kvGet("balances"); }
  saveBalances(o) { this._kvPut("balances", o); }
  loadWorkers() { return this._kvGet("workers"); }
  saveWorkers(o) { this._kvPut("workers", o); }
  loadPerf() { return this._kvGet("perf"); }
  savePerf(o) { this._kvPut("perf", o); }
  loadRevoked() { return this._kvGet("revoked"); }
  saveRevoked(o) { this._kvPut("revoked", o); }
  loadFreeDay() { return this._kvGet("freeday"); }
  saveFreeDay(o) { this._kvPut("freeday", o); }

  saveEpoch(epoch, data) { this._epochPut.run(epoch, JSON.stringify(data)); }
  readEpoch(epoch) {
    const row = this._epochGet.get(epoch);
    if (!row) return null;
    try { return JSON.parse(row.data); } catch { return null; }
  }
  latestEpochNumber() {
    const row = this.db.prepare("SELECT MAX(epoch) AS m FROM epochs").get();
    return row && row.m != null ? Number(row.m) : null;
  }
  listEpochSummaries() {
    const out = [];
    for (const row of this.db.prepare("SELECT data FROM epochs ORDER BY epoch").all()) {
      try {
        const j = JSON.parse(row.data);
        if (j.summary) out.push(j.summary);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /** Grouped writes commit or roll back together — the consistency JSON files
   *  cannot provide. Synchronous by design (matches the callers). */
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  }

  /** Re-derive the JSON files from the DB so file-reading tooling (state
   *  backups, operator export, shadow-trends) and the json-mode rollback path
   *  always have current data. Views are derived — the DB stays authority. */
  exportViews() {
    const json = new JsonStore(this.dataDir);
    for (const name of Object.keys(LEDGERS)) {
      const v = this._kvGet(name);
      if (v) json._save(name, v);
    }
    for (const row of this.db.prepare("SELECT epoch, data FROM epochs").all()) {
      try { json.saveEpoch(row.epoch, JSON.parse(row.data)); } catch { /* skip */ }
    }
  }
  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

/** Backend by env (or explicit mode for tests): KAI_STORE=sqlite opts into the
 *  DB; anything else keeps the flat files. */
function openStore(dataDir, mode = process.env.KAI_STORE) {
  return mode === "sqlite" ? new SqliteStore(dataDir) : new JsonStore(dataDir);
}

module.exports = { openStore, JsonStore, SqliteStore };
