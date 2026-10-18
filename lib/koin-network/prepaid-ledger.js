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
  constructor(directory, { target, meter, encryptionKey, clock = Date.now, waitMs = 180000, product = "prepaid-v1", freePolicy, ownershipWallets }) {
    if (!require("./product").isPrepaid(product)) throw Error("Prepaid product required"); this.product = product;
    this.ownershipWallets = ownershipWallets;
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
        CREATE TABLE IF NOT EXISTS purchase_claims(id TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,owner));
        CREATE TABLE IF NOT EXISTS purchase_confirmation_queue(turn INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,owner TEXT NOT NULL,UNIQUE(id,owner));
        CREATE INDEX IF NOT EXISTS pending_purchase_account ON purchase_claims(json_extract(data,'$.accountId')) WHERE state='pending';
        CREATE UNIQUE INDEX IF NOT EXISTS one_final_purchase ON purchase_claims(id) WHERE state='confirmed';
        CREATE TABLE IF NOT EXISTS accounts(owner TEXT PRIMARY KEY,purchased TEXT NOT NULL,spent TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner);
        CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);`);
      this.guard.attach(this.db);
      if (freePolicy && product !== "prepaid-usd-v1") throw Error("Free USD grants cannot relabel legacy credits");
      this.free = new (require("./free-credits").FreeCredits)(this.db, freePolicy, clock);
      this.runs = new (require("./credit-runs").CreditRuns)(this);
      const identity = JSON.stringify({ schema: 1, product: this.product, target, keyId: P.hash(encryptionKey) });
      const old = this.db.prepare("SELECT data FROM identity WHERE id=1").get();
      if (old && old.data !== identity) throw Error("Prepaid ledger identity changed");
      if (!old) this.write(() => this.db.prepare("INSERT INTO identity VALUES(1,?)").run(identity));
      // Preserve the original purchase journal verbatim. Candidate claims are
      // account-scoped so an unrelated account cannot squat on a public tx id.
      this.write(() => {
        this.db.exec("INSERT OR IGNORE INTO purchase_claims SELECT id,owner,state,data FROM purchases");
        // Seed old pending claims once, without changing their payment records.
        this.db.exec(`INSERT INTO purchase_confirmation_queue(id,owner)
          SELECT p.id,p.owner FROM purchase_claims p WHERE p.state='pending' AND NOT EXISTS
          (SELECT 1 FROM purchase_confirmation_queue q WHERE q.id=p.id AND q.owner=p.owner) ORDER BY p.rowid`);
      });
      // Prompts live in memory. An interrupted, unfinished attempt is free.
      this.write(() => { for (const j of this.activeJobs()) if (j.state === "queued" || j.state === "running") this.finishInTransaction(j, "service_restarted"); });
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
      if (ACTIVE.has(j.state) && now >= j.expires) this.finishInTransaction(j, "request_expired");

    }
  }
  sweep() { if (this.activeJobs().some(j => this.clock() >= j.expires)) this.write(() => this.sweepInTransaction()); }
  pruneAnswers() {
    const rows = this.db.prepare("SELECT data FROM jobs WHERE state='charged' AND json_extract(data,'$.answer') IS NOT NULL AND json_extract(data,'$.answerExpires')<=? LIMIT 64").all(this.clock());
    if (rows.length) this.write(() => { for (const r of rows) this.put({ ...JSON.parse(r.data), answer: null }); });
  }
  balance(owner) {
    this.sweep(); return this.balanceSnapshot(owner);
  }
  balanceSnapshot(owner) {
    const a = this.account(owner);
    const held = this.activeJobs().filter(j => j.owner === owner).reduce((n, j) => n + uint(j.funding?.paidHold ?? j.hold), 0n);
    const available = uint(a.purchased) - uint(a.spent) - held;
    if (available < 0n) throw Error("Credit accounting invariant failed");
    return { purchased: a.purchased, spent: a.spent, available: String(available), held: String(held) };
  }
  purchase(id, owner) {
    const rows = owner === undefined ? this.db.prepare("SELECT data FROM purchase_claims WHERE id=?").all(id) : this.db.prepare("SELECT data FROM purchase_claims WHERE id=? AND owner=?").all(id, owner);
    if (rows.length > 1) throw Error("Purchase claimant required");
    return rows[0] ? JSON.parse(rows[0].data) : null;
  }
  creditView(owner, identity, model) {
    return this.write(() => {
      this.sweepInTransaction();
      const purchased = this.balanceSnapshot(owner), free = this.free.available(identity, model, this.activeJobs());
      return { version: String(this.db.prepare("SELECT generation FROM recovery_generation WHERE id=1").get().generation + 1), unit: this.product === "prepaid-usd-v1" ? "USD-1e-8" : "legacy-KOIN-1e-8", purchased,
        free: { state: free.state, available: free.available, resetAt: free.resetAt },
        available: String(uint(purchased.available) + uint(free.available)), observedAt: this.clock() };
    });
  }
  queuePurchase(id, owner, accountId) {
    if (!/^0x1220[a-f0-9]{64}$/.test(id)) throw Error("Invalid purchase transaction");
    if (accountId !== undefined) P.digest(accountId);
    return this.write(() => {
      const old = this.purchase(id, owner); if (old) return old;
      if (this.purchases(owner).filter(p => p.state === "pending").length >= 8) throw Error("Purchase confirmation queue is full");
      if (accountId !== undefined && this.db.prepare("SELECT COUNT(*) AS n FROM purchase_claims WHERE state='pending' AND json_extract(data,'$.accountId')=?").get(accountId).n >= 8) throw Error("Account purchase confirmation queue is full");
      const p = { id, owner, state: "pending", createdAt: this.clock(), ...(accountId ? { accountId } : {}) };
      this.db.prepare("INSERT INTO purchase_claims VALUES(?,?,?,?)").run(id, owner, p.state, JSON.stringify(p));
      this.db.prepare("INSERT INTO purchase_confirmation_queue(id,owner) VALUES(?,?)").run(id, owner); return p;
    });
  }
  purchases(owner) { return this.db.prepare("SELECT data FROM purchase_claims WHERE owner=? ORDER BY rowid DESC").all(owner).map(r => JSON.parse(r.data)); }
  pendingPurchases() { return this.db.prepare("SELECT p.data FROM purchase_confirmation_queue q JOIN purchase_claims p ON p.id=q.id AND p.owner=q.owner WHERE p.state='pending' ORDER BY q.turn LIMIT 64").all().map(r => JSON.parse(r.data)); }
  purchaseConfirmationBatch() {
    return this.write(() => {
      const batch = this.pendingPurchases();
      // Rotate durably BEFORE network I/O: unknown transactions, exceptions or
      // process restarts cannot pin the first batch forever. New arrivals join
      // behind existing work. Never expire or rewrite an unresolved payment.
      for (const p of batch) {
        this.db.prepare("DELETE FROM purchase_confirmation_queue WHERE id=? AND owner=?").run(p.id, p.owner);
        this.db.prepare("INSERT INTO purchase_confirmation_queue(id,owner) VALUES(?,?)").run(p.id, p.owner);
      }
      return batch;
    });
  }
  confirmPurchase(id, proof) {
    // Only the in-process observer calls this, never an HTTP-supplied amount.
    return this.write(() => {
      if (proof.state !== "finalized" || proof.txId !== id || typeof proof.owner !== "string" || !uint(proof.amount)) throw Error("Finalized purchase evidence required");
      const p = this.purchase(id, proof.owner); if (!p) throw Error("Unknown purchase");
      if (p.state === "confirmed") return p;
      if (proof.state !== "finalized" || proof.txId !== id || proof.owner !== p.owner || !uint(proof.amount)) throw Error("Finalized purchase evidence required");
      const a = this.account(p.owner), purchased = String(uint(uint(a.purchased) + uint(proof.amount)));
      this.db.prepare("INSERT INTO accounts VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET purchased=excluded.purchased").run(p.owner, purchased, a.spent);
      Object.assign(p, { state: "confirmed", amount: proof.amount, proof, confirmedAt: this.clock() });
      this.db.prepare("UPDATE purchase_claims SET state=?,data=? WHERE id=? AND owner=?").run(p.state, JSON.stringify(p), id, p.owner);
      this.db.prepare("DELETE FROM purchase_confirmation_queue WHERE id=? AND owner=?").run(id, p.owner); return p;
    });
  }
  rejectPurchase(id, reason, owner) { return this.write(() => { const p = this.purchase(id, owner); if (!p || p.state !== "pending") return p; p.state = "failed"; p.reason = reason; this.db.prepare("UPDATE purchase_claims SET state=?,data=? WHERE id=? AND owner=?").run(p.state, JSON.stringify(p), id, p.owner);
      this.db.prepare("DELETE FROM purchase_confirmation_queue WHERE id=? AND owner=?").run(id, p.owner); return p; }); }
  reserve({ id, owner, model, version, messages, maxOutput, identity, freeOnly = false, stream = false, maxPaid, runId, ownership }) {
    if (typeof freeOnly !== "boolean") throw Error("Invalid Free only preference");
    if (typeof stream !== "boolean") throw Error("Invalid streaming preference");
    if (maxPaid !== undefined) uint(maxPaid);
    if (runId !== undefined) P.digest(runId);
    P.digest(id); const requestHash = P.hash(JSON.stringify({ model, version, messages: P.messages(messages), maxOutput, ...(identity || freeOnly ? { accountId: identity?.accountId, freeOnly } : {}), ...(stream ? { stream } : {}), ...(maxPaid !== undefined ? { maxPaid } : {}), ...(runId ? { runId } : {}) }));
    return this.write(() => {
      this.sweepInTransaction(); const old = this.job(id, owner);
      if (old) { if (old.requestHash !== requestHash) throw Error("Request ID already used for another message"); return old; }
      if (this.product === "prepaid-usd-v1" && !ownership) throw Error("Verified customer ownership required");
      if (ownership !== undefined) {
        if (typeof ownership.accountId !== "string" || !ownership.accountId || ownership.accountId.length > 200 || !Array.isArray(ownership.wallets) || ownership.wallets.length > 64 || ownership.wallets.some(w => !require("koilib").utils.isChecksumAddress(w))) throw Error("Verified customer ownership required");
        ownership = { accountId: ownership.accountId, wallets: [...new Set(ownership.wallets)].sort() };
      }
      const quote = this.meter.quote(this.target.domain, model, version, messages, maxOutput, this.clock());
      if (runId) this.runs.admit(runId, { owner, identity, model, freeOnly, maximum: quote.maxCharge });
      const active = this.activeJobs(), free = this.free.available(identity, model, active);
      if (identity && this.free.policy && active.filter(j => j.funding?.accountId === identity.accountId).length >= this.free.policy.accountConcurrent) throw Error("This account already has its allowed active requests");
      const freeHold = uint(free.available) < uint(quote.maxCharge) ? uint(free.available) : uint(quote.maxCharge), paidHold = uint(quote.maxCharge) - freeHold;
      if (freeOnly && paidHold) throw Error("Free only is on. This request exceeds available free credits; choose a smaller request or a local model.");
      if (maxPaid !== undefined && paidHold > uint(maxPaid)) throw Error("The paid credit estimate changed. Review the current cost before sending again.");
      const a = this.account(owner), held = active.filter(j => j.owner === owner).reduce((n, j) => n + uint(j.funding?.paidHold ?? j.hold), 0n);
      if (paidHold > uint(a.purchased) - uint(a.spent) - held) throw Error("Not enough credits. Buy credits to continue.");
      if (this.activeJobs().length >= 32) throw Error("The network is busy. Please try again.");
      return this.put({ id, owner, requestHash, quote, ...(ownership ? { ownership } : {}), state: "queued", hold: quote.maxCharge, createdAt: this.clock(), ...(runId ? { runId } : {}),
        expires: this.clock() + this.waitMs, session: P.hash("prepaid-account:" + owner), ...(stream ? { stream: true } : {}),
        ...(identity ? { funding: { accountId: identity.accountId, origin: identity.origin, day: free.day, policyVersion: free.policyVersion,
          freeOnly, freeHold: String(freeHold), paidHold: String(paidHold) } } : {}) });
    });
  }
  rewardEligible(job, provider) {
    if (!job || job.owner === provider) return false;
    if (!job.ownership) return this.product !== "prepaid-usd-v1";
    if (job.ownership.wallets.includes(provider)) return false;
    if (this.ownershipWallets) {
      try { const current = this.ownershipWallets(job.ownership); if (!Array.isArray(current) || current.length > 64 || current.some(w => !require("koilib").utils.isChecksumAddress(w)) || current.includes(provider)) return false; }
      catch { return false; }
    }
    return true;
  }
  dispatch(id, provider) {
    return this.write(() => {
      this.sweepInTransaction(); const j = this.job(id);
      if (!j || j.state !== "queued" || !this.rewardEligible(j, provider) || this.busy(provider)) throw Error("Request unavailable");
      return this.put({ ...j, state: "running", provider, attempt: crypto.randomBytes(32).toString("hex"), dispatchedAt: this.clock(), deadline: Math.min(j.expires, this.clock() + j.quote.tariff.maxLatencyMs) });
    });
  }
  encrypt(id, value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv); cipher.setAAD(Buffer.from(id));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
  }
  decrypt(id, value) { const b = Buffer.from(value, "base64"), cipher = crypto.createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12)); cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString()); }
  finishInTransaction(j, reason) {
    if (j.delivered) return this.put({ ...j, state: "charged", reason, hold: "0", chargedAt: this.clock(),
      ...(j.funding ? { funding: { ...j.funding, freeHold: "0", paidHold: "0" } } : {}),
      settlement: { state: "queued", attempts: 0, ...(uint(j.funding?.freeUsed || "0") ? { kind: "unified-usage" } : {}) } });
    return this.put({ ...j, state: "cancelled", reason, hold: "0", answer: null });
  }
  streamChunk(id, { output, signature, sequence }, accepted, final = false) {
    return this.write(() => {
      this.sweepInTransaction(); const j = this.job(id);
      if (!j?.stream) throw Error("Streaming allocation required");
      P.integer(sequence, 1, 4096);
      if (j.delivered?.sequence === sequence && j.receipt.outputHash === P.hash(output) && j.receipt.signature === signature) return j;
      if (j.state !== "running" || !this.rewardEligible(j, j.provider) || this.clock() > j.deadline || accepted !== true || typeof output !== "string" || !output.trim()) throw Error("Stream stopped or result rejected; no additional charge");
      if (sequence !== (j.delivered?.sequence || 0) + 1) throw Error("Out-of-order stream chunk");
      const previous = j.answer ? this.decrypt(id, j.answer) : "";
      if (!output.startsWith(previous) || output.length <= previous.length) throw Error("Stream prefix changed");
      const F = require("./funded-protocol");
      P.signatureMatches(final ? fundedResultHash(this.target, j, output) : F.fundedChunkHash(this.target, j, output, sequence), signature, j.provider);
      const measured = this.meter.measure(j.quote, output);
      // Appending text can merge a tokenizer's trailing tokens. Already
      // delivered, verified prefixes remain consumed; never debit a negative
      // increment or re-charge the input for each chunk.
      const outputTokens = Math.max(measured.outputTokens, j.receipt?.usage.outputTokens || 0);
      const usage = { ...measured, outputTokens, amount: require("./metering").price(j.quote.tariff, measured.inputTokens, outputTokens) };
      const prior = uint(j.receipt?.usage.amount || "0"), total = uint(usage.amount);
      if (total < prior || total > uint(j.quote.maxCharge)) throw Error("Stream usage exceeds approved price");
      const delta = total - prior, free = j.funding ? (uint(j.funding.freeHold) < delta ? uint(j.funding.freeHold) : delta) : 0n, paid = delta - free;
      this.free.consume(j.funding, String(free));
      const a = this.account(j.owner), spent = uint(a.spent) + paid;
      if (spent > uint(a.purchased)) throw Error("Credit accounting invariant failed");
      this.db.prepare("UPDATE accounts SET spent=? WHERE owner=?").run(String(spent), j.owner);
      const receipt = { product: this.product, job: id, owner: j.owner, provider: j.provider, attempt: j.attempt,
        quoteHash: j.quote.hash, outputHash: P.hash(output), signature, dispatchedAt: j.dispatchedAt, completedAt: this.clock(), usage,
        ...(final ? {} : { sequence }) };
      const funding = j.funding && { ...j.funding, freeHold: String(uint(j.funding.freeHold) - free), paidHold: String(uint(j.funding.paidHold) - paid),
        freeUsed: String(uint(j.funding.freeUsed || "0") + free), paidUsed: String(uint(j.funding.paidUsed || "0") + paid) };
      // The exact verified prefix and cumulative debit become durable together,
      // before the HTTP delivery. A lost frame is recoverable without a debit.
      return this.put({ ...j, hold: String(uint(j.quote.maxCharge) - total), receipt, receiptHash: P.hash(JSON.stringify(receipt)),
        answer: this.encrypt(id, output), answerExpires: this.clock() + 7 * 86400000, delivered: { sequence, at: this.clock() },
        ...(funding ? { funding, ...(uint(funding.freeUsed) ? { sponsorship: { state: "pending", amount: funding.freeUsed, receiptHash: P.hash(JSON.stringify(receipt)) } } : {}) } : {}) });
    });
  }
  complete(id, { output, signature }, accepted) {
    const current = this.job(id);
    if (current?.stream && current.state === "running") {
      if (!current.answer || this.decrypt(id, current.answer) !== output)
        this.streamChunk(id, { output, signature, sequence: (current.delivered?.sequence || 0) + 1 }, accepted, true);
      else {
        if (accepted !== true) throw Error("Result rejected"); P.signatureMatches(fundedResultHash(this.target, current, output), signature, current.provider);
        this.write(() => {
          const { sequence, ...rest } = current.receipt, receipt = { ...rest, signature }, receiptHash = P.hash(JSON.stringify(receipt));
          this.put({ ...current, receipt, receiptHash, ...(current.sponsorship ? { sponsorship: { ...current.sponsorship, receiptHash } } : {}) });
        });
      }
      return this.write(() => this.finishInTransaction(this.job(id), "completed"));
    }
    return this.write(() => {
      this.sweepInTransaction(); const j = this.job(id);
      if (j && ["ready", "charged"].includes(j.state) && j.receipt.outputHash === P.hash(output) && j.receipt.signature === signature) return j;
      if (!j || j.state !== "running" || !this.rewardEligible(j, j.provider) || this.clock() > j.deadline || accepted !== true) throw Error("Request expired or result rejected; no charge");
      P.signatureMatches(fundedResultHash(this.target, j, output), signature, j.provider);
      const usage = this.meter.measure(j.quote, output);
      if (uint(usage.amount) > uint(j.hold)) throw Error("Result exceeds quoted credit limit");
      const receipt = { product: this.product, job: j.id, owner: j.owner, provider: j.provider, attempt: j.attempt,
        quoteHash: j.quote.hash, outputHash: P.hash(output), signature, dispatchedAt: j.dispatchedAt, completedAt: this.clock(), usage };
      const freeUsed = j.funding ? (uint(j.funding.freeHold) < uint(usage.amount) ? uint(j.funding.freeHold) : uint(usage.amount)) : 0n;
      return this.put({ ...j, state: "ready", hold: usage.amount,
        ...(j.funding ? { funding: { ...j.funding, freeHold: String(freeUsed), paidHold: String(uint(usage.amount) - freeUsed) } } : {}),
        receipt, receiptHash: P.hash(JSON.stringify(receipt)),
        answer: this.encrypt(id, output), answerExpires: this.clock() + 7 * 86400000 });
    });
  }
  acknowledge(id, owner, receiptHash) {
    return this.write(() => {
      this.sweepInTransaction(); const j = this.job(id, owner);
      if (!j || j.receiptHash !== P.digest(receiptHash)) throw Error("Answer receipt mismatch");
      if (j.state === "charged") return j;
      if (j.state !== "ready" || !this.rewardEligible(j, j.provider)) throw Error("Request expired or customer-provider ownership changed without a charge");
      const paid = j.funding?.paidHold ?? j.receipt.usage.amount, free = j.funding?.freeHold || "0";
      this.free.consume(j.funding, free);
      const a = this.account(owner), spent = String(uint(uint(a.spent) + uint(paid)));
      if (uint(spent) > uint(a.purchased)) throw Error("Credit accounting invariant failed");
      this.db.prepare("UPDATE accounts SET spent=? WHERE owner=?").run(spent, owner);
      return this.put({ ...j, state: "charged", hold: "0", chargedAt: this.clock(),
        ...(j.funding ? { funding: { ...j.funding, freeUsed: free, paidUsed: paid, freeHold: "0", paidHold: "0" },
          ...(uint(free) ? { sponsorship: { state: "pending", amount: free, receiptHash: j.receiptHash } } : {}) } : {}),
        settlement: { state: "queued", attempts: 0, ...(uint(free) ? { kind: "unified-usage" } : {}) } });
    });
  }
  cancel(id, owner, reason = "stopped") {
    return this.write(() => { const j = this.job(id, owner); if (!j || !ACTIVE.has(j.state)) return j; return this.finishInTransaction(j, reason); });
  }
  busy(provider) { return this.activeJobs().some(j => j.provider === provider && j.state === "running" && j.deadline > this.clock()); }
  pendingJobs() { return this.jobs().filter(j => j.state === "charged" && !["finalized", "not_required"].includes(j.settlement.state)); }
  pendingSponsorship() { return this.jobs().filter(j => j.state === "charged" && j.sponsorship?.state === "pending"); }
  settledJobs() { return this.jobs().filter(j => j.state === "charged" && j.settlement.state === "finalized"); }
  settlement(id, patch) { return this.write(() => { const j = this.job(id); if (j?.state !== "charged") throw Error("Only consumed credits can settle"); return this.put({ ...j, settlement: { ...j.settlement, ...patch }, ...(patch.finality ? { finality: patch.finality } : {}),
    ...(j.sponsorship && j.settlement.kind === "unified-usage" && patch.state === "finalized" ? { sponsorship: { ...j.sponsorship, state: "finalized", txId: patch.txId } } : {}) }); }); }
  ping() { this.db.prepare("SELECT 1 FROM identity WHERE id=1").get(); }
  close() { this.db.close(); this.guard.close(); this.key.fill(0); }
}
module.exports = { PrepaidLedger };
