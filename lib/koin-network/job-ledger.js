"use strict";

// SHADOW ONLY: no key, broadcast path, automatic chain balance import, or route
// can activate payments. Synthetic grants never become on-chain authority.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { uint, DAY } = require("./policy");
const { authorizeHash, resultHash, signatureMatches, hash, digest, integer, address } = require("./metering");
const copy = (v) => structuredClone(v);
class ShadowJobs {
  constructor(dataDir, { domain, meter, clock = Date.now, authorizeDelegated = null } = {}) {
    if (typeof domain !== "string" || !/^shadow:[a-zA-Z0-9._-]{1,100}$/.test(domain) || !meter) throw Error("Explicit shadow domain and meter required");
    this.domain = domain; this.meter = meter; this.clock = clock;
    this.authorizeDelegated = authorizeDelegated;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, "koin-shadow-jobs.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS target (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS jobs_session ON jobs(session);
        CREATE TABLE IF NOT EXISTS quotes (hash TEXT PRIMARY KEY, data TEXT NOT NULL);`);
      this.tx(() => {
        const old = this.db.prepare("SELECT data FROM meta WHERE id=1").get();
        const expected = JSON.stringify({ schema: 1, mode: "shadow", domain });
        if (old && old.data !== expected) throw Error("Ledger domain/schema mismatch");
        if (!old && ["grants", "jobs", "quotes"].some((table) => this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) throw Error("Missing ledger identity");
        if (!old) this.db.prepare("INSERT INTO meta VALUES (1, ?)").run(expected);
      });
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Corrupt ledger");
    } catch (e) { this.db.close(); throw e; }
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const v = fn(); this.db.exec("COMMIT"); return v; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  get(table, id) {
    if (!["grants", "jobs", "quotes"].includes(table)) throw Error("Invalid table");
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE ${table === "quotes" ? "hash" : "id"}=?`).get(id);
    if (!row) throw Error("Unknown " + table);
    return JSON.parse(row.data);
  }
  putJob(j) {
    this.db.prepare("UPDATE jobs SET state=?, data=? WHERE id=?").run(j.state, JSON.stringify(j), j.id);
    return copy(j);
  }
  putGrant(g) { this.db.prepare("UPDATE grants SET data=? WHERE id=?").run(JSON.stringify(g), g.id); }
  bindTarget(target) {
    // A shadow ledger cannot reinterpret its pending transactions on a new
    // chain/contract after restart. The monitor validates these pin fields.
    const data = JSON.stringify(target);
    this.tx(() => {
      const old = this.db.prepare("SELECT data FROM target WHERE id=1").get();
      if (old && old.data !== data) throw Error("Settlement target changed");
      if (!old) this.db.prepare("INSERT INTO target VALUES (1, ?)").run(data);
    });
  }
  now() { return integer(this.clock()); }
  quote(model, version, messages, maxOutput) {
    const q = this.meter.quote(this.domain, model, version, messages, maxOutput, this.now());
    this.db.prepare("INSERT OR IGNORE INTO quotes VALUES (?, ?)").run(q.hash, JSON.stringify(q));
    return copy(q);
  }
  // Operator/in-process fixture API; this is NOT proof of a funded chain grant.
  importSimulationGrant(input) {
    const g = copy(input), at = this.now();
    if (Object.keys(g).sort().join() !== "amount,expires,id,maxJobs,owner,perJob,policyHash") throw Error("Invalid simulation grant");
    digest(g.id); digest(g.policyHash); address(g.owner);
    if (g.policyHash !== this.meter.policyHash) throw Error("Grant tariff policy mismatch");
    if (!uint(g.amount) || !uint(g.perJob) || uint(g.perJob) > uint(g.amount)) throw Error("Invalid spending limits");
    integer(g.maxJobs, 1, 10000); integer(g.expires, at + 1, at + DAY);
    Object.assign(g, { mode: "shadow", openedAt: at, settleUntil: g.expires + DAY,
      revokedAt: null, nonce: "0", spent: "0", settledJobs: 0 });
    this.db.prepare("INSERT INTO grants VALUES (?, ?)").run(g.id, JSON.stringify(g));
    return copy(g);
  }
  exposure(g) {
    let held = 0n, jobs = 0;
    for (const row of this.db.prepare("SELECT data FROM jobs WHERE session=? AND state NOT IN ('cancelled','settled')").all(g.id)) {
      const j = JSON.parse(row.data); held += uint(j.hold); jobs++;
    }
    return { held, jobs, available: uint(g.amount) - uint(g.spent) - held };
  }
  reserve({ id, session, quoteHash, signature }) {
    return this._reserve({ id, session, quoteHash }, g => {
      signatureMatches(authorizeHash(this.domain, session, id, quoteHash), signature, g.owner);
      return { requestSignature: signature };
    });
  }
  // Synthetic account-grant rehearsal only. No service key impersonates the
  // consumer: record the existing delegated authority instead of forging a
  // per-job wallet signature. Only the trusted binding resolver can admit it.
  reserveDelegated({ id, session, quoteHash, accountId, grantId }) {
    return this._reserve({ id, session, quoteHash }, (g, q) => {
      if (typeof this.authorizeDelegated !== "function") throw Error("Delegated shadow grants are disabled");
      const authority = this.authorizeDelegated({ accountId, grantId, session, owner: g.owner, quote: q });
      if (!authority || authority.mode !== "shadow") throw Error("Delegated shadow grant required");
      return { delegatedAuthorization: authority };
    });
  }
  _reserve({ id, session, quoteHash }, authorize) {
    digest(id); digest(session); digest(quoteHash);
    return this.tx(() => {
      const g = this.get("grants", session), q = this.get("quotes", quoteHash), at = this.now();
      if (q.policyHash !== g.policyHash) throw Error("Quote outside authorized tariff policy");
      const authority = authorize(g, q);
      const old = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
      if (old) {
        const j = JSON.parse(old.data);
        if (j.session !== session || j.quote.hash !== quoteHash) throw Error("Job ID reused with different intent");
        if (JSON.stringify(j.delegatedAuthorization) !== JSON.stringify(authority.delegatedAuthorization)) throw Error("Job authority changed");
        return j;
      }
      if (g.revokedAt !== null || at < g.openedAt || at >= g.expires || at < q.at || at >= q.expires) throw Error("Expired or revoked authorization");
      const x = this.exposure(g), hold = uint(q.maxCharge);
      if (hold > uint(g.perJob) || hold > x.available || x.jobs + g.settledJobs >= g.maxJobs) throw Error("Spending limit");
      const j = { id, session, mode: "shadow", state: "reserved", quote: q,
        hold: hold.toString(), reservedAt: at, ...authority };
      this.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(id, session, j.state, JSON.stringify(j));
      return copy(j);
    });
  }
  dispatch(id, provider) {
    address(provider);
    return this.tx(() => {
      const j = this.get("jobs", id), g = this.get("grants", j.session), at = this.now();
      if (j.state !== "reserved") throw Error("Job already dispatched or closed");
      if (provider === g.owner) throw Error("Self-served work is ineligible");
      if (g.revokedAt !== null || at < j.reservedAt || at >= g.expires || at >= j.quote.expires) throw Error("Expired or revoked dispatch");
      Object.assign(j, { state: "dispatched", provider, dispatchedAt: at,
        deadline: Math.min(at + j.quote.tariff.maxLatencyMs, g.settleUntil), attempt: crypto.randomBytes(32).toString("hex") });
      return this.putJob(j);
    });
  }
  complete(id, { output, signature }, { accepted } = {}) {
    // accepted is a master-observed SLA/challenge decision, never a body field.
    return this.tx(() => {
      const j = this.get("jobs", id), g = this.get("grants", j.session), at = this.now();
      if (j.state !== "dispatched") throw Error("Job is not awaiting a result");
      if (at < j.dispatchedAt || at > j.deadline || at > g.settleUntil ||
          (g.revokedAt !== null && j.dispatchedAt >= g.revokedAt) || accepted !== true) throw Error("Unaccepted or expired work");
      const signed = resultHash(this.domain, j.id, j.attempt, j.quote.hash, output);
      signatureMatches(signed, signature, j.provider);
      const usage = this.meter.measure(j.quote, output);
      if (uint(usage.amount) > uint(j.hold)) throw Error("Charge exceeds reservation");
      const receipt = { schema: 1, mode: "shadow", domain: this.domain, job: j.id,
        session: j.session, owner: g.owner, provider: j.provider, attempt: j.attempt,
        quoteHash: j.quote.hash, policyHash: g.policyHash, outputHash: hash(output),
        signature, dispatchedAt: j.dispatchedAt, completedAt: at, usage };
      // Prompts and output are intentionally not persisted.
      Object.assign(j, { state: "verified", hold: usage.amount, receipt,
        receiptHash: hash(JSON.stringify(receipt)) });
      return this.putJob(j);
    });
  }
  cancel(id) {
    return this.tx(() => {
      const j = this.get("jobs", id);
      // A result and cancellation race under the same write transaction.
      // Once verified/prepared, disconnects cannot silently unreserve it.
      if (j.state === "cancelled") return j;
      if (!["reserved", "dispatched"].includes(j.state)) throw Error("Verified or uncertain work stays reserved");
      j.state = "cancelled"; j.hold = "0"; return this.putJob(j);
    });
  }
  revoke(session) {
    return this.tx(() => {
      const g = this.get("grants", session);
      if (g.revokedAt === null) {
        g.revokedAt = this.now(); g.settleUntil = Math.min(g.settleUntil, g.revokedAt + DAY); this.putGrant(g);
      }
      return copy(g);
    });
  }
  prepare(id) {
    return this.tx(() => {
      const j = this.get("jobs", id), g = this.get("grants", j.session);
      if (["prepared", "submitted", "settled"].includes(j.state)) return copy(j.intent);
      if (j.state !== "verified" || this.now() > g.settleUntil || this.now() < j.receipt.completedAt ||
          (g.revokedAt !== null && j.dispatchedAt >= g.revokedAt)) throw Error("Not eligible for settlement");
      if (this.db.prepare("SELECT id FROM jobs WHERE session=? AND state IN ('prepared','submitted')").get(g.id)) throw Error("Previous settlement still uncertain");
      // Only one unresolved nonce per session. A dropped HTTP response cannot
      // cause another job to reuse the nonce or a retry to create a new charge.
      j.intent = { mode: "shadow", domain: this.domain, charge: { id: j.id, session_id: j.session,
        provider: j.provider, policy_hash: g.policyHash, receipt_hash: j.receiptHash,
        amount: j.receipt.usage.amount, dispatched_at: String(j.dispatchedAt), nonce: uint(uint(g.nonce) + 1n).toString() } };
      j.intentHash = hash(JSON.stringify(j.intent)); j.state = "prepared";
      this.putJob(j); return copy(j.intent);
    });
  }
  markSubmitted(id, txId) {
    if (typeof txId !== "string" || !/^0x1220[a-f0-9]{64}$/.test(txId)) throw Error("Invalid transaction ID");
    return this.tx(() => {
      const j = this.get("jobs", id);
      if (!["prepared", "submitted"].includes(j.state)) throw Error("No prepared intent");
      if (j.txId && j.txId !== txId) throw Error("Cannot replace an uncertain transaction");
      j.state = "submitted"; j.txId = txId; return this.putJob(j);
    });
  }
  // Recovery fixture only. The real chain reconciler must additionally bind
  // the exact settle operation and funded grant. No API calls this method.
  confirmSimulation(id, intentHash, evidence = null) {
    return this.tx(() => {
      const j = this.get("jobs", id), g = this.get("grants", j.session);
      if (j.intentHash !== digest(intentHash) || !["submitted", "settled"].includes(j.state)) throw Error("Settlement intent mismatch");
      if (j.state === "settled") return j;
      if (j.intent.charge.nonce !== uint(uint(g.nonce) + 1n).toString()) throw Error("Nonce conflict");
      g.spent = uint(uint(g.spent) + uint(j.hold)).toString(); g.nonce = j.intent.charge.nonce; g.settledJobs++;
      j.state = "settled"; j.hold = "0";
      if (evidence) j.finality = copy(evidence);
      this.putGrant(g); return this.putJob(j);
    });
  }
  recover() {
    return this.tx(() => {
      const at = this.now();
      for (const row of this.db.prepare("SELECT data FROM jobs WHERE state IN ('reserved','dispatched')").all()) {
        const j = JSON.parse(row.data), g = this.get("grants", j.session);
        if ((j.state === "reserved" && (g.revokedAt !== null || at >= Math.min(g.expires, j.quote.expires))) ||
            (j.state === "dispatched" && at > Math.min(j.deadline, g.settleUntil))) {
          j.state = "cancelled"; j.hold = "0"; this.putJob(j);
        }
      }
      // Verified and uncertain settlements need explicit reconciliation. A
      // timeout, missing tx, or fork is never proof that a charge did not occur.
      return this.db.prepare("SELECT data FROM jobs WHERE state NOT IN ('cancelled','settled') ORDER BY id").all().map((r) => JSON.parse(r.data));
    });
  }
  status(session) {
    return this.tx(() => {
      const g = this.get("grants", session), x = this.exposure(g);
      return { mode: "shadow", paymentsEnabled: false, id: g.id, owner: g.owner,
        policyHash: g.policyHash, amount: g.amount, perJob: g.perJob,
        maxJobs: g.maxJobs, remainingJobs: g.maxJobs - g.settledJobs - x.jobs,
        openedAt: g.openedAt, expires: g.expires, revokedAt: g.revokedAt, spent: g.spent,
        held: x.held.toString(), available: x.available.toString(), nonce: g.nonce };
    });
  }
  close() { this.db.close(); }
}
module.exports = { ShadowJobs };
