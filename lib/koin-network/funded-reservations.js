"use strict";

// Funded accounting rehearsal. No signer or broadcast capability. All processes for a deployment MUST share this DB.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { Serializer, utils } = require("koilib");
const ABI = require("./credits-abi.json");
const P = require("./job-protocol");
const D = require("./session-delegation");
const { address, Meter } = require("./metering");
const { uint, DAY } = require("./policy");
const O = require("./settlement-outbox");
const { FundedSessionObserver } = require("./funded-session");

function reservationHash(target, action, session, id, quoteHash) {
  if (!["reserve", "cancel"].includes(action)) throw Error("Invalid reservation action");
  return Buffer.from(P.hash(JSON.stringify(["KAI-KOIN-FUNDED-RESERVATION-REHEARSAL-V1", target.chainId,
    target.credits, target.creditsHash, target.policyHash, P.domain(target.domain), action,
    P.digest(session), P.digest(id), P.digest(quoteHash)])), "hex");
}
const { fundedResultHash } = require("./funded-protocol");
class FundedReservations {
  #db; #observer; #target; #clock; #meter; #accept; #accounts; #settlementPolicy;
  constructor(directory, { observer, target, meter, accept = null, accounts = null, settlementPolicy = null, clock = Date.now }) {
    if (!(observer instanceof FundedSessionObserver)) throw Error("Trusted funded-session observer required");
    if (!target || Object.keys(target).sort().join() !== "chainId,credits,creditsHash,domain,policyHash" ||
        typeof target.chainId !== "string" || !/^0x1220[a-f0-9]{64}$/.test(target.creditsHash)) throw Error("Pinned deployment required");
    address(target.credits); P.domain(target.domain); P.digest(target.policyHash);
    if (!(meter instanceof Meter) || meter.policyHash !== target.policyHash) throw Error("Pinned tariff engine required");
    this.#meter = meter; this.#accounts = accounts;
    this.#settlementPolicy = settlementPolicy && O.policy(settlementPolicy);
    if (this.#settlementPolicy) observer.assertSettlementVerifier(this.#settlementPolicy.verifier);
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
        CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, session TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS held_session ON holds(session);
        CREATE TABLE IF NOT EXISTS settlement_policy (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settlement_outbox (id TEXT PRIMARY KEY, tx_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settlement_mana (day TEXT NOT NULL, id TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(day,id));`);
      this.#tx(() => {
        const expected = JSON.stringify({ schema: 1, mode: "funded-rehearsal", target: this.#target });
        const old = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
        if (old && old.data !== expected) throw Error("Funded ledger deployment mismatch");
        if (!old && ["sessions", "holds", "quotes", "delegations", "settlement_outbox", "settlement_mana", "settlement_policy"].some((table) => this.#db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) throw Error("Missing funded ledger identity");
        if (!old) this.#db.prepare("INSERT INTO identity VALUES (1, ?)").run(expected);
      });
      this.#tx(() => {
        const prior = this.#db.prepare("SELECT data FROM settlement_policy WHERE id=1").get();
        if (!prior && (this.#db.prepare("SELECT 1 FROM settlement_outbox LIMIT 1").get() || this.#db.prepare("SELECT 1 FROM settlement_mana LIMIT 1").get())) throw Error("Missing settlement sponsorship identity");
        if (prior && !this.#settlementPolicy) throw Error("Pinned settlement sponsorship policy required to reopen this ledger");
        if (this.#settlementPolicy) {
          const data = JSON.stringify(this.#settlementPolicy);
          if (prior && prior.data !== data) throw Error("Settlement sponsorship policy changed");
          if (!prior) this.#db.prepare("INSERT INTO settlement_policy VALUES (1, ?)").run(data);
        }
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
  #account(accountId, grantId, owner) {
    D.identity(accountId); D.identity(grantId);
    const a = this.#accounts?.accountById(accountId);
    if (!a) throw Error("Existing account required");
    const g = this.#accounts.spendableGrant(accountId, grantId);
    if (g.address !== owner || !this.#accounts.accountView(a).wallets.some(w => w.address === owner)) throw Error("Linked wallet grant required");
  }
  #delegationLimits(t, e) {
    const now = P.integer(this.#clock());
    if (JSON.stringify(t.target) !== JSON.stringify(D.target(this.#target)) || t.session !== e.session || t.owner !== e.owner ||
        now < t.issuedAt || now >= t.expires || BigInt(t.expires) > uint(e.expires) ||
        uint(t.amount) > uint(e.remaining) || uint(t.perJob) > uint(e.perJob) || BigInt(t.maxJobs) > uint(e.remainingJobs)) throw Error("Session delegation exceeds verified funding");
    const tariff = this.#meter.entry(t.model, t.version).tariff;
    P.integer(t.maxOutput, 1, tariff.maxOutputTokens);
    this.#account(t.accountId, t.grantId, t.owner);
    return tariff;
  }
  async reviewDelegation({ observationId, accountId, grantId, model, version, maxOutput, amount, perJob, maxJobs, expires }) {
    const e = await this.#evidence(observationId), now = P.integer(this.#clock());
    const terms = D.terms({ schema: 1, mode: "funded-rehearsal", target: this.#target, session: e.session, owner: e.owner,
      accountId, grantId, model, version, maxOutput, amount, perJob, maxJobs, expires, issuedAt: now, nonce: crypto.randomBytes(32).toString("hex") });
    const tariff = this.#delegationLimits(terms, e);
    return { mode: "funded-rehearsal", paymentsEnabled: false, terms, delegationId: D.id(terms), tariff, tariffs: this.#meter.tariffs(),
      checkedAt: e.checkedAt, notice: "One session approval for accounting rehearsal only. No funds will be moved." };
  }
  async authorizeDelegation({ observationId, terms, signature, accountId, grantId }) {
    const t = D.verify(terms, signature), id = D.id(t);
    if (t.accountId !== accountId || t.grantId !== grantId) throw Error("Delegation belongs to another account or grant");
    const e = await this.#evidence(observationId);
    const result = this.#tx(() => {
      this.#account(accountId, grantId, t.owner); this.#fresh(e);
      const old = this.#get("delegations", id);
      if (old) {
        if (JSON.stringify(old.terms) !== JSON.stringify(t) || old.signature !== signature) throw Error("Delegation changed");
        return { id }; // revoked tombstones can never be reactivated by replay
      }
      this.#delegationLimits(t, e);
      const synced = this.#sync(e); if (synced.error) return synced;
      if (this.#db.prepare("SELECT id FROM delegations WHERE session=?").get(t.session)) throw Error("This funded session already has a delegation; use a new on-chain session");
      const record = { id, terms: t, signature, revokedAt: null };
      this.#db.prepare("INSERT INTO delegations VALUES (?, ?, ?)").run(id, t.session, JSON.stringify(record));
      return { id };
    });
    if (result.error) throw Error(result.error);
    return this.delegationStatus({ id, accountId });
  }
  #delegated(id, accountId, grantId, q = null) {
    const d = this.#get("delegations", P.digest(id)), now = P.integer(this.#clock());
    if (!d || d.terms.accountId !== accountId || d.terms.grantId !== grantId) throw Error("Delegation belongs to another account or grant");
    const t = D.verify(d.terms, d.signature);
    if (D.id(t) !== id || JSON.stringify(t.target) !== JSON.stringify(D.target(this.#target)) || d.revokedAt !== null ||
        now < t.issuedAt || now >= t.expires) throw Error("Session delegation expired or revoked");
    this.#account(accountId, grantId, t.owner);
    if (this.#get("sessions", t.session)?.blocked) throw Error("Session requires reconciliation");
    if (q && (q.tariff.model !== t.model || q.tariff.version !== t.version || q.maxOutput > t.maxOutput || uint(q.maxCharge) > uint(t.perJob))) throw Error("Request exceeds session delegation");
    return d;
  }
  #delegationUsage(d) {
    let held = 0n, spent = 0n, count = 0;
    for (const row of this.#db.prepare("SELECT data FROM holds WHERE session=? AND state!='cancelled'").all(d.terms.session)) {
      const h = JSON.parse(row.data); if (h.delegationId !== d.id) continue;
      count++;
      if (h.state === "settled") spent += uint(h.receipt.usage.amount); else held += uint(h.amount);
    }
    return { held, spent, count };
  }
  delegationStatus({ id, accountId }) {
    const d = this.#get("delegations", P.digest(id));
    if (!d || d.terms.accountId !== D.identity(accountId) || !this.#accounts?.accountById(accountId)) throw Error("Session delegation is unavailable");
    const x = this.#delegationUsage(d), t = d.terms, s = this.#get("sessions", t.session);
    let state = d.revokedAt !== null ? "revoked" : this.#clock() >= t.expires ? "expired" : "active";
    try { this.#account(accountId, t.grantId, t.owner); } catch { if (state === "active") state = "account_unavailable"; }
    if (state === "active" && s?.blocked) state = "reconciliation_required";
    return { id, session: t.session, owner: t.owner, mode: "funded-rehearsal", paymentsEnabled: false, state,
      amount: t.amount, perJob: t.perJob, held: String(x.held), spent: String(x.spent), available: String(uint(t.amount) - x.held - x.spent),
      remainingJobs: t.maxJobs - x.count, maxJobs: t.maxJobs, expires: t.expires, model: t.model, version: t.version, maxOutput: t.maxOutput,
      notice: "Accounting rehearsal only. New work requires fresh funding checks. Revocation does not refund on-chain credits." };
  }
  revokeDelegation({ id, accountId }) {
    P.digest(id); D.identity(accountId);
    this.#tx(() => {
      const d = this.#get("delegations", id);
      if (!d || d.terms.accountId !== accountId || !this.#accounts?.accountById(accountId)) throw Error("Session delegation is unavailable");
      if (d.revokedAt === null) {
        d.revokedAt = P.integer(this.#clock());
        this.#db.prepare("UPDATE delegations SET data=? WHERE id=?").run(JSON.stringify(d), id);
      }
      for (const row of this.#db.prepare("SELECT data FROM holds WHERE session=? AND state='reserved'").all(d.terms.session)) {
        const h = JSON.parse(row.data);
        if (h.delegationId === id) { h.state = "cancelled"; h.amount = "0"; this.#saveHold(h); }
      }
      // Dispatched/accepted/uncertain work retains its liability.
    });
    return this.delegationStatus({ id, accountId });
  }
  delegation({ id, accountId, grantId }) {
    return structuredClone(this.#delegated(id, accountId, grantId).terms);
  }
  job(id) { return this.#get("holds", P.digest(id)); }
  ownedJob({ id, delegationId, accountId, grantId }) {
    this.delegationStatus({ id: delegationId, accountId });
    if (grantId !== undefined && this.#get("delegations", delegationId).terms.grantId !== grantId) throw Error("Request belongs to another grant");
    const h = this.job(id);
    if (h && h.delegationId !== delegationId) throw Error("Request belongs to another session");
    return h;
  }
  releaseQueued({ id, delegationId, accountId }) {
    return this.#tx(() => {
      const h = this.ownedJob({ id, delegationId, accountId });
      if (h?.state === "reserved") { h.state = "cancelled"; h.amount = "0"; this.#saveHold(h); }
      return h;
    });
  }
  busy(provider) {
    return this.#db.prepare("SELECT data FROM holds WHERE state='dispatched'").all()
      .some(row => { const h = JSON.parse(row.data); return h.provider === provider && this.#clock() <= h.deadline; });
  }
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
    return this.#reserve({ id, observationId, quote }, e => {
      P.signatureMatches(reservationHash(this.#target, "reserve", e.session, id, quote.hash), signature, e.owner);
      return { signature };
    });
  }
  async reserveDelegated({ id, observationId, quote, delegationId, accountId, grantId }) {
    return this.#reserve({ id, observationId, quote }, (e, q, isNew) => {
      const d = this.#delegated(delegationId, accountId, grantId, q), t = d.terms;
      if (t.session !== e.session || t.owner !== e.owner) throw Error("Delegation funding mismatch");
      const x = this.#delegationUsage(d);
      if (isNew && (x.spent + x.held + uint(q.maxCharge) > uint(t.amount) || x.count >= t.maxJobs)) throw Error("Delegated session spending limit");
      return { delegationId };
    });
  }
  async #reserve({ id, observationId, quote }, authorize) {
    P.digest(id);
    const q = P.validateQuote(structuredClone(quote));
    if (q.domain !== this.#target.domain || q.policyHash !== this.#target.policyHash) throw Error("Quote outside pinned deployment");
    if (JSON.stringify(this.#get("quotes", q.hash)) !== JSON.stringify(q)) throw Error("Quote was not issued by this ledger");
    const e = await this.#evidence(observationId);
    const result = this.#tx(() => {
      const old = this.#get("holds", id);
      const authority = authorize(e, q, !old);
      const synced = this.#sync(e); if (synced.error) return synced;
      if (old) {
        if (old.session !== e.session || old.quote.hash !== q.hash || old.delegationId !== authority.delegationId) throw Error("Reservation ID reused");
        return { hold: old };
      }
      const now = P.integer(this.#clock()), x = this.#exposure(e.session), amount = uint(q.maxCharge);
      if (now < q.at || now >= q.expires) throw Error("Expired quote");
      if (amount > uint(e.perJob) || x.held + amount > uint(e.remaining) || BigInt(x.count) >= uint(e.remainingJobs)) throw Error("Funded spending limit");
      const h = { id, session: e.session, owner: e.owner, state: "reserved", amount: amount.toString(), quote: q,
        ...authority, reservedAt: now, evidenceHash: e.stateHash };
      this.#saveHold(h); return { hold: h };
    });
    if (result.error) throw Error(result.error);
    return { ...result.hold, mode: "funded-rehearsal", paymentsEnabled: false };
  }
  async markDispatched({ id, observationId, provider, available = () => true }) {
    P.digest(id); address(provider);
    const e = await this.#evidence(observationId);
    const result = this.#tx(() => {
      const synced = this.#sync(e); if (synced.error) return synced;
      const h = this.#get("holds", id), now = P.integer(this.#clock());
      if (!h || h.session !== e.session || h.state !== "reserved" || provider === h.owner || this.busy(provider) || available() !== true) throw Error("Invalid rehearsal dispatch");
      if (h.delegationId) {
        const d = this.#get("delegations", h.delegationId);
        this.#delegated(h.delegationId, d.terms.accountId, d.terms.grantId, h.quote);
      }
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
      if (this.#settlementPolicy && !this.#outbox(id)) throw Error("Stage the full signed transaction before recording its ID");
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
      const out = this.#outbox(id);
      if (out) { out.state = "settled"; out.finality = finality; this.#saveOutbox(out); }
      s.remaining = e.remaining; s.remainingJobs = e.remainingJobs; s.nonce = e.nonce; s.evidence = e;
      s.blocked = false; delete s.reason; this.#saveSession(s);
      return { state: "settled" };
    });
    if (result.error) throw Error(result.error);
    return { id, ...result, mode: "funded-rehearsal", paymentsEnabled: false };
  }
  #settlementTime() {
    const now = P.integer(this.#clock());
    const prior = this.#db.prepare("SELECT MAX(MAX(json_extract(data,'$.createdAt'), COALESCE(json_extract(data,'$.lastAttemptAt'),0))) AS at FROM settlement_outbox").get().at;
    if (prior !== null && now < prior) throw Error("Settlement clock moved backwards");
    return now;
  }
  #outbox(id) {
    const out = this.#get("settlement_outbox", id);
    if (out) {
      if (out.id !== id || P.hash(JSON.stringify(out.transaction)) !== out.transactionHash || out.txId !== out.transaction.id ||
          !["staged", "unknown", "pending", "reversible", "needs_review", "settled"].includes(out.state)) throw Error("Damaged settlement outbox");
      P.integer(out.attempts, 0, 20); P.integer(out.createdAt);
      if (out.lastAttemptAt !== null) P.integer(out.lastAttemptAt, out.createdAt);
      if ((out.attempts === 0) !== (out.lastAttemptAt === null) || !Array.isArray(out.attemptDays) ||
          new Set(out.attemptDays).size !== out.attemptDays.length ||
          (out.attempts === 0) !== (out.attemptDays.length === 0) || out.attemptDays.length > out.attempts) throw Error("Damaged settlement attempt history");
      for (const day of out.attemptDays) {
        uint(day);
        if (uint(day) > BigInt(Math.floor(out.lastAttemptAt / DAY))) throw Error("Damaged settlement attempt day");
      }
    }
    return out;
  }
  #saveOutbox(out) {
    this.#db.prepare("INSERT OR REPLACE INTO settlement_outbox VALUES (?, ?, ?)").run(out.id, out.txId, JSON.stringify(out));
  }
  #sponsorship() {
    if (!this.#settlementPolicy) throw Error("Settlement outbox is not configured");
    const stored = this.#db.prepare("SELECT data FROM settlement_policy WHERE id=1").get();
    if (stored?.data !== JSON.stringify(this.#settlementPolicy)) throw Error("Settlement sponsorship identity mismatch");
    return this.#settlementPolicy;
  }
  #settlementEvidence(h, e) {
    this.#fresh(e, "reconciliation");
    const s = this.#get("sessions", h.session), now = BigInt(P.integer(this.#clock()));
    if (!s || s.blocked || e.session !== h.session || e.owner !== h.owner) throw Error("Session requires reconciliation");
    if (["remaining", "nonce", "remainingJobs", "perJob", "expires"].some(k => s[k] !== e[k])) {
      s.blocked = true; s.reason = "unexplained_chain_state"; this.#saveSession(s);
      return { error: "Session changed; reconcile before any settlement attempt" };
    }
    if (e.paused || e.closed || now > uint(e.settleUntil) || !uint(e.remainingJobs) ||
        uint(h.intent.amount) > uint(e.remaining) || uint(h.intent.amount) > uint(e.perJob) ||
        uint(h.intent.nonce) !== uint(e.nonce) + 1n ||
        (uint(e.revokedAt) && BigInt(h.dispatchedAt) >= uint(e.revokedAt))) throw Error("Settlement is no longer eligible; keep the hold for review");
    s.evidence = e; this.#saveSession(s); return {};
  }
  async stageSettlement({ id, transaction, observationId }) {
    P.digest(id); const policy = this.#sponsorship(), initial = this.job(id);
    if (!initial?.intent) throw Error("Prepared settlement required");
    const validated = await O.validateSigned(transaction, { target: this.#target, policy, operation: await this.settlementOperation(id) });
    const transactionHash = P.hash(JSON.stringify(validated.transaction));
    const old = this.#outbox(id);
    if (old) {
      if (old.transactionHash !== transactionHash) throw Error("Cannot replace a saved settlement transaction");
      return this.settlementStatus(id);
    }
    const e = await this.#evidence(observationId, "reconciliation");
    const result = this.#tx(() => {
      this.#sponsorship();
      const h = this.job(id), existing = this.#outbox(id);
      if (existing) {
        if (existing.transactionHash !== transactionHash) throw Error("Cannot replace a saved settlement transaction");
        return {};
      }
      if (h?.state !== "prepared" || h.txId || h.intentHash !== initial.intentHash) throw Error("Settlement changed during staging");
      const eligible = this.#settlementEvidence(h, e); if (eligible.error) return eligible;
      if (this.#db.prepare("SELECT id FROM holds WHERE state='submitted' LIMIT 1").get()) throw Error("Previous verifier transaction is unresolved");
      // Nonce history is permanent, including failed transactions. A new
      // envelope must never reuse a nonce from an earlier outbox entry.
      for (const row of this.#db.prepare("SELECT data FROM settlement_outbox").all()) {
        const v = JSON.parse(row.data);
        if (v.state !== "settled") throw Error("Previous verifier transaction requires recovery");
        if (uint(validated.nonce) <= uint(v.nonce)) throw Error("Verifier nonce cannot be reused or move backwards");
      }
      const out = { id, txId: validated.transaction.id, transaction: validated.transaction, transactionHash,
        nonce: validated.nonce, rcLimit: validated.rcLimit, intentHash: h.intentHash, state: "staged",
        attempts: 0, attemptDays: [], lastAttemptAt: null, createdAt: this.#settlementTime(), finality: null };
      this.#saveOutbox(out);
      h.txId = out.txId; h.state = "submitted"; this.#saveHold(h);
      // The complete signed envelope and its hold binding commit together.
      return {};
    });
    if (result.error) throw Error(result.error);
    return this.settlementStatus(id);
  }
  settlementStatus(id) {
    const out = this.#outbox(P.digest(id)); if (!out) throw Error("No saved settlement transaction");
    const h = this.job(id);
    if (h?.txId !== out.txId || h.intentHash !== out.intentHash || (h.state === "settled") !== (out.state === "settled")) throw Error("Settlement outbox binding mismatch");
    return { id, txId: out.txId, state: out.state, attempts: out.attempts, lastAttemptAt: out.lastAttemptAt,
      rcLimit: out.rcLimit, nonce: out.nonce, finality: out.finality, reason: out.reason || null,
      mode: "funded-rehearsal", paymentsEnabled: false };
  }
  async nextSettlementAttempt({ id, observationId }) {
    P.digest(id); const policy = this.#sponsorship(), initial = this.#outbox(id);
    if (!initial) throw Error("No saved settlement transaction");
    await O.validateSigned(initial.transaction, { target: this.#target, policy, operation: await this.settlementOperation(id) });
    const e = await this.#evidence(observationId, "reconciliation");
    const result = this.#tx(() => {
      this.#sponsorship(); const out = this.#outbox(id), h = this.job(id), now = this.#settlementTime();
      if (out.transactionHash !== initial.transactionHash || h?.txId !== out.txId || h.intentHash !== out.intentHash) throw Error("Settlement changed during recovery");
      if (!["staged", "unknown"].includes(out.state)) return { action: "wait" };
      if (now < out.createdAt || (out.lastAttemptAt !== null && now < out.lastAttemptAt)) throw Error("Settlement clock moved backwards");
      const eligible = this.#settlementEvidence(h, e); if (eligible.error) return eligible;
      if (out.attempts >= policy.maxAttempts) {
        out.state = "needs_review"; out.reason = "attempt_limit"; this.#saveOutbox(out); return { action: "review" };
      }
      if (out.lastAttemptAt !== null && now - out.lastAttemptAt < policy.minRetryMs) return { action: "wait" };
      if (!Array.isArray(out.attemptDays) || ((out.attempts === 0) !== (out.attemptDays.length === 0))) throw Error("Settlement sponsorship journal missing");
      for (const day of out.attemptDays) {
        const row = this.#db.prepare("SELECT amount FROM settlement_mana WHERE day=? AND id=?").get(day, id);
        if (row?.amount !== out.rcLimit) throw Error("Settlement sponsorship journal mismatch");
      }
      const day = String(Math.floor(now / DAY)), charged = this.#db.prepare("SELECT amount FROM settlement_mana WHERE day=? AND id=?").get(day, id);
      if (!charged) {
        const used = this.#db.prepare("SELECT amount FROM settlement_mana WHERE day=?").all(day).reduce((sum, row) => sum + uint(row.amount), 0n);
        if (used + uint(out.rcLimit) > uint(policy.maxRcPerDay)) return { action: "wait", reason: "sponsorship_budget" };
        this.#db.prepare("INSERT INTO settlement_mana VALUES (?, ?, ?)").run(day, id, out.rcLimit);
        out.attemptDays.push(day);
      } else if (charged.amount !== out.rcLimit) throw Error("Settlement sponsorship journal mismatch");
      out.attempts++; out.lastAttemptAt = now; out.state = "unknown"; out.finality = null; this.#saveOutbox(out);
      // This returns bytes to a rehearsal driver only AFTER durable attempt and
      // Mana checkpoints. This module cannot transmit or sign anything.
      return { action: "submit_exact_transaction", transaction: structuredClone(out.transaction) };
    });
    if (result.error) throw Error(result.error);
    return { ...this.settlementStatus(id), ...result };
  }
  async recoverSettlement({ id, observationId }) {
    P.digest(id); this.#sponsorship();
    const out = this.#outbox(id); if (!out) throw Error("No saved settlement transaction");
    const status = this.settlementStatus(id);
    if (status.state === "settled") return { ...status, action: "done" };
    const finality = await this.#observer.verifySettlement(out.txId, await this.settlementOperation(id));
    if (finality.state === "finalized") {
      const reconciled = await this.reconcile({ id, observationId });
      if (reconciled.state === "settled") return { ...this.settlementStatus(id), action: "done" };
      return { ...this.settlementStatus(id), action: "wait" };
    }
    this.#tx(() => {
      const current = this.#outbox(id);
      if (current.txId !== out.txId) throw Error("Settlement changed during finality check");
      if (current.state === "settled") return;
      // A stale concurrent lookup cannot undo a permanent review gate.
      if (current.state !== "needs_review") {
        current.state = finality.state === "reverted" ? "needs_review" : finality.state;
        if (finality.state === "reverted") current.reason = "finalized_revert";
      }
      current.finality = finality; this.#saveOutbox(current);
    });
    const current = this.settlementStatus(id);
    return { ...current, action: current.state === "needs_review" ? "review" : current.state === "unknown" ? "retry_same_transaction" : "wait" };
  }
  prepareNextSettlement(session) {
    P.digest(session);
    const unresolved = this.#db.prepare("SELECT id FROM holds WHERE session=? AND state IN ('prepared','submitted') LIMIT 1").get(session);
    if (unresolved) return { id: unresolved.id, state: "waiting", paymentsEnabled: false };
    const next = this.#db.prepare("SELECT id FROM holds WHERE session=? AND state='verified' ORDER BY json_extract(data,'$.reservedAt'),id LIMIT 1").get(session);
    if (!next) return { state: "idle", paymentsEnabled: false };
    try { return { id: next.id, state: "prepared", intent: this.prepare(next.id), paymentsEnabled: false }; }
    catch (e) {
      if (!/Session needs reconciliation or expired settlement window/.test(e.message)) throw e;
      return { id: next.id, state: "needs_review", reason: "settlement_window_or_reconciliation", paymentsEnabled: false };
    }
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
