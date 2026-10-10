"use strict";
const { MAINNET_CHAIN, MAINNET_TOKEN } = require("./payment-network");
const fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
const { Serializer, Signer, utils } = require("koilib");
const ABI = require("./rewards-abi.json"), M = require("./reward-manifest"), O = require("./settlement-outbox");
const P = require("./job-protocol"), { uint, DAY } = require("./policy"), { RewardObserver } = require("./reward-observer");
const { FOUNDATION_CHAIN, FOUNDATION_TOKEN } = require("./payment-mode");
const methods = ["open_epoch", "propose_root", "finalize_root"], done = s => ["complete", "observed_external"].includes(s);
const enc = utils.encodeBase64url, num = v => uint(v ?? "0");
const sameRoot = (e, m) => e?.root && m && Buffer.from(e.root.hash, "base64url").toString("hex") === m.root.hash &&
  (e.root.availability ?? "0") === m.root.availability && (e.root.work ?? "0") === m.root.work;

// A dedicated lifecycle payer owns the nonce. Root proposals add the verifier's
// signature WITHOUT changing payee/nonce ownership to the settlement verifier.
async function validateSigned(tx, target, policy, operation, method) {
  tx = structuredClone(tx);
  const required = method === "propose_root" ? [policy.payer, target.verifier] : [policy.payer];
  if (!tx || !/^0x1220[a-f0-9]{64}$/.test(tx.id) || !Array.isArray(tx.signatures) || tx.signatures.length !== required.length)
    throw Error("Exact lifecycle signatures required");
  const byAddress = new Map();
  for (const s of tx.signatures) {
    if (typeof s !== "string") throw Error("Invalid lifecycle signature");
    const b = Buffer.from(s, "base64url");
    if (b.length !== 65 || enc(b) !== s) throw Error("Invalid lifecycle signature encoding");
    const a = Signer.recoverAddress(Buffer.from(tx.id.slice(6), "hex"), b);
    if (!required.includes(a) || byAddress.has(a)) throw Error("Wrong lifecycle signer");
    byAddress.set(a, s);
  }
  const validated = await O.validateSigned({ ...tx, signatures: [byAddress.get(policy.payer)] },
    { target, policy: { ...policy, verifier: policy.payer }, operation });
  validated.transaction.signatures = tx.signatures;
  return validated;
}

// Rehearsal only. One shared durable DB and an exclusive lifecycle payer.
// No production key loader, scheduler registration, timer or broadcast transport.
class RewardCycle {
  #db; #target; #policy; #budget; #identity; #observer; #clock; #ser = new Serializer(ABI.types);
  constructor(directory, { mode, target, policy, budgetPolicy, observer, clock = Date.now }) {
    if (!((mode === "isolated-rehearsal" && target?.chainId !== MAINNET_CHAIN) || (mode === "mainnet-pilot" && target?.chainId === MAINNET_CHAIN && target?.token === MAINNET_TOKEN) || (mode === "test-deployment" && target?.chainId === FOUNDATION_CHAIN && target?.token === FOUNDATION_TOKEN)) || !(observer instanceof RewardObserver)) throw Error("Isolated reward-cycle observer required");
    this.#target = M.target(target); observer.assertTarget(this.#target); this.#policy = O.policy(policy);
    if (policy.verifier !== target.verifier || [target.verifier, target.token, target.credits, target.rewards].includes(policy.payer))
      throw Error("Dedicated lifecycle payer and pinned root verifier required");
    if (!budgetPolicy || Object.keys(budgetPolicy).sort().join() !== "availabilityBps,dailyBps") throw Error("Exact reward budget policy required");
    this.#budget = { dailyBps: P.integer(budgetPolicy.dailyBps, 0, 1000), availabilityBps: P.integer(budgetPolicy.availabilityBps, 0, 10000) };
    this.#observer = observer; this.#clock = clock;
    this.#identity = JSON.stringify({ schema: 1, mode, target: this.#target, policy: this.#policy, budgetPolicy: this.#budget });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "reward-cycle.sqlite"); this.#db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    try {
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS days (epoch TEXT PRIMARY KEY, manifest TEXT, hash TEXT, handed_off INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, epoch TEXT NOT NULL, method TEXT NOT NULL, state TEXT NOT NULL,
          tx_id TEXT UNIQUE, hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(epoch,method));
        CREATE TABLE IF NOT EXISTS mana (day TEXT NOT NULL, id TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(day,id));`);
      this.#tx(() => {
        const r = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
        if (r && r.data !== this.#identity) throw Error("Reward-cycle deployment or policy changed");
        if (!r) {
          if (["days", "steps", "mana"].some(t => this.#db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())) throw Error("Missing reward-cycle identity");
          this.#db.prepare("INSERT INTO identity VALUES(1,?)").run(this.#identity);
        }
      }, false);
      if (this.#db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Corrupt reward-cycle database");
    } catch (e) { this.#db.close(); throw e; }
  }
  get mode() { return JSON.parse(this.#identity).mode; }
  get sponsor() { return this.#policy.payer; }
  currentDay() { return String(Math.floor(this.#time() / DAY)); }
  #tx(fn, check = true) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (check && this.#db.prepare("SELECT data FROM identity WHERE id=1").get()?.data !== this.#identity) throw Error("Reward-cycle identity mismatch");
      const r = fn(); this.#db.exec("COMMIT"); return r;
    } catch (e) { this.#db.exec("ROLLBACK"); throw e; }
  }
  #time() {
    const now = P.integer(this.#clock()), last = this.#db.prepare("SELECT MAX(json_extract(data,'$.updatedAt')) AS at FROM steps").get().at;
    if (last !== null && now < last) throw Error("Reward-cycle clock moved backwards");
    return now;
  }
  #id(epoch, method) { return P.hash(this.#identity + ":" + epoch + ":" + method); }
  #save(r) {
    r.updatedAt = this.#time(); const data = JSON.stringify(r);
    this.#db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?,?,?,?,?)").run(r.id, r.epoch, r.method, r.state,
      r.outbox?.transaction.id ?? null, P.hash(data), data);
  }
  #row(epoch, method) {
    const record = this.#db.prepare("SELECT * FROM steps WHERE epoch=? AND method=?").get(epoch, method);
    if (!record || P.hash(record.data) !== record.hash) throw Error("Missing or damaged reward-cycle step");
    const r = JSON.parse(record.data);
    if (r.id !== this.#id(epoch, method) || r.epoch !== epoch || r.method !== method || r.state !== record.state ||
        (r.outbox?.transaction.id ?? null) !== record.tx_id ||
        !["queued", "signing", "staged", "unknown", "pending", "reversible", "needs_review", "complete", "observed_external"].includes(r.state)) throw Error("Damaged reward-cycle binding");
    P.integer(r.updatedAt);
    const out = r.outbox;
    if (out) {
      if (out.hash !== P.hash(JSON.stringify(out.transaction)) || out.nonce !== O.nonce(out.transaction.header.nonce) ||
          out.rcLimit !== out.transaction.header.rc_limit) throw Error("Damaged lifecycle envelope");
      P.integer(out.createdAt); P.integer(out.attempts, 0, this.#policy.maxAttempts);
      if (out.lastAttemptAt !== null) P.integer(out.lastAttemptAt, out.createdAt, r.updatedAt);
      if ((out.attempts === 0) !== (out.lastAttemptAt === null) || !Array.isArray(out.days) || new Set(out.days).size !== out.days.length ||
          out.days.length > out.attempts || (out.attempts === 0) !== (out.days.length === 0)) throw Error("Damaged lifecycle attempt journal");
      for (const day of out.days) if (uint(day) > BigInt(Math.floor(out.lastAttemptAt / DAY)) ||
        this.#db.prepare("SELECT amount FROM mana WHERE day=? AND id=?").get(day, r.id)?.amount !== out.rcLimit) throw Error("Lifecycle Mana journal mismatch");
    } else if (!["queued", "signing", "needs_review", "observed_external"].includes(r.state)) throw Error("Missing lifecycle envelope");
    return r;
  }
  #manifest(epoch) {
    const d = this.#db.prepare("SELECT manifest,hash FROM days WHERE epoch=?").get(epoch);
    if (!d) throw Error("Unknown reward day");
    if (d.manifest === null && d.hash === null) return null;
    const m = M.verify(JSON.parse(d.manifest), this.#target);
    if (m.hash !== d.hash || m.envelope.manifest.epoch !== epoch) throw Error("Damaged cycle manifest");
    return m.envelope;
  }
  queueDay(epoch = this.currentDay()) {
    if (typeof epoch !== "string") throw Error("Canonical reward day required"); uint(epoch);
    return this.#tx(() => {
      this.#time();
      if (this.#db.prepare("SELECT 1 FROM days WHERE epoch=?").get(epoch)) {
        methods.forEach(m => this.#row(epoch, m)); this.#manifest(epoch); return epoch;
      }
      if (this.days().length >= 32) throw Error("Reward-cycle queue full");
      this.#db.prepare("INSERT INTO days(epoch,manifest,hash) VALUES(?,NULL,NULL)").run(epoch);
      for (const method of methods) this.#save({ id: this.#id(epoch, method), epoch, method, state: "queued", outbox: null, finality: null, reason: null });
      return epoch;
    });
  }
  importManifest(envelope) {
    const m = M.verify(envelope, this.#target), epoch = m.envelope.manifest.epoch;
    this.queueDay(epoch);
    return this.#tx(() => {
      this.#time(); const prior = this.#manifest(epoch);
      if (prior && M.verify(prior, this.#target).hash !== m.hash) throw Error("Cannot replace admitted cycle manifest");
      if (!prior) this.#db.prepare("UPDATE days SET manifest=?, hash=? WHERE epoch=?").run(JSON.stringify(m.envelope), m.hash, epoch);
      return epoch;
    });
  }
  days() { return this.#db.prepare("SELECT epoch FROM days ORDER BY length(epoch),epoch").all().map(r => r.epoch)
    .filter(epoch => {
      const rows = methods.map(m => this.#row(epoch, m));
      const missedUnsigned = rows[0].reason === "missed_reward_day" && rows.every(r => !r.outbox && r.state !== "signing");
      return !done(rows[2].state) && !missedUnsigned;
    }); }
  status(epoch) {
    const steps = methods.map(m => this.#row(epoch, m));
    return { epoch, mode: this.mode === "mainnet-pilot" ? "reward-cycle-mainnet-pilot" : "reward-cycle-rehearsal", paymentsEnabled: this.mode === "mainnet-pilot", complete: done(steps[2].state),
      steps: steps.map(r => ({ method: r.method, state: r.state, reason: r.reason, txId: r.outbox?.transaction.id ?? null, attempts: r.outbox?.attempts ?? 0 })) };
  }
  readyManifest(epoch) {
    if (!this.status(epoch).complete) throw Error("Reward cycle is not irreversibly finalized");
    return this.#manifest(epoch);
  }
  readyDays() {
    return this.#db.prepare("SELECT d.epoch FROM days d JOIN steps s ON s.epoch=d.epoch WHERE d.handed_off=0 AND s.method='finalize_root' AND s.state IN ('complete','observed_external') ORDER BY length(d.epoch),d.epoch LIMIT 16")
      .all().map(r => r.epoch);
  }
  markHandedOff(epoch) {
    this.#tx(() => { this.readyManifest(epoch); this.#db.prepare("UPDATE days SET handed_off=1 WHERE epoch=?").run(epoch); });
  }
  async operation(epoch, method) {
    if (!methods.includes(method)) throw Error("Unsupported reward-cycle operation");
    const args = epoch === "0" ? {} : { epoch };
    if (method !== "open_epoch") {
      const manifest = this.#manifest(epoch)?.manifest;
      if (!manifest) throw Error("Signed cycle manifest required");
      const r = manifest.root;
      args.root = { hash: enc(Buffer.from(r.hash, "hex")), ...(r.availability !== "0" && { availability: r.availability }), ...(r.work !== "0" && { work: r.work }) };
    }
    return { contract_id: this.#target.rewards, entry_point: ABI.methods[method].entry_point, args: enc(await this.#ser.serialize(args, "koin.Request")) };
  }
  #gate(r, evidence, manifest) {
    if (evidence.state !== "verified") return { action: "wait", reason: "cycle_" + evidence.state };
    const now = this.#time(), e = evidence.epoch, day = uint(r.epoch), chainTime = uint(evidence.chainTime);
    if (evidence.day !== r.epoch || now < evidence.checkedAt || now - evidence.checkedAt > 5000) throw Error("Stale cycle evidence");
    for (const { config: c } of [evidence.rewardConfig, evidence.creditConfig])
      if (c.daily_bps !== this.#budget.dailyBps || c.availability_bps !== this.#budget.availabilityBps) throw Error("Cycle budget policy changed");
    if (e?.expired) return { action: "review", reason: "expired_epoch" };
    if (r.method === "open_epoch" && e) return { achieved: true };
    if (r.method !== "open_epoch") {
      if (!e) return { action: "review", reason: "missing_epoch" };
      if (!manifest) return { action: "wait", reason: "await_signed_manifest" };
      if (num(manifest.root.availability) > num(e.availability_budget) || num(manifest.root.work) > num(e.work_budget) ||
          num(manifest.root.work) > uint(evidence.totalSpent) * BigInt(this.#target.workCapBps) / 10000n) throw Error("Cycle root exceeds funded reward caps");
      if (e.root && !sameRoot(e, manifest)) return { action: "review", reason: "root_changed" };
      if (r.method === "propose_root" && e.root) return { achieved: true };
      if (r.method === "finalize_root" && e.finalized && sameRoot(e, manifest)) return { achieved: true };
    }
    if (evidence.rewardConfig.paused || evidence.creditConfig.paused) return { action: "wait", reason: "paused" };
    if (r.method === "open_epoch") {
      if (day < chainTime / BigInt(DAY) || day < BigInt(Math.floor(now / DAY))) return { action: "review", reason: "missed_reward_day" };
      if (day !== chainTime / BigInt(DAY) || day !== BigInt(Math.floor(now / DAY))) return { action: "wait", reason: "future_reward_day" };
    } else if (r.method === "propose_root") {
      if (chainTime < (day + 1n) * BigInt(DAY) || BigInt(now) < (day + 1n) * BigInt(DAY)) return { action: "wait", reason: "reward_day_open" };
    } else {
      if (!e.root) return { action: "review", reason: "root_cancelled" };
      if (chainTime < num(e.review_until) || BigInt(now) < num(e.review_until)) return { action: "wait", reason: "root_under_review" };
    }
    return null;
  }
  async advance(epoch) {
    const initial = methods.map(m => this.#row(epoch, m)).find(r => !done(r.state));
    if (!initial) return { ...this.status(epoch), action: "done" };
    const manifest = this.#manifest(epoch)?.manifest;
    const operation = initial.method === "open_epoch" || manifest ? await this.operation(epoch, initial.method) : null;
    if (initial.outbox) await validateSigned(initial.outbox.transaction, this.#target, this.#policy, operation, initial.method);
    const finality = initial.outbox ? await this.#observer.verifyCycle(initial.outbox.transaction.id, operation) : null;
    const evidence = await this.#observer.inspectCycle({ epoch,
      minimumHeight: ["finalized", "reverted"].includes(finality?.state) ? finality.height : "0" });
    const decision = this.#tx(() => {
      const r = this.#row(epoch, initial.method); this.#time();
      if (done(r.state) || (r.outbox?.hash ?? null) !== (initial.outbox?.hash ?? null)) return { action: "wait" };
      const gate = this.#gate(r, evidence, manifest);
      if (evidence.state !== "verified") return gate;
      const confirmed = ["finalized", "reverted"].includes(finality?.state) && uint(evidence.height) >= uint(finality.height);
      if (confirmed) {
        r.finality = finality;
        if (gate?.achieved) { r.state = "complete"; r.reason = null; this.#save(r); return { action: "step_complete" }; }
        r.state = "needs_review"; r.reason = finality.state === "reverted" ? "finalized_revert" : "changed_after_finality";
        this.#save(r); return { action: "review", reason: r.reason };
      }
      if (r.state === "signing") return { action: "review", reason: "recover_signing_envelope" };
      if (r.state === "needs_review") return { action: "review", reason: r.reason };
      if (gate?.achieved) {
        if (r.outbox) return { action: "wait", reason: "await_own_transaction_finality" };
        r.state = "observed_external"; this.#save(r); return { action: "step_complete" };
      }
      if (gate) {
        if (gate.action === "review") { r.state = "needs_review"; r.reason = gate.reason; this.#save(r); }
        return gate;
      }
      if (!r.outbox) {
        const active = this.#db.prepare("SELECT 1 FROM steps WHERE state='signing' OR (tx_id IS NOT NULL AND state NOT IN ('complete','observed_external')) LIMIT 1").get();
        if (active) return { action: "wait", reason: "lifecycle_nonce_busy" };
        r.state = "signing"; this.#save(r);
        return { action: "prepare_cycle", operation, chainId: this.#target.chainId, payer: this.#policy.payer,
          signers: r.method === "propose_root" ? [this.#policy.payer, this.#target.verifier] : [this.#policy.payer], maxRc: this.#policy.maxRcPerTransaction };
      }
      if (finality.state !== "unknown") { r.state = finality.state; r.finality = finality; this.#save(r); return { action: "wait" }; }
      const out = r.outbox, now = this.#time();
      if (out.attempts >= this.#policy.maxAttempts) { r.state = "needs_review"; r.reason = "attempt_limit"; this.#save(r); return { action: "review", reason: r.reason }; }
      if (out.lastAttemptAt !== null && now - out.lastAttemptAt < this.#policy.minRetryMs) return { action: "wait", reason: "retry_delay" };
      const day = String(Math.floor(now / DAY));
      if (!out.days.includes(day)) {
        const used = this.#db.prepare("SELECT amount FROM mana WHERE day=?").all(day).reduce((sum, v) => sum + uint(v.amount), 0n);
        if (used + uint(out.rcLimit) > uint(this.#policy.maxRcPerDay)) return { action: "wait", reason: "sponsorship_budget" };
        this.#db.prepare("INSERT INTO mana VALUES(?,?,?)").run(day, r.id, out.rcLimit); out.days.push(day);
      }
      out.attempts++; out.lastAttemptAt = now; r.state = "unknown"; this.#save(r);
      return { action: "submit_exact_transaction", transaction: structuredClone(out.transaction) };
    });
    return { epoch, method: initial.method, paymentsEnabled: this.mode === "mainnet-pilot", ...decision };
  }
  async stage(epoch, method, transaction) {
    const v = await validateSigned(transaction, this.#target, this.#policy, await this.operation(epoch, method), method);
    const hash = P.hash(JSON.stringify(v.transaction));
    this.#tx(() => {
      const r = this.#row(epoch, method);
      if (r.outbox) { if (r.outbox.hash !== hash) throw Error("Cannot replace lifecycle envelope"); return; }
      if (r.state !== "signing") throw Error("Irreversible cycle review required before signing");
      for (const prior of this.#db.prepare("SELECT epoch,method FROM steps WHERE tx_id IS NOT NULL").all()) {
        const p = this.#row(prior.epoch, prior.method);
        if (!done(p.state) || uint(v.nonce) <= uint(p.outbox.nonce)) throw Error("Lifecycle nonce cannot bypass unresolved recovery");
      }
      r.outbox = { transaction: v.transaction, hash, nonce: v.nonce, rcLimit: v.rcLimit,
        attempts: 0, days: [], lastAttemptAt: null, createdAt: this.#time() };
      r.state = "staged"; this.#save(r);
    });
    return this.status(epoch);
  }
  close() { this.#db.close(); }
}
module.exports = { RewardCycle };
