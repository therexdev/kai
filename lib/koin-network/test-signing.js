"use strict";
const { isDeepStrictEqual } = require("node:util");
const fs = require("fs"), path = require("path");
const { DatabaseSync } = require("node:sqlite"), { Transaction, Signer } = require("koilib");
const { JournalSet } = require("./journal-set"), { assertPaymentMode } = require("./payment-mode");
const { inspectFinality } = require("./finality"), P = require("./job-protocol"), { uint } = require("./policy");
class TestSigning {
  #db; #guard; #client; #signers;
  constructor(directory, { client, signers, mode = "test-deployment" }) {
    assertPaymentMode(mode, client); this.#client = client; this.#signers = signers;
    this.#guard = new JournalSet(directory, { files: ["test-signing.sqlite"] });
    try {
      const file = path.join(directory, "test-signing.sqlite"); this.#db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
      this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS signatures(id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,hash TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_nonce ON signatures(owner) WHERE state IN ('signing','signed');`);
      this.#guard.attach(this.#db);
      const identity = JSON.stringify({ deployment: client.d, signers: Object.keys(signers).sort() }), old = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
      if (old && old.data !== identity) throw Error("Test signing identity changed; drain queues before key rotation");
      if (!old) this.#guard.write(this.#db, () => this.#db.prepare("INSERT INTO identity VALUES(1,?)").run(identity));
    } catch (e) { this.#db?.close(); this.#guard.close(); throw e; }
  }
  #get(id) {
    const r = this.#db.prepare("SELECT * FROM signatures WHERE id=?").get(P.digest(id)); if (!r) return null;
    if (r.hash !== P.hash(r.data)) throw Error("Damaged Test signing journal");
    const v = JSON.parse(r.data); if (v.id !== id || v.state !== r.state || v.owner !== r.owner) throw Error("Changed Test signing binding"); return v;
  }
  #save(r) { const text = JSON.stringify(r); this.#db.prepare("INSERT OR REPLACE INTO signatures VALUES(?,?,?,?,?)").run(r.id, r.owner, r.state, text, P.hash(text)); }
  async prepare(id, { operation, owner, payer = owner, maxRc, signers = [owner] }) {
    P.digest(id); if (!uint(maxRc) || new Set(signers).size !== signers.length || !signers.includes(owner) || !signers.includes(payer) || signers.some(a => !this.#signers[a])) throw Error("Exact Test signing roles required");
    const scope = P.hash(JSON.stringify({ operation, owner, payer, maxRc, signers })), existing = this.#get(id);
    if (existing) {
      if (existing.scope !== scope) throw Error("Cannot replace an uncertain Test transaction");
      if (!existing.transaction) throw Error("Test signature response missing; recover the original envelope before resuming");
      return structuredClone(existing.transaction);
    }
    await this.#client.verify();
    const transaction = await Transaction.prepareTransaction({ header: { chain_id: this.#client.d.chainId, payer,
      ...(owner === payer ? {} : { payee: owner }), rc_limit: maxRc }, operations: [{ call_contract: structuredClone(operation) }], signatures: [] }, this.#client.provider);
    this.#guard.write(this.#db, () => {
      if (this.#get(id)) throw Error("Another Test signer reserved this request");
      if (this.#db.prepare("SELECT 1 FROM signatures WHERE owner=? AND state IN ('signing','signed')").get(owner)) throw Error("Unresolved Test signing nonce");
      if (this.#db.prepare("SELECT 1 FROM signatures WHERE owner=? AND json_extract(data,'$.draft.header.nonce')=?").get(owner, transaction.header.nonce)) throw Error("Test signer nonce already used");
      this.#save({ id, owner, scope, state: "signing", signers, draft: transaction, transaction: null });
    });
    for (const address of signers) await this.#signers[address].signTransaction(transaction);
    return this.stage(id, transaction);
  }
  async stage(id, transaction) {
    const tx = structuredClone(transaction), r = this.#get(id);
    if (!r || tx.id !== r.draft.id || !isDeepStrictEqual({ ...tx, signatures: [] }, r.draft) ||
        (await Transaction.prepareTransaction(structuredClone(tx))).id !== tx.id) throw Error("Original Test envelope required");
    const addresses = await Signer.recoverAddresses(tx);
    if (addresses.length !== r.signers.length || new Set(addresses).size !== addresses.length || r.signers.some(a => !addresses.includes(a))) throw Error("Exact Test signatures required");
    return this.#guard.write(this.#db, () => {
      const current = this.#get(id);
      if (current.transaction && !isDeepStrictEqual(current.transaction, tx)) throw Error("Cannot replace Test signed bytes");
      if (current.state === "signing") { current.state = "signed"; current.transaction = tx; this.#save(current); }
      return structuredClone(current.transaction);
    });
  }
  #claim(r, operation) {
    const tx = r?.transaction, op = tx?.operations?.[0]?.call_contract;
    if (!r || r.signers.length !== 1 || r.signers[0] !== r.owner || tx.header.payer !== r.owner || tx.header.payee ||
        tx.operations.length !== 1 || op?.contract_id !== this.#client.d.rewards ||
        op.entry_point !== require("./rewards-abi.json").methods.claim.entry_point || !isDeepStrictEqual(op, operation))
      throw Error("Resource estimation is restricted to the exact sponsor-signed reward claim");
    return tx;
  }
  async #simulateClaim(tx) {
    return require("./claim-resources").receipt(tx,
      await this.#client.provider.call("chain.submit_transaction", { transaction: structuredClone(tx), broadcast: false }));
  }
  async #reviseClaim(id, operation, limit, cap) {
    const R = require("./claim-resources"), r = this.#get(id), old = this.#claim(r, operation);
    if (r.state !== "signed" || uint(limit) > uint(cap) || !uint(limit)) throw Error("Signed claim resource fence required");
    if (r.resourceDraft && r.resourceDraft.header.rc_limit !== limit) throw Error("Resume the saved resource draft first");
    if (old.header.rc_limit === limit && !r.resourceDraft) return structuredClone(old);
    if ((r.resourceHistory || []).length >= 4) throw Error("Claim resource revision bound reached");
    await this.#client.verify();
    // An empty lookup is NOT proof of failure. Every candidate has the same
    // nonce and exact claim operation; keep every envelope and observe them all.
    for (const tx of [old, ...(r.resourceHistory || []).map(v => v.transaction)]) {
      const proof = await inspectFinality(this.#client.provider, { chainId: this.#client.d.chainId,
        txId: tx.id, expectedOperation: operation });
      if (proof.state !== "unknown") throw R.wait("Claim resource revision is waiting for chain reconciliation");
    }
    const [current, rc] = await Promise.all([
      this.#client.provider.getNonce(r.owner), this.#client.provider.getAccountRc(r.owner),
    ]);
    if (!Number.isSafeInteger(current) || current < 0 ||
        BigInt(current) + 1n !== BigInt(require("./settlement-outbox").nonce(old.header.nonce)))
      throw R.wait("Claim resource revision nonce is unavailable");
    if (uint(String(rc)) < uint(limit)) throw R.wait("Claim resource revision is waiting for sponsor Mana");
    const draft = r.resourceDraft || await Transaction.prepareTransaction({
      header: { ...old.header, rc_limit: limit }, operations: structuredClone(old.operations), signatures: [],
    });
    R.sameIntent(old, draft);
    if (!r.resourceDraft) this.#guard.write(this.#db, () => {
      const live = this.#get(id);
      if (live.state !== "signed" || live.transaction.id !== old.id || live.resourceDraft)
        throw Error("Claim signing journal changed during resource review");
      live.resourceDraft = draft; this.#save(live);
    });
    // A crash keeps the original and the exact unsigned replacement draft.
    // Resuming signs this same intent/nonce, never a newly selected payment.
    const signed = structuredClone(draft); await this.#signers[r.owner].signTransaction(signed);
    if ((await Transaction.prepareTransaction(structuredClone(signed))).id !== draft.id ||
        !isDeepStrictEqual(await Signer.recoverAddresses(signed), [r.owner])) throw Error("Invalid resource revision signature");
    return this.#guard.write(this.#db, () => {
      const live = this.#get(id);
      if (live.state !== "signed" || live.transaction.id !== old.id || !isDeepStrictEqual(live.resourceDraft, draft))
        throw Error("Claim signing journal changed before resource staging");
      live.resourceHistory = [...(live.resourceHistory || []), { transaction: live.transaction, draft: live.draft }];
      live.transaction = signed; live.draft = draft; delete live.resourceDraft;
      this.#save(live); return structuredClone(signed);
    });
  }
  async #estimateClaim(id, operation, floor, cap) {
    const R = require("./claim-resources");
    let r = this.#get(id), tx = this.#claim(r, operation);
    if (["finalized", "reverted"].includes(r.state)) return structuredClone(tx);
    if (r.resourceDraft) tx = await this.#reviseClaim(id, operation, r.resourceDraft.header.rc_limit, cap);
    const used = await this.#simulateClaim(tx), limit = R.estimatedLimit(used, floor, cap);
    // A successfully staged estimate is stable across retries/restarts. Do not
    // repeatedly resize signed bytes as resource prices fluctuate.
    r = this.#get(id);
    if (r.resourceEstimate?.txId === tx.id) return tx;
    if (limit !== tx.header.rc_limit) tx = await this.#reviseClaim(id, operation, limit, cap);
    const checked = await this.#simulateClaim(tx);
    this.#guard.write(this.#db, () => {
      const live = this.#get(id);
      if (live.state !== "signed" || live.transaction.id !== tx.id) throw Error("Claim changed before simulation checkpoint");
      live.resourceEstimate = { txId: tx.id, rcUsed: checked, rcLimit: tx.header.rc_limit, ceiling: cap };
      this.#save(live);
    });
    return tx;
  }
  async prepareEstimatedClaim(id, options) {
    const existing = this.#get(id);
    // An upgrade can find an old envelope signed before its claim was staged.
    // Preserve that exact legacy scope; ordinary rejection recovery handles it.
    const legacy = { ...options, maxRc: options.floorRc };
    const legacyScope = P.hash(JSON.stringify({ operation: options.operation, owner: options.owner,
      payer: options.payer || options.owner, maxRc: options.floorRc, signers: options.signers || [options.owner] }));
    if (existing && existing.scope === legacyScope && options.floorRc !== options.maxRc)
      return this.prepare(id, legacy);
    await this.prepare(id, options);
    return this.#estimateClaim(id, options.operation, options.floorRc, options.maxRc);
  }
  async recoverClaimResources(id, { operation, originalTxId, maxRc }) {
    const R = require("./claim-resources"), r = this.#get(id);
    const current = this.#claim(r, operation);
    if (r.resourceRecovery) {
      if (r.resourceRecovery.originalTxId !== originalTxId || r.resourceRecovery.ceiling !== maxRc)
        throw Error("Claim resource recovery authorization changed");
      if (r.state === "finalized" || r.state === "reverted") return structuredClone(current);
    } else {
      if (r.state !== "signed" || current.id !== originalTxId || uint(maxRc) <= uint(current.header.rc_limit))
        throw Error("Exact rejected claim and a higher bounded resource ceiling required");
      try { await this.#simulateClaim(current); throw R.wait("Original claim now simulates successfully; exact-transaction review required"); }
      catch (error) { if (!R.insufficient(error)) throw error; }
      this.#guard.write(this.#db, () => {
        const live = this.#get(id);
        if (live.state !== "signed" || live.transaction.id !== originalTxId || live.resourceRecovery)
          throw Error("Claim changed before resource recovery");
        live.resourceRecovery = { originalTxId, originalLimit: current.header.rc_limit, ceiling: maxRc };
        this.#save(live);
      });
    }
    let live = this.#get(id);
    if (live.resourceDraft) await this.#reviseClaim(id, operation, live.resourceDraft.header.rc_limit, maxRc);
    live = this.#get(id);
    if (live.transaction.id === originalTxId) await this.#reviseClaim(id, operation, maxRc, maxRc);
    return this.#estimateClaim(id, operation, String(uint(live.resourceRecovery.originalLimit) + 1n), maxRc);
  }
  async reconcile() {
    for (const { id } of this.#db.prepare("SELECT id FROM signatures WHERE state='signed' LIMIT 16").all()) {
      const r = this.#get(id);
      let proof, winner;
      const versions = [...new Map([r.transaction, ...(r.resourceHistory || []).map(v => v.transaction)].map(tx => [tx.id, tx])).values()];
      for (const tx of versions) {
        require("./claim-resources").sameIntent(r.transaction, tx);
        const p = await inspectFinality(this.#client.provider, { chainId: this.#client.d.chainId,
          txId: tx.id, expectedOperation: tx.operations[0].call_contract });
        if (["finalized", "reverted"].includes(p.state)) {
          if (winner) throw Error("Conflicting irreversible claim resource revisions");
          proof = p; winner = tx;
        }
      }
      if (["finalized", "reverted"].includes(proof?.state)) {
        const blocks = await this.#client.provider.getBlocksById([proof.blockId], { returnBlock: true, returnReceipt: true });
        const block = blocks.block_items?.find(b => b.block_id === proof.blockId), receipt = block?.receipt?.transaction_receipts?.find(t => t.id === winner.id);
        if (!receipt || receipt.payer !== winner.header.payer || uint(receipt.rc_used || "0") > uint(winner.header.rc_limit)) throw Error("Missing finalized resource receipt");
        const resources = { payer: receipt.payer, used: String(receipt.rc_used || "0"), limit: winner.header.rc_limit,
          day: String(Math.floor(Number(block.block.header.timestamp) / 86400000)) };
        this.#guard.write(this.#db, () => {
          const current = this.#get(id); current.state = proof.state; current.finality = proof; current.resources = resources; this.#save(current);
        });
      }
    }
  }
  envelope(id) { return structuredClone(this.#get(id)?.transaction || null); }
  claimAlternatives(id) {
    return structuredClone([...new Map((this.#get(id)?.resourceHistory || []).map(v => [v.transaction.id, v.transaction])).values()]);
  }
  statusFor(id) { const r = this.#get(id); return r ? { id: r.id, state: r.state, owner: r.owner } : null; }
  status() { return this.#db.prepare("SELECT id,owner,state FROM signatures ORDER BY rowid DESC LIMIT 64").all(); }
  resourceUsage() {
    const totals = new Map();
    for (const { id } of this.#db.prepare("SELECT id FROM signatures WHERE state IN ('finalized','reverted')").all()) {
      const r = this.#get(id).resources; if (!r) continue;
      const key = r.day + ":" + r.payer, row = totals.get(key) || { day: r.day, payer: r.payer, transactions: 0, used: 0n, limits: 0n };
      row.transactions++; row.used += uint(r.used); row.limits += uint(r.limit); totals.set(key, row);
    }
    return [...totals.values()].map(r => ({ ...r, used: String(r.used), limits: String(r.limits) }));
  }
  close() { this.#db.close(); this.#guard.close(); }
}
module.exports = { TestSigning };
