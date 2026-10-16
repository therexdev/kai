"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { JournalSet } = require("./journal-set");
const P = require("./job-protocol"), { uint } = require("./policy");
const { fundedResultHash } = require("./funded-protocol");
const copy = value => structuredClone(value);
const ACTIVE = new Set(["queued", "running", "ready"]);
// One durable database transaction owns each balance change, answer receipt and
// settlement outbox record. Chain settlement never participates in admission.
class PrepaidLedger {
  constructor(directory, { target, meter, encryptionKey, clock = Date.now, waitMs = 180000 }) {
    this.target = require("./session-delegation").target(target); this.meter = meter; this.clock = clock;
    P.integer(waitMs, 1000, 300000); this.waitMs = waitMs;
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw Error("Private prepaid answer encryption key required");
    this.key = Buffer.from(encryptionKey);
    this.guard = new JournalSet(directory, { files: ["prepaid.sqlite"] });
    try {
      const file = path.join(directory, "prepaid.sqlite"); this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS purchases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts(owner TEXT PRIMARY KEY,purchased TEXT NOT NULL,spent TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner);
        CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);`);
      this.guard.attach(this.db);
      const identity = JSON.stringify({ schema: 1, product: "prepaid-v1", target, keyId: P.hash(encryptionKey) });
      const old = this.db.prepare("SELECT data FROM identity WHERE id=1").get();
      if (old && old.data !== identity) throw Error("Prepaid ledger identity changed");
      if (!old) this.write(() => this.db.prepare("INSERT INTO identity VALUES(1,?)").run(identity));
      // Prompts live in memory. An interrupted, unfinished attempt is free.
      this.write(() => { for (const j of this.activeJobs()) if (j.state === "queued" || j.state === "running") this.put({ ...j, state: "cancelled", reason: "service_restarted" }); });
    } catch (e) { this.db?.close(); this.guard.close(); throw e; }
  }
  write(fn) { return this.guard.write(this.db, fn); }
  jobs() { return this.db.prepare("SELECT data FROM jobs ORDER BY rowid").all().map(r => JSON.parse(r.data)); }
  activeJobs() { return this.db.prepare("SELECT data FROM jobs WHERE state IN ('queued','running','ready')").all().map(r => JSON.parse(r.data)); }
  usage(owner) { return this.db.prepare("SELECT data FROM jobs WHERE owner=? AND state='charged' ORDER BY rowid DESC LIMIT 50").all(owner).map(r => JSON.parse(r.data)); }
  job(id, owner) {
    const r = this.db.prepare("SELECT owner,data FROM jobs WHERE id=?").get(P.digest(id));
    if (r && owner !== undefined && r.owner !== owner) throw Error("Request belongs to another account");
    return r ? JSON.parse(r.data) : null;
  }
  put(j) { this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data").run(j.id, j.owner, j.state, JSON.stringify(j)); return copy(j); }
  account(owner) { return this.db.prepare("SELECT purchased,spent FROM accounts WHERE owner=?").get(owner) || { purchased: "0", spent: "0" }; }
  sweepInTransaction() {
    const now = this.clock();
    for (const j of this.activeJobs()) {
      if (ACTIVE.has(j.state) && now >= j.expires) this.put({ ...j, state: "cancelled", reason: "request_expired", hold: "0", answer: null });

    }
  }
  sweep() { if (this.activeJobs().some(j => this.clock() >= j.expires)) this.write(() => this.sweepInTransaction()); }
  pruneAnswers() {
    const rows = this.db.prepare("SELECT data FROM jobs WHERE state='charged' AND json_extract(data,'$.answer') IS NOT NULL AND json_extract(data,'$.answerExpires')<=? LIMIT 64").all(this.clock());
    if (rows.length) this.write(() => { for (const r of rows) this.put({ ...JSON.parse(r.data), answer: null }); });
  }
  balance(owner) {
    this.sweep(); const a = this.account(owner);
    const held = this.activeJobs().filter(j => j.owner === owner).reduce((n, j) => n + uint(j.hold), 0n);
    const available = uint(a.purchased) - uint(a.spent) - held;
    if (available < 0n) throw Error("Credit accounting invariant failed");
    return { purchased: a.purchased, spent: a.spent, available: String(available), held: String(held) };
  }
  purchase(id) { const r = this.db.prepare("SELECT data FROM purchases WHERE id=?").get(id); return r ? JSON.parse(r.data) : null; }
  queuePurchase(id, owner) {
    if (!/^0x1220[a-f0-9]{64}$/.test(id)) throw Error("Invalid purchase transaction");
    return this.write(() => {
      const old = this.purchase(id); if (old && old.owner !== owner) throw Error("Purchase belongs to another account"); if (old) return old;
      if (this.purchases(owner).filter(p => p.state === "pending").length >= 8) throw Error("Purchase confirmation queue is full");
      const p = { id, owner, state: "pending", createdAt: this.clock() };
      this.db.prepare("INSERT INTO purchases VALUES(?,?,?,?)").run(id, owner, p.state, JSON.stringify(p)); return p;
    });
  }
  purchases(owner) { return this.db.prepare("SELECT data FROM purchases WHERE owner=? ORDER BY rowid DESC").all(owner).map(r => JSON.parse(r.data)); }
  pendingPurchases() { return this.db.prepare("SELECT data FROM purchases WHERE state='pending' LIMIT 64").all().map(r => JSON.parse(r.data)); }
  confirmPurchase(id, proof) {
    // Only the in-process observer calls this, never an HTTP-supplied amount.
    return this.write(() => {
      const p = this.purchase(id); if (!p) throw Error("Unknown purchase");
      if (p.state === "confirmed") return p;
      if (proof.state !== "finalized" || proof.txId !== id || proof.owner !== p.owner || !uint(proof.amount)) throw Error("Finalized purchase evidence required");
      const a = this.account(p.owner), purchased = String(uint(uint(a.purchased) + uint(proof.amount)));
      this.db.prepare("INSERT INTO accounts VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET purchased=excluded.purchased").run(p.owner, purchased, a.spent);
      Object.assign(p, { state: "confirmed", amount: proof.amount, proof, confirmedAt: this.clock() });
      this.db.prepare("UPDATE purchases SET state=?,data=? WHERE id=?").run(p.state, JSON.stringify(p), id); return p;
    });
  }
  rejectPurchase(id, reason) { return this.write(() => { const p = this.purchase(id); if (!p || p.state !== "pending") return p; p.state = "failed"; p.reason = reason; this.db.prepare("UPDATE purchases SET state=?,data=? WHERE id=?").run(p.state, JSON.stringify(p), id); return p; }); }
  reserve({ id, owner, model, version, messages, maxOutput }) {
    P.digest(id); const requestHash = P.hash(JSON.stringify({ model, version, messages: P.messages(messages), maxOutput }));
    return this.write(() => {
      this.sweepInTransaction(); const old = this.job(id, owner);
      if (old) { if (old.requestHash !== requestHash) throw Error("Request ID already used for another message"); return old; }
      const quote = this.meter.quote(this.target.domain, model, version, messages, maxOutput, this.clock());
      const a = this.account(owner), held = this.activeJobs().filter(j => j.owner === owner).reduce((n, j) => n + uint(j.hold), 0n);
      if (uint(quote.maxCharge) > uint(a.purchased) - uint(a.spent) - held) throw Error("Not enough credits. Buy credits to continue.");
      if (this.activeJobs().length >= 32) throw Error("The network is busy. Please try again.");
      return this.put({ id, owner, requestHash, quote, state: "queued", hold: quote.maxCharge, createdAt: this.clock(),
        expires: this.clock() + this.waitMs, session: P.hash("prepaid-account:" + owner) });
    });
  }
  dispatch(id, provider) {
    return this.write(() => {
      this.sweepInTransaction(); const j = this.job(id);
      if (!j || j.state !== "queued" || j.owner === provider || this.busy(provider)) throw Error("Request unavailable");
      return this.put({ ...j, state: "running", provider, attempt: crypto.randomBytes(32).toString("hex"), dispatchedAt: this.clock(), deadline: Math.min(j.expires, this.clock() + j.quote.tariff.maxLatencyMs) });
    });
  }
  encrypt(id, value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv); cipher.setAAD(Buffer.from(id));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
  }
  decrypt(id, value) { const b = Buffer.from(value, "base64"), cipher = crypto.createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12)); cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString()); }
  complete(id, { output, signature }, accepted) {
    return this.write(() => {
      this.sweepInTransaction(); const j = this.job(id);
      if (j && ["ready", "charged"].includes(j.state) && j.receipt.outputHash === P.hash(output) && j.receipt.signature === signature) return j;
      if (!j || j.state !== "running" || this.clock() > j.deadline || accepted !== true) throw Error("Request expired or result rejected; no charge");
      P.signatureMatches(fundedResultHash(this.target, j, output), signature, j.provider);
      const usage = this.meter.measure(j.quote, output);
      if (uint(usage.amount) > uint(j.hold)) throw Error("Result exceeds quoted credit limit");
      const receipt = { product: "prepaid-v1", job: j.id, owner: j.owner, provider: j.provider, attempt: j.attempt,
        quoteHash: j.quote.hash, outputHash: P.hash(output), signature, dispatchedAt: j.dispatchedAt, completedAt: this.clock(), usage };
      return this.put({ ...j, state: "ready", hold: usage.amount, receipt, receiptHash: P.hash(JSON.stringify(receipt)),
        answer: this.encrypt(id, output), answerExpires: this.clock() + 7 * 86400000 });
    });
  }
  acknowledge(id, owner, receiptHash) {
    return this.write(() => {
      this.sweepInTransaction(); const j = this.job(id, owner);
      if (!j || j.receiptHash !== P.digest(receiptHash)) throw Error("Answer receipt mismatch");
      if (j.state === "charged") return j;
      if (j.state !== "ready") throw Error("Request expired without a charge");
      const a = this.account(owner), spent = String(uint(uint(a.spent) + uint(j.receipt.usage.amount)));
      if (uint(spent) > uint(a.purchased)) throw Error("Credit accounting invariant failed");
      this.db.prepare("UPDATE accounts SET spent=? WHERE owner=?").run(spent, owner);
      return this.put({ ...j, state: "charged", hold: "0", chargedAt: this.clock(), settlement: { state: "queued", attempts: 0 } });
    });
  }
  cancel(id, owner, reason = "stopped") {
    return this.write(() => { const j = this.job(id, owner); if (!j || !ACTIVE.has(j.state)) return j; return this.put({ ...j, state: "cancelled", hold: "0", answer: null, reason }); });
  }
  busy(provider) { return this.activeJobs().some(j => j.provider === provider && j.state === "running" && j.deadline > this.clock()); }
  pendingJobs() { return this.jobs().filter(j => j.state === "charged" && j.settlement.state !== "finalized"); }
  settledJobs() { return this.jobs().filter(j => j.state === "charged" && j.settlement.state === "finalized"); }
  settlement(id, patch) { return this.write(() => { const j = this.job(id); if (j?.state !== "charged") throw Error("Only consumed credits can settle"); return this.put({ ...j, settlement: { ...j.settlement, ...patch }, ...(patch.finality ? { finality: patch.finality } : {}) }); }); }
  ping() { this.db.prepare("SELECT 1 FROM identity WHERE id=1").get(); }
  close() { this.db.close(); this.guard.close(); this.key.fill(0); }
}
module.exports = { PrepaidLedger };
