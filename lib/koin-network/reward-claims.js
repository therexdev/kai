"use strict";
const { rewardMode, MAINNET_CHAIN } = require("./payment-network");
const fs = require("fs"), path = require("path");
const { DatabaseSync } = require("node:sqlite"), { Serializer, utils } = require("koilib");
const ABI = require("./rewards-abi.json"), M = require("./reward-manifest"), O = require("./settlement-outbox");
const P = require("./job-protocol"), { uint, add, DAY } = require("./policy");
const { RewardObserver, assertRewardIntentEvidence } = require("./reward-observer");
const { VerifiedManifestCache } = require("./verified-manifest-cache");
const done = state => ["paid", "paid_elsewhere"].includes(state);

// Dedicated sponsor, one unresolved nonce at a time, one shared DB per deployment.
// Only signed rehearsal manifests enter the queue. No private keys live here.
class RewardClaims {
  #db; #target; #policy; #identity; #observer; #clock; #preflight; #sponsorship; #manifests; #resourceCeiling; #serializer = new Serializer(ABI.types);
  constructor(directory, { target, policy, observer, clock = Date.now, preflight = async () => null, sponsorship = () => null, resourceCeiling = policy.maxRcPerTransaction }) {
    if (!(observer instanceof RewardObserver)) throw Error("Pinned reward observer required");
    this.#target = M.target(target); observer.assertTarget(this.#target);
    this.#policy = O.policy(policy);
    if (uint(resourceCeiling) < uint(this.#policy.maxRcPerTransaction)) throw Error("Claim resource ceiling cannot invalidate saved transactions");
    this.#resourceCeiling = String(uint(resourceCeiling));
    if (this.#policy.verifier !== this.#policy.payer ||
        [target.verifier, target.credits, target.rewards, target.token].includes(policy.payer)) throw Error("Dedicated claim sponsor required");
    if (typeof preflight !== "function") throw Error("Claim resource check required");
    if (typeof sponsorship !== "function") throw Error("Claim sponsorship reader required");
    this.#sponsorship = sponsorship;
    this.#observer = observer; this.#clock = clock; this.#preflight = preflight;
    this.#identity = JSON.stringify({ schema: 1, mode: rewardMode(this.#target), target: this.#target, policy: this.#policy });
    this.#manifests = new VerifiedManifestCache({ identity: this.#identity, verify: value => M.verify(value, this.#target) });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "reward-claims.sqlite"); this.#db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    try {
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS manifests (epoch TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, state TEXT NOT NULL, tx_id TEXT UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mana (day TEXT NOT NULL, id TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(day,id));`);
      this.#tx(() => {
        const identity = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
        if (identity && identity.data !== this.#identity) throw Error("Reward deployment or sponsorship policy changed");
        if (!identity) {
          if (["manifests", "claims", "mana"].some(table => this.#db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) throw Error("Missing reward ledger identity");
          this.#db.prepare("INSERT INTO identity VALUES (1, ?)").run(this.#identity);
        }
      }, false);
      if (this.#db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Corrupt reward ledger");
    } catch (e) { this.#db.close(); throw e; }
  }
  accountStatus(address) {
    if (!utils.isChecksumAddress(address)) throw Error("Valid reward account required");
    return this.#db.prepare("SELECT id FROM claims WHERE json_extract(data,'$.claim.address')=? ORDER BY rowid DESC LIMIT 64").all(address).map(r => this.status(r.id));
  }
  deployment() { return structuredClone(this.#target); }
  get sponsor() { return this.#policy.payer; }
  sponsorshipStatus(now = this.#time()) {
    const maxRcPerDay = require("./claim-sponsorship").allowance(this.#sponsorship(), this.#identity, this.#policy.maxRcPerDay);
    const day = String(Math.floor(P.integer(now) / DAY));
    const reserved = this.#db.prepare("SELECT amount FROM mana WHERE day=?").all(day).reduce((sum, v) => sum + uint(v.amount), 0n);
    const available = uint(maxRcPerDay) > reserved ? uint(maxRcPerDay) - reserved : 0n;
    return { version: 1, payer: this.sponsor, day, ledgerIdentityHash: P.hash(this.#identity),
      maxRcPerTransaction: this.#policy.maxRcPerTransaction, maxRcPerDay, reservedToday: String(reserved),
      remainingFullReservations: String(available / uint(this.#policy.maxRcPerTransaction)),
      pendingClaims: this.#db.prepare("SELECT COUNT(*) AS n FROM claims WHERE state NOT IN ('paid','paid_elsewhere')").get().n };
  }
  queueStatus() {
    const id = this.next(), first = id ? this.status(id) : null;
    return { schema: 1, resourceCeiling: this.#resourceCeiling,
      pendingClaims: this.sponsorshipStatus().pendingClaims,
      blockingClaim: first ? { id: first.id, epoch: first.epoch, state: first.state, reason: first.reason,
        txId: first.txId, attempts: first.attempts, lastSubmission: first.lastSubmission || null } : null };
  }
  #envelopePolicy() { return { ...this.#policy, maxRcPerTransaction: this.#resourceCeiling }; }
  #tx(fn, check = true) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (check && this.#db.prepare("SELECT data FROM identity WHERE id=1").get()?.data !== this.#identity) throw Error("Reward ledger identity mismatch");
      const result = fn(); this.#db.exec("COMMIT"); return result;
    } catch (e) { this.#db.exec("ROLLBACK"); throw e; }
  }
  #time() {
    const now = P.integer(this.#clock()), last = this.#db.prepare("SELECT MAX(json_extract(data,'$.updatedAt')) AS at FROM claims").get().at;
    if (last !== null && now < last) throw Error("Reward clock moved backwards");
    return now;
  }
  #save(row) {
    row.updatedAt = this.#time();
    this.#db.prepare("INSERT OR REPLACE INTO claims VALUES (?, ?, ?, ?)").run(row.id, row.state, row.outbox?.transaction.id || null, JSON.stringify(row));
  }
  #manifest(epoch) {
    const row = this.#db.prepare("SELECT hash,data FROM manifests WHERE epoch=?").get(epoch);
    if (!row) throw Error("Missing signed reward manifest");
    return this.#manifests.read({ identity: this.#db.prepare("SELECT data FROM identity WHERE id=1").get()?.data,
      epoch, hash: row.hash, data: row.data });
  }
  #row(id) {
    const record = this.#db.prepare("SELECT state,tx_id,data FROM claims WHERE id=?").get(P.digest(id));
    if (!record) throw Error("Unknown reward claim");
    const row = JSON.parse(record.data), manifest = this.#manifest(row.epoch);
    const expected = manifest.claims.find(c => c.address === row.claim.address);
    if (row.id !== id || row.manifestHash !== manifest.hash || id !== P.hash(manifest.hash + ":" + row.claim.address) ||
        !expected || JSON.stringify(expected) !== JSON.stringify(row.claim) || record.state !== row.state ||
        record.tx_id !== (row.outbox?.transaction.id || null) ||
        !["queued", "signing", "resource_signing", "staged", "unknown", "pending", "reversible", "needs_review", "paid", "paid_elsewhere"].includes(row.state)) throw Error("Damaged reward claim binding");
    P.integer(row.updatedAt);
    const history = row.resourceHistory || [];
    if (!Array.isArray(history) || history.length > 1 || (history.length && !row.resourceRecovery)) throw Error("Invalid claim resource history");
    if (row.resourceRecovery && (!row.outbox || typeof row.resourceRecovery.originalTxId !== "string" ||
        row.resourceRecovery.originalTxId !== (history[0] || row.outbox).transaction.id)) throw Error("Invalid claim resource recovery binding");
    for (const old of history) require("./claim-resources").sameIntent(old.transaction, row.outbox.transaction);
    if (row.simulationTransactions) {
      if (!row.outbox || !Array.isArray(row.simulationTransactions) || row.simulationTransactions.length > 4)
        throw Error("Invalid claim simulation history");
      for (const tx of row.simulationTransactions) require("./claim-resources").sameIntent(tx, row.outbox.transaction);
    }
    for (const out of [...history, ...(row.outbox ? [row.outbox] : [])]) {
      if (out.hash !== P.hash(JSON.stringify(out.transaction)) || out.rcLimit !== out.transaction.header.rc_limit ||
          out.nonce !== O.nonce(out.transaction.header.nonce)) throw Error("Damaged reward transaction");
      P.integer(out.attempts, 0, this.#policy.maxAttempts); P.integer(out.createdAt);
      if (out.lastAttemptAt !== null) P.integer(out.lastAttemptAt, out.createdAt, row.updatedAt);
      if ((out.attempts === 0) !== (out.lastAttemptAt === null) || !Array.isArray(out.days) ||
          new Set(out.days).size !== out.days.length || (out.attempts === 0) !== (out.days.length === 0) || out.days.length > out.attempts) throw Error("Damaged reward attempt history");
      for (const day of out.days) {
        if (uint(day) > BigInt(Math.floor(out.lastAttemptAt / DAY)) ||
            this.#db.prepare("SELECT amount FROM mana WHERE day=? AND id=?").get(day, out.reservationId || id)?.amount !== out.rcLimit) throw Error("Reward sponsorship journal mismatch");
      }
      if (out.reservationId && out.reservationId !== id + ":" + out.transaction.id) throw Error("Invalid claim resource reservation identity");
    }
    if (!row.outbox && !["queued", "signing", "paid_elsewhere"].includes(row.state)) throw Error("Missing reward transaction");
    return row;
  }
  importManifest(envelope) {
    const manifest = M.verify(envelope, this.#target), epoch = manifest.envelope.manifest.epoch;
    return this.#tx(() => {
      this.#time();
      const prior = this.#db.prepare("SELECT hash FROM manifests WHERE epoch=?").get(epoch);
      if (prior && prior.hash !== manifest.hash) throw Error("Cannot replace an admitted reward day");
      const ids = manifest.claims.map(c => P.hash(manifest.hash + ":" + c.address));
      if (prior) { ids.forEach(id => this.#row(id)); return ids; }
      const pending = this.#db.prepare("SELECT COUNT(*) AS n FROM claims WHERE state NOT IN ('paid','paid_elsewhere')").get().n;
      if (pending + ids.length > 1024) throw Error("Reward queue capacity reached");
      this.#db.prepare("INSERT INTO manifests VALUES (?, ?, ?)").run(epoch, manifest.hash, JSON.stringify(manifest.envelope));
      manifest.claims.forEach((claim, i) => this.#save({ id: ids[i], epoch, manifestHash: manifest.hash, claim,
        state: "queued", reason: null, outbox: null, finality: null }));
      return ids;
    });
  }
  next() {
    return this.#db.prepare("SELECT id FROM claims WHERE state NOT IN ('queued','paid','paid_elsewhere') ORDER BY rowid LIMIT 1").get()?.id ||
      this.#db.prepare("SELECT id FROM claims WHERE state='queued' ORDER BY rowid LIMIT 1").get()?.id || null;
  }
  status(id) {
    const r = this.#row(id);
    return { id, epoch: r.epoch, account: r.claim.address, availability: r.claim.availability, work: r.claim.work,
      state: r.state, reason: r.reason, txId: done(r.state) && r.finality?.txId ? r.finality.txId : r.outbox?.transaction.id || null, attempts: r.outbox?.attempts || 0,
      ...(r.resourceRecovery && { resourceRecovery: { originalTxId: r.resourceRecovery.originalTxId,
        previousAttempts: (r.resourceHistory || []).reduce((sum, out) => sum + out.attempts, 0) } }),
      ...(r.outbox?.lastSubmission && { lastSubmission: structuredClone(r.outbox.lastSubmission) }),
      finality: r.finality, mode: rewardMode(this.#target), paymentsEnabled: this.#target.chainId === MAINNET_CHAIN };
  }
  recordSubmission(id, txId, { outcome, error = null }) {
    if (!["acknowledged", "unknown"].includes(outcome)) throw Error("Invalid submission outcome");
    this.#tx(() => {
      const r = this.#row(id);
      if (!r.outbox || r.outbox.transaction.id !== txId || !r.outbox.attempts) throw Error("Saved attempted envelope required");
      r.outbox.lastSubmission = { at: this.#time(), outcome, error: error === null ? null : require("./rpc-transport").safeError(error) };
      this.#save(r);
    });
  }
  async operation(id) {
    const r = this.#row(id), c = r.claim, enc = utils.encodeBase64url;
    // sdk-as omits protobuf defaults on re-encoding. Explicit uint64 "0"
    // fields from protobufjs would fail the contract's canonical-wire check.
    const amounts = value => ({ ...(value.availability !== "0" && { availability: value.availability }),
      ...(value.work !== "0" && { work: value.work }) });
    const args = { ...(r.epoch !== "0" && { epoch: r.epoch }), account: enc(utils.decodeBase58(c.address)), ...amounts(c),
      proof: c.proof.map(p => ({ hash: enc(Buffer.from(p.hash, "hex")), ...amounts(p), ...(p.left && { left: true }) })) };
    return { contract_id: this.#target.rewards, entry_point: ABI.methods.claim.entry_point,
      args: enc(await this.#serializer.serialize(args, "koin.Request")) };
  }
  #eligible(row, evidence, operationHash) {
    if (evidence.state !== "verified") return { action: "wait", reason: "reward_" + evidence.state };
    if (evidence.scope !== "reward_claim") throw Error("Completion evidence cannot authorize a reward claim; exact claim intent required");
    assertRewardIntentEvidence(evidence, { target: this.#target, scope: "reward_claim", epoch: row.epoch,
      method: "claim", account: row.claim.address, operationHash, now: this.#clock(), claimAmount: add(row.claim.availability, row.claim.work).toString() });
    if (P.integer(this.#clock()) < evidence.checkedAt || this.#clock() - evidence.checkedAt > 5000 ||
        evidence.account !== row.claim.address) throw Error("Stale reward evidence");
    const e = evidence.epoch, manifest = this.#manifest(row.epoch).envelope.manifest;
    if (e.expired) return { action: "review", reason: "expired_epoch" };
    if (!e.finalized) return { action: "wait", reason: "root_under_review" };
    const root = e.root;
    if (!root || Buffer.from(root.hash, "base64url").toString("hex") !== manifest.root.hash ||
        (root.availability ?? "0") !== manifest.root.availability || (root.work ?? "0") !== manifest.root.work ||
        uint(row.claim.work) > require("./policy").workCap({ basis: this.#target.rewardBasis, budget: e.work_budget, spent: evidence.spent, totalSpent: evidence.totalSpent, workCapBps: this.#target.workCapBps }) ||
        BigInt(P.integer(this.#clock())) < uint(e.review_until) || uint(evidence.chainTime) < uint(e.review_until)) throw Error("Final reward proof, paid work cap or review hold mismatch");
    if (!evidence.claimed && uint(evidence.liveCustody.liabilities) < add(row.claim.availability, row.claim.work)) throw Error("Unfunded reward entitlement");
    return null;
  }
  async advance(id) {
    const initial = this.#row(id);
    if (done(initial.state)) return { ...this.status(id), action: "done" };
    const operation = await this.operation(id);
    const operationHash = P.hash(JSON.stringify(operation));
    const versions = [...new Map([...(initial.outbox ? [initial.outbox] : []), ...(initial.resourceHistory || []),
      ...(initial.simulationTransactions || []).map(transaction => ({ transaction }))].map(out => [out.transaction.id, out])).values()];
    let finality = null;
    for (const out of versions) {
      await O.validateSigned(out.transaction, { target: this.#target, policy: this.#envelopePolicy(), operation });
      const proof = await this.#observer.verifyClaim(out.transaction.id, operation);
      if (["finalized", "reverted"].includes(proof.state)) {
        if (["finalized", "reverted"].includes(finality?.state)) throw Error("Conflicting irreversible claim resource revisions");
        finality = proof;
      } else if (!finality || (finality.state === "unknown" && proof.state !== "unknown")) finality = proof;
    }
    if (["finalized", "reverted"].includes(finality?.state) && !versions.some(out => out.transaction.id === finality.txId))
      throw Error("Exact saved claim finality required");
    let unavailable = null;
    if (finality?.state === "unknown" && !["needs_review", "signing"].includes(initial.state) &&
        initial.outbox.attempts < this.#policy.maxAttempts &&
        (initial.outbox.lastAttemptAt === null || this.#time() - initial.outbox.lastAttemptAt >= this.#policy.minRetryMs)) {
      unavailable = await this.#preflight(structuredClone(initial.outbox.transaction));
      if (unavailable !== null && !["claim_nonce_unavailable", "claim_mana_recharging"].includes(unavailable)) throw Error("Invalid claim resource decision");
    }
    const evidence = await this.#observer.inspectClaim({ epoch: initial.epoch, account: initial.claim.address, operationHash,
      minimumHeight: ["finalized", "reverted"].includes(finality?.state) ? finality.height : "0" });
    const result = this.#tx(() => {
      const r = this.#row(id); this.#time();
      if (done(r.state)) return { action: "done" };
      // A concurrent signing/staging transition invalidates the earlier reads.
      if ((r.outbox?.hash || null) !== (initial.outbox?.hash || null)) return { action: "wait" };
      const eligibility = this.#eligible(r, evidence, operationHash); if (eligibility) return eligibility;
      if (finality?.state === "finalized" || finality?.state === "reverted") {
        if (uint(evidence.height) < uint(finality.height)) return { action: "wait", reason: "claim_state_finality" };
        if (finality.state === "finalized" && !evidence.claimed) throw Error("Finalized claim is missing its irreversible claimed state");
        r.finality = finality;
        r.state = evidence.claimed ? (finality.state === "finalized" ? "paid" : "paid_elsewhere") : "needs_review";
        r.reason = evidence.claimed ? null : "finalized_revert"; this.#save(r);
        return { action: evidence.claimed ? "done" : "review" };
      }
      if (evidence.claimed) {
        r.state = r.outbox || r.state === "signing" ? "needs_review" : "paid_elsewhere";
        // Keep an unresolved sponsor nonce fenced even if a manual relayer paid.
        if (r.state === "needs_review" && !r.outbox) return { action: "review", reason: "claim_paid_during_signing" };
        r.reason = r.outbox ? "claimed_with_unresolved_sponsor_nonce" : null; this.#save(r);
        return { action: done(r.state) ? "done" : "review" };
      }
      if (r.state === "signing") return { action: "review", reason: "recover_signing_envelope" };
      if (r.state === "resource_signing" && finality?.state !== "unknown")
        return { action: "wait", reason: "resource_recovery_awaiting_finality" };
      if (r.state === "resource_signing") return { action: "prepare_resource_claim", operation, payer: this.#policy.payer,
        originalTxId: r.resourceRecovery.originalTxId, maxRc: this.#resourceCeiling };
      if (r.state === "needs_review" && r.reason === "attempt_limit" && !r.resourceRecovery &&
          finality?.state === "unknown" && uint(r.outbox.rcLimit) < uint(this.#resourceCeiling) &&
          r.outbox.lastSubmission?.error === "KOIN RPC rejected the transaction: insufficient rc.") {
        r.resourceRecovery = { originalTxId: r.outbox.transaction.id };
        r.state = "resource_signing"; r.reason = "claim_resource_recovery"; this.#save(r);
        return { action: "prepare_resource_claim", operation, payer: this.#policy.payer,
          originalTxId: r.resourceRecovery.originalTxId, maxRc: this.#resourceCeiling };
      }
      if (r.state === "needs_review") return { action: "review" };
      if (!r.outbox) {
        const active = this.#db.prepare("SELECT id FROM claims WHERE state NOT IN ('queued','paid','paid_elsewhere') LIMIT 1").get();
        if (active) return { action: "wait", reason: "sponsor_nonce_busy" };
        r.state = "signing"; this.#save(r);
        return { action: "prepare_claim", operation, chainId: this.#target.chainId, payer: this.#policy.payer,
          maxRc: this.#resourceCeiling };
      }
      r.finality = finality;
      if (finality.state !== "unknown") { r.state = finality.state; this.#save(r); return { action: "wait" }; }
      const out = r.outbox, now = this.#time();
      if (out.attempts >= this.#policy.maxAttempts) { r.state = "needs_review"; r.reason = "attempt_limit"; this.#save(r); return { action: "review" }; }
      if (out.lastAttemptAt !== null && now - out.lastAttemptAt < this.#policy.minRetryMs) return { action: "wait", reason: "retry_delay" };
      if (unavailable) { r.reason = unavailable; this.#save(r); return { action: "wait", reason: unavailable }; }
      const day = String(Math.floor(now / DAY));
      if (!out.days.includes(day)) {
        const budget = this.sponsorshipStatus(now);
        if (uint(budget.reservedToday) + uint(out.rcLimit) > uint(budget.maxRcPerDay)) return { action: "wait", reason: "sponsorship_budget" };
        this.#db.prepare("INSERT INTO mana VALUES (?, ?, ?)").run(day, out.reservationId || id, out.rcLimit); out.days.push(day);
      }
      out.attempts++; out.lastAttemptAt = now; r.state = "unknown"; r.reason = null; this.#save(r);
      return { action: "submit_exact_transaction", transaction: structuredClone(out.transaction) };
    });
    if (result.action === "done") this.#observer.forget({ epoch: initial.epoch, account: initial.claim.address });
    return { ...this.status(id), ...result };
  }
  async #validateAlternatives(transaction, alternatives, operation) {
    if (!Array.isArray(alternatives) || alternatives.length > 4) throw Error("Bounded claim simulation history required");
    for (const tx of alternatives) {
      await O.validateSigned(tx, { target: this.#target, policy: this.#envelopePolicy(), operation });
      require("./claim-resources").sameIntent(transaction, tx);
    }
    return structuredClone(alternatives);
  }
  async stage(id, transaction, alternatives = []) {
    const validated = await O.validateSigned(transaction, { target: this.#target, policy: this.#envelopePolicy(), operation: await this.operation(id) });
    const simulations = await this.#validateAlternatives(transaction, alternatives, await this.operation(id));
    const hash = P.hash(JSON.stringify(validated.transaction));
    this.#tx(() => {
      const r = this.#row(id);
      if (r.outbox) { if (r.outbox.hash !== hash) throw Error("Cannot replace signed reward transaction"); return; }
      if (r.state !== "signing") throw Error("Claim must pass irreversible review before signing");
      for (const other of this.#db.prepare("SELECT id FROM claims WHERE tx_id IS NOT NULL").all()) {
        const prior = this.#row(other.id);
        if (!done(prior.state) || uint(validated.nonce) <= uint(prior.outbox.nonce)) throw Error("Claim sponsor nonce cannot be reused or bypass recovery");
      }
      r.outbox = { transaction: validated.transaction, hash, nonce: validated.nonce, rcLimit: validated.rcLimit,
        attempts: 0, days: [], lastAttemptAt: null, createdAt: this.#time() };
      if (simulations.length) r.simulationTransactions = simulations;
      r.state = "staged"; this.#save(r);
    });
    return this.status(id);
  }
  async stageResourceRecovery(id, transaction, alternatives = []) {
    const v = await O.validateSigned(transaction, { target: this.#target, policy: this.#envelopePolicy(), operation: await this.operation(id) });
    const simulations = await this.#validateAlternatives(transaction, alternatives, await this.operation(id));
    const hash = P.hash(JSON.stringify(v.transaction));
    this.#tx(() => {
      const r = this.#row(id);
      if (r.resourceHistory?.length && r.outbox.hash === hash) return;
      if (r.state !== "resource_signing" || r.resourceHistory?.length || !r.resourceRecovery ||
          r.outbox.transaction.id !== r.resourceRecovery.originalTxId || v.nonce !== r.outbox.nonce ||
          uint(v.rcLimit) <= uint(r.outbox.rcLimit)) throw Error("Exact single claim resource recovery required");
      require("./claim-resources").sameIntent(r.outbox.transaction, v.transaction);
      r.resourceHistory = [r.outbox];
      r.simulationTransactions = [...new Map([...(r.simulationTransactions || []), ...simulations].map(tx => [tx.id, tx])).values()];
      if (r.simulationTransactions.length > 4) throw Error("Claim simulation history exceeds its bound");
      r.outbox = { transaction: v.transaction, hash, nonce: v.nonce, rcLimit: v.rcLimit,
        attempts: 0, days: [], lastAttemptAt: null, createdAt: this.#time(), reservationId: id + ":" + v.transaction.id };
      r.state = "staged"; r.reason = null; this.#save(r);
    });
    return this.status(id);
  }
  close() { this.#db.close(); }
}
module.exports = { RewardClaims };
