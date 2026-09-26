"use strict";

// Funded accounting rehearsal. No worker dispatch, signer, network routes or
// broadcasts. All processes for a deployment MUST share this DB.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { Serializer, utils } = require("koilib");
const ABI = require("./credits-abi.json");
const P = require("./job-protocol");
const { address, Meter } = require("./metering");
const { uint } = require("./policy");
const { FundedSessionObserver } = require("./funded-session");

function reservationHash(target, action, session, id, quoteHash) {
  if (!["reserve", "cancel"].includes(action)) throw Error("Invalid reservation action");
  return Buffer.from(P.hash(JSON.stringify(["KAI-KOIN-FUNDED-RESERVATION-REHEARSAL-V1", target.chainId,
    target.credits, target.creditsHash, target.policyHash, P.domain(target.domain), action,
    P.digest(session), P.digest(id), P.digest(quoteHash)])), "hex");
}
function fundedResultHash(target, job, output) {
  if (typeof output !== "string" || !output.length || Buffer.byteLength(output) > 1048576) throw Error("Invalid result output");
  return Buffer.from(P.hash(JSON.stringify(["KAI-KOIN-FUNDED-RESULT-REHEARSAL-V1", target.chainId, target.credits,
    target.creditsHash, target.policyHash, target.domain, P.digest(job.session), P.digest(job.id),
    P.digest(job.attempt), P.digest(job.quote.hash), P.hash(output)])), "hex");
}
class FundedReservations {
  #db; #observer; #target; #clock; #meter; #accept;
  constructor(directory, { observer, target, meter, accept = null, clock = Date.now }) {
    if (!(observer instanceof FundedSessionObserver)) throw Error("Trusted funded-session observer required");
    if (!target || Object.keys(target).sort().join() !== "chainId,credits,creditsHash,domain,policyHash" ||
        typeof target.chainId !== "string" || !/^0x1220[a-f0-9]{64}$/.test(target.creditsHash)) throw Error("Pinned deployment required");
    address(target.credits); P.domain(target.domain); P.digest(target.policyHash);
    if (!(meter instanceof Meter) || meter.policyHash !== target.policyHash) throw Error("Pinned tariff engine required");
    this.#meter = meter;
    if (accept !== null && typeof accept !== "function") throw Error("Trusted acceptance callback required");
    this.#accept = accept;
    this.#target = Object.freeze({ chainId: target.chainId, credits: target.credits, creditsHash: target.creditsHash,
      policyHash: target.policyHash, domain: target.domain });
    this.#observer = observer; this.#clock = clock;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "funded-reservations.sqlite");
    this.#db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    try {
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS held_session ON holds(session);`);
      this.#tx(() => {
        const expected = JSON.stringify({ schema: 1, mode: "funded-rehearsal", target: this.#target });
        const old = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
        if (old && old.data !== expected) throw Error("Funded ledger deployment mismatch");
        if (!old && ["sessions", "holds", "quotes"].some((table) => this.#db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) throw Error("Missing funded ledger identity");
        if (!old) this.#db.prepare("INSERT INTO identity VALUES (1, ?)").run(expected);
      });
      if (this.#db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Corrupt funded ledger");
    } catch (e) { this.#db.close(); throw e; }
  }
  #tx(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#db.exec("COMMIT"); return result; }
    catch (e) { this.#db.exec("ROLLBACK"); throw e; }
  }
  #get(table, id) {
    return JSON.parse(this.#db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)?.data ?? "null");
  }
  #saveSession(s) { this.#db.prepare("INSERT OR REPLACE INTO sessions VALUES (?, ?)").run(s.id, JSON.stringify(s)); }
  #saveHold(h) { this.#db.prepare("INSERT OR REPLACE INTO holds VALUES (?, ?, ?, ?)").run(h.id, h.session, h.state, JSON.stringify(h)); }
  quote(model, version, messages, maxOutput) {
    const q = P.validateQuote(this.#meter.quote(this.#target.domain, model, version, P.messages(messages), maxOutput, P.integer(this.#clock())));
    this.#db.prepare("INSERT OR IGNORE INTO quotes VALUES (?, ?)").run(q.hash, JSON.stringify(q));
    return structuredClone(q);
  }
  #exposure(id) {
    const holds = this.#db.prepare("SELECT data FROM holds WHERE session=? AND state NOT IN ('cancelled','settled')").all(id);
    return { count: holds.length, held: holds.reduce((n, h) => n + uint(JSON.parse(h.data).amount), 0n) };
  }
  async #evidence(observationId, purpose = "admission") {
    const e = await this.#observer.verify(P.digest(observationId));
    if (e.state !== "verified" || e.purpose !== purpose || e.paymentsEnabled !== false || e.spendingAuthorized !== false) throw Error("Irreversible funding evidence required");
    for (const key of ["chainId", "credits", "creditsHash", "policyHash"]) if (e[key] !== this.#target[key]) throw Error("Funding target mismatch");
    P.digest(e.session); address(e.owner); P.digest(e.stateHash);
    uint(e.remaining); uint(e.perJob); uint(e.remainingJobs); uint(e.nonce); uint(e.expires);
    this.#fresh(e, purpose); return e;
  }
  #fresh(e, purpose = "admission") {
    const now = P.integer(this.#clock());
    if (!Number.isSafeInteger(e.checkedAt) || now < e.checkedAt || now - e.checkedAt > 5000 || (purpose === "admission" && BigInt(now) >= uint(e.expires))) throw Error("Stale funding evidence");
  }
  #sync(e) {
    this.#fresh(e);
    let s = this.#get("sessions", e.session);
    if (s?.blocked) return { error: "Session requires reconciliation" };
    if (s && (s.owner !== e.owner || s.remaining !== e.remaining || s.nonce !== e.nonce ||
        s.remainingJobs !== e.remainingJobs || s.perJob !== e.perJob || s.expires !== e.expires)) {
      // Persist the freeze, then throw OUTSIDE the transaction so rollback cannot erase it.
      s.blocked = true; s.reason = "chain_state_changed"; this.#saveSession(s);
      return { error: "On-chain session changed; reconciliation required" };
    }
    s = { id: e.session, owner: e.owner, remaining: e.remaining, perJob: e.perJob, remainingJobs: e.remainingJobs,
      nonce: e.nonce, expires: e.expires, blocked: false, evidence: e };
    this.#saveSession(s); return { session: s };
  }
  async reserve({ id, observationId, quote, signature }) {
    P.digest(id);
    const q = P.validateQuote(structuredClone(quote));
    if (q.domain !== this.#target.domain || q.policyHash !== this.#target.policyHash) throw Error("Quote outside pinned deployment");
    if (JSON.stringify(this.#get("quotes", q.hash)) !== JSON.stringify(q)) throw Error("Quote was not issued by this ledger");
    const e = await this.#evidence(observationId);
    P.signatureMatches(reservationHash(this.#target, "reserve", e.session, id, q.hash), signature, e.owner);
    const result = this.#tx(() => {
      const synced = this.#sync(e); if (synced.error) return synced;
      const old = this.#get("holds", id);
      if (old) {
        if (old.session !== e.session || old.quote.hash !== q.hash) throw Error("Reservation ID reused");
        return { hold: old };
      }
      const now = P.integer(this.#clock()), x = this.#exposure(e.session), amount = uint(q.maxCharge);
      if (now < q.at || now >= q.expires) throw Error("Expired quote");
      if (amount > uint(e.perJob) || x.held + amount > uint(e.remaining) || BigInt(x.count) >= uint(e.remainingJobs)) throw Error("Funded spending limit");
      const h = { id, session: e.session, owner: e.owner, state: "reserved", amount: amount.toString(), quote: q,
        signature, reservedAt: now, evidenceHash: e.stateHash };
      this.#saveHold(h); return { hold: h };
    });
    if (result.error) throw Error(result.error);
    return { ...result.hold, mode: "funded-rehearsal", paymentsEnabled: false };
  }
  async markDispatched({ id, observationId, provider }) {
    P.digest(id); address(provider);
    const e = await this.#evidence(observationId);
    const result = this.#tx(() => {
      const synced = this.#sync(e); if (synced.error) return synced;
      const h = this.#get("holds", id), now = P.integer(this.#clock());
      if (!h || h.session !== e.session || h.state !== "reserved" || provider === h.owner) throw Error("Invalid rehearsal dispatch");
      if (now < h.reservedAt || now >= h.quote.expires) throw Error("Expired reservation");
      h.state = "dispatched"; h.provider = provider; h.dispatchedAt = now;
      h.attempt = crypto.randomBytes(32).toString("hex"); h.deadline = now + h.quote.tariff.maxLatencyMs; this.#saveHold(h);
      return { hold: h };
    });
    if (result.error) throw Error(result.error);
    // Records the accounting transition only; sends no work to any machine.
    return { ...result.hold, mode: "funded-rehearsal", paymentsEnabled: false };
  }
  cancel({ id, signature }) {
    P.digest(id);
    return this.#tx(() => {
      const h = this.#get("holds", id);
      if (!h) throw Error("Unknown funded reservation");
      P.signatureMatches(reservationHash(this.#target, "cancel", h.session, h.id, h.quote.hash), signature, h.owner);
      if (!["reserved", "cancelled"].includes(h.state)) throw Error("Dispatched or uncertain work stays held");
      h.state = "cancelled"; h.amount = "0"; this.#saveHold(h);
      return { id, state: h.state, mode: "funded-rehearsal", paymentsEnabled: false };
    });
  }
  complete({ id, output, signature }) {
    P.digest(id);
    if (!this.#accept) throw Error("Independent acceptance policy is not configured");
    return this.#tx(() => {
      const h = this.#get("holds", id), now = P.integer(this.#clock());
      if (!h || !["dispatched", "verified", "prepared", "submitted", "settled"].includes(h.state)) throw Error("No dispatched job");
      P.signatureMatches(fundedResultHash(this.#target, h, output), signature, h.provider);
      if (h.receipt) {
        if (h.receipt.outputHash !== P.hash(output) || h.receipt.signature !== signature) throw Error("Conflicting result replay");
        return structuredClone(h.receipt);
      }
      if (now < h.dispatchedAt || now > h.deadline || this.#accept({ job: structuredClone(h), output }) !== true) throw Error("Unaccepted or expired result");
      const usage = this.#meter.measure(h.quote, output);
      if (uint(usage.amount) > uint(h.amount)) throw Error("Charge exceeds hold");
      h.receipt = { mode: "funded-rehearsal", id, session: h.session, provider: h.provider, attempt: h.attempt,
        quoteHash: h.quote.hash, outputHash: P.hash(output), signature, usage, dispatchedAt: h.dispatchedAt, completedAt: now };
      h.receiptHash = P.hash(JSON.stringify(h.receipt)); h.amount = usage.amount; h.state = "verified";
      this.#saveHold(h); return structuredClone(h.receipt);
    });
  }
  prepare(id) {
    P.digest(id);
    return this.#tx(() => {
      const h = this.#get("holds", id);
      if (!h || !["verified", "prepared", "submitted", "settled"].includes(h.state)) throw Error("No accepted charge");
      if (h.intent) return structuredClone(h.intent);
      const s = this.#get("sessions", h.session);
      if (s.blocked || BigInt(P.integer(this.#clock())) > uint(s.evidence.settleUntil)) throw Error("Session needs reconciliation or expired settlement window");
      if (this.#db.prepare("SELECT id FROM holds WHERE session=? AND state IN ('prepared','submitted')").get(h.session)) throw Error("Previous settlement unresolved");
      h.intent = { id: h.id, session_id: h.session, provider: h.provider, policy_hash: this.#target.policyHash,
        receipt_hash: h.receiptHash, amount: h.receipt.usage.amount, dispatched_at: String(h.dispatchedAt), nonce: uint(uint(s.nonce) + 1n).toString() };
      h.intentHash = P.hash(JSON.stringify(h.intent)); h.state = "prepared"; this.#saveHold(h);
      return structuredClone(h.intent);
    });
  }
  async settlementOperation(id) {
    const h = this.#get("holds", P.digest(id));
    if (!h?.intent || P.hash(JSON.stringify(h.intent)) !== h.intentHash) throw Error("No intact settlement intent");
    const c = h.intent, charge = {};
    for (const key of ["id", "session_id", "policy_hash", "receipt_hash"]) charge[key] = utils.encodeBase64url(Buffer.from(P.digest(c[key]), "hex"));
    charge.provider = utils.encodeBase64url(utils.decodeBase58(address(c.provider)));
    for (const key of ["amount", "dispatched_at", "nonce"]) charge[key] = uint(c[key]).toString();
    return { contract_id: this.#target.credits, entry_point: ABI.methods.settle.entry_point,
      args: utils.encodeBase64url(await new Serializer(ABI.types).serialize({ charge }, "koin.Request")) };
  }
  recordTransaction({ id, txId }) {
    P.digest(id);
    if (typeof txId !== "string" || !/^0x1220[a-f0-9]{64}$/.test(txId)) throw Error("Invalid transaction ID");
    return this.#tx(() => {
      const h = this.#get("holds", id);
      if (!h || !["prepared", "submitted"].includes(h.state) || (h.txId && h.txId !== txId)) throw Error("Cannot replace uncertain transaction");
      if (this.#db.prepare("SELECT id FROM holds WHERE json_extract(data, '$.txId')=? AND id!=?").get(txId, id)) throw Error("Transaction already bound");
      h.txId = txId; h.state = "submitted"; this.#saveHold(h);
      return { id, txId, paymentsEnabled: false };
    });
  }
  async reconcile({ id, observationId }) {
    P.digest(id);
    const original = this.#get("holds", id);
    if (original?.state === "settled") return { id, state: "settled", paymentsEnabled: false };
    if (original?.state !== "submitted") throw Error("No transaction to reconcile");
    const finality = await this.#observer.verifySettlement(original.txId, await this.settlementOperation(id));
    if (finality.state !== "finalized") return { id, state: finality.state, paymentsEnabled: false };
    const e = await this.#evidence(observationId, "reconciliation");
    const result = this.#tx(() => {
      this.#fresh(e, "reconciliation");
      const h = this.#get("holds", id), s = this.#get("sessions", original.session);
      if (h.state === "settled") return { state: "settled" };
      if (h.state !== "submitted" || h.txId !== original.txId || h.intentHash !== original.intentHash) throw Error("Settlement changed during verification");
      const c = h.intent;
      if (e.session !== s.id || e.owner !== s.owner || e.perJob !== s.perJob || e.expires !== s.expires ||
          uint(e.height) < uint(finality.height) || uint(e.nonce) !== uint(s.nonce) + 1n || e.nonce !== c.nonce ||
          uint(e.remaining) + uint(c.amount) !== uint(s.remaining) || uint(e.remainingJobs) + 1n !== uint(s.remainingJobs)) {
        s.blocked = true; s.reason = "unexplained_chain_charge"; this.#saveSession(s);
        return { error: "Chain state does not match the exact charge; reconciliation remains blocked" };
      }
      h.state = "settled"; h.amount = "0"; h.finality = finality; this.#saveHold(h);
      s.remaining = e.remaining; s.remainingJobs = e.remainingJobs; s.nonce = e.nonce; s.evidence = e;
      s.blocked = false; delete s.reason; this.#saveSession(s);
      return { state: "settled" };
    });
    if (result.error) throw Error(result.error);
    return { id, ...result, mode: "funded-rehearsal", paymentsEnabled: false };
  }
  status(id) {
    P.digest(id);
    return this.#tx(() => {
      const s = this.#get("sessions", id); if (!s) throw Error("Unknown funded session");
      const x = this.#exposure(id);
      return { id, mode: "funded-rehearsal", paymentsEnabled: false, blocked: s.blocked,
        held: x.held.toString(), available: (uint(s.remaining) - x.held).toString(),
        remainingJobs: (uint(s.remainingJobs) - BigInt(x.count)).toString(), checkedAt: s.evidence.checkedAt,
        notice: "Last verified accounting snapshot; fresh funding checks required before new work." };
    });
  }
  close() { this.#db.close(); }
}
module.exports = { FundedReservations, reservationHash, fundedResultHash };
