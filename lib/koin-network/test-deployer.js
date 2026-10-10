"use strict";
const { isDeepStrictEqual } = require("node:util");
const fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
const { Transaction, Signer } = require("koilib"), { JournalSet } = require("./journal-set"), P = require("./job-protocol");
const { decimal } = require("../kai-earned-snapshot");
const { FOUNDATION_CHAIN, FOUNDATION_TOKEN, MAINNET_CHAIN, MAINNET_TOKEN } = require("./payment-mode");
class TestDeployer {
  constructor(directory, { provider, identity, tokenHash, mode = "test-deployment" }) {
    if (!/^0x1220[a-f0-9]{64}$/.test(tokenHash)) throw Error("Pin native Test KOIN bytecode"); this.tokenHash = tokenHash;
    if (!["test-deployment", "mainnet-pilot"].includes(mode)) throw Error("Explicit pinned deployment mode required");
    this.mode = mode;
    this.chainId = mode === "mainnet-pilot" ? MAINNET_CHAIN : FOUNDATION_CHAIN;
    this.token = mode === "mainnet-pilot" ? MAINNET_TOKEN : FOUNDATION_TOKEN;
    this.provider = provider; this.identity = identity;
    this.guard = new JournalSet(directory, { files: ["deployment.sqlite"] });
    try {
      const file = path.join(directory, "deployment.sqlite"); this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS steps(id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resource_revision(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,hash TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS active_owner ON steps(owner) WHERE state IN ('signing','signed');`);
      this.guard.attach(this.db);
      const old = this.db.prepare("SELECT data FROM identity WHERE id=1").get();
      if (old && old.data !== identity) throw Error("Deployment plan changed");
      if (!old) this.guard.write(this.db, () => this.db.prepare("INSERT INTO identity VALUES(1,?)").run(identity));
    } catch (e) { this.db?.close(); this.guard.close(); throw e; }
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM steps WHERE id=?").get(id); if (!row) return null;
    if (P.hash(row.data) !== row.hash) throw Error("Damaged deployment journal");
    const r = JSON.parse(row.data); if (r.id !== id || r.state !== row.state || r.owner !== row.owner || r.draft?.header?.chain_id !== this.chainId) throw Error("Deployment binding changed"); return r;
  }
  save(r) { const text = JSON.stringify(r); this.db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?,?,?)").run(r.id, r.owner, r.state, text, P.hash(text)); }
  resourceRevision() {
    const row = this.db.prepare("SELECT * FROM resource_revision WHERE id=1").get(); if (!row) return null;
    if (P.hash(row.data) !== row.hash) throw Error("Damaged resource revision");
    const r = JSON.parse(row.data);
    if (this.mode !== "mainnet-pilot" || r.basePlanHash !== this.identity || P.hash(JSON.stringify(r.plan)) !== r.planHash) throw Error("Resource revision binding changed");
    return r;
  }
  async reviseResources(original, rcLimit, custodyAtoms, providers) {
    const exact = n => typeof n === "string" && /^[1-9]\d{0,19}$/.test(n) && BigInt(n) <= (1n << 64n) - 1n;
    if (this.mode !== "mainnet-pilot" || original.mode !== this.mode || P.hash(JSON.stringify(original)) !== this.identity ||
        !exact(rcLimit) || !exact(custodyAtoms) || BigInt(rcLimit) <= BigInt(original.deployRcLimit) || BigInt(rcLimit) > BigInt(custodyAtoms)) throw Error("Explicit increased deployment ceiling and sufficient custody funding required");
    const plan = structuredClone(original);
    for (const role of ["credits", "rewards"]) {
      if (BigInt(custodyAtoms) < BigInt(original.funding.roles[role])) throw Error("Cannot reduce reviewed custody funding");
      plan.funding.roles[role] = custodyAtoms;
    }
    const total = Object.values(plan.funding.roles).reduce((n, v) => n + BigInt(v), BigInt(plan.funding.buyerCreditsAtoms) + BigInt(plan.funding.rewardPoolAtoms));
    if (total > BigInt(plan.funding.maxTotalKoinAtoms)) throw Error("Resource revision exceeds the original pilot budget");
    plan.funding.totalAtoms = String(total); plan.funding.totalKoin = decimal(total); plan.deployRcLimit = rcLimit;
    const planHash = P.hash(JSON.stringify(plan)), existing = this.resourceRevision();
    if (existing) {
      if (existing.planHash !== planHash) throw Error("An existing resource revision cannot be replaced");
      return existing;
    }
    const ids = this.db.prepare("SELECT id FROM steps").all(), r = this.get("credits:upload");
    if (ids.length !== 1 || !r || r.state !== "signed" || r.attempts !== 0 || r.lastAttempt !== null || r.simulation ||
        r.owner !== original.runtime.deployment.credits || r.draft.header.rc_limit !== original.deployRcLimit || r.draft.header.nonce !== "KAE=") throw Error("Resource revision requires only the first upload, signed but never broadcast");
    const op = r.draft.operations;
    if (op.length !== 1 || Object.keys(op[0]).join() !== "upload_contract" || Object.keys(op[0].upload_contract).sort().join() !== "bytecode,contract_id" ||
        op[0].upload_contract.contract_id !== r.owner || P.hash(Buffer.from(op[0].upload_contract.bytecode, "base64url")) !== original.artifacts.credits.sha256) throw Error("Original upload differs from the reviewed custody code");
    await this.stage(r.id, r.transaction);
    if (!Array.isArray(providers) || providers.length !== 2 || providers[0] === providers[1]) throw Error("Two independent mainnet RPC checks required");
    for (const provider of providers) {
      if (await provider.getChainId() !== this.chainId || (await provider.invokeGetContractAddress("koin"))?.value?.address !== this.token ||
          (await provider.invokeGetContractMetadata(this.token))?.value?.hash !== this.tokenHash) throw Error("Resource revision network identity mismatch");
      const head = await provider.getHeadInfo();
      if (!Number.isSafeInteger(Number(head.head_block_time)) || Math.abs(Date.now() - Number(head.head_block_time)) > 120000) throw Error("Stale resource revision chain head");
      const found = await provider.getTransactionsById([r.draft.id]);
      if (!found || found.error || found.rpc_error || (found.transactions !== undefined && (!Array.isArray(found.transactions) || found.transactions.length))) throw Error("Original upload lookup is uncertain or already known on chain");
      for (const role of ["credits", "rewards"]) {
        const address = original.runtime.deployment[role], meta = await provider.invokeGetContractMetadata(address);
        if (meta?.value?.hash || meta?.error || meta?.rpc_error || await provider.getNextNonce(address) !== "KAE=") throw Error("Custody account already used or its next nonce changed");
      }
    }
    const revision = { schema: 1, basePlanHash: this.identity, planHash, plan, supersededTxId: r.draft.id };
    this.guard.write(this.db, () => {
      const current = this.get(r.id);
      if (this.resourceRevision() || current.state !== "signed" || current.attempts !== 0 || current.lastAttempt !== null || !isDeepStrictEqual(current, r)) throw Error("Deployment changed during resource review");
      const data = JSON.stringify(revision);
      this.db.prepare("INSERT INTO resource_revision VALUES(1,?,?)").run(data, P.hash(data));
      current.state = "superseded"; this.save(current);
    });
    return revision;
  }
  async pins() {
    if (await this.provider.getChainId() !== this.chainId || (await this.provider.invokeGetContractAddress("koin"))?.value?.address !== this.token || (await this.provider.invokeGetContractMetadata(this.token))?.value?.hash !== this.tokenHash) throw Error("Pinned deployment network identity mismatch");
  }
  async deploymentLimit(id, ceiling, owner) {
    if (!this.resourceRevision()) return ceiling;
    const saved = this.get(id);
    if (saved && saved.state !== "superseded") return saved.draft.header.rc_limit;
    const available = BigInt(await this.provider.getAccountRc(owner));
    const limit = available < BigInt(ceiling) ? available : BigInt(ceiling);
    if (limit <= 0n) throw Error("Insufficient deployment Mana");
    return String(limit);
  }
  async prepare(id, operations, signer, rcLimit) {
    await this.pins(); const owner = signer.getAddress(), scope = P.hash(JSON.stringify({ operations, owner, rcLimit })), old = this.get(id);
    const revision = this.resourceRevision(), superseded = old?.state === "superseded";
    if (old && !superseded) { if (old.scope !== scope) throw Error("Cannot change a saved deployment step"); return old; }
    if (revision && BigInt(rcLimit) > BigInt(revision.plan.deployRcLimit)) throw Error("Deployment exceeds revised ceiling");
    if (superseded && (!revision || revision.supersededTxId !== old.draft.id || old.owner !== owner ||
        !isDeepStrictEqual(operations, old.draft.operations) || BigInt(rcLimit) <= BigInt(old.draft.header.rc_limit) ||
        await this.provider.getNextNonce(owner) !== old.draft.header.nonce)) throw Error("Only the approved resource revision with the original operations and nonce may replace this upload");
    if (this.mode === "mainnet-pilot" && BigInt(await this.provider.getAccountRc(owner)) < BigInt(rcLimit)) throw Error("Insufficient mainnet deployment Mana; no signature created");
    const draft = await Transaction.prepareTransaction({ header: { chain_id: this.chainId, payer: owner, rc_limit: rcLimit,
      ...(superseded ? { nonce: old.draft.header.nonce } : {}) }, operations, signatures: [] }, this.provider);
    this.guard.write(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM steps WHERE owner=? AND state IN ('signing','signed')").get(owner)) throw Error("Recover the previous deployment transaction first");
      this.save({ id, owner, scope, state: "signing", draft, transaction: null, attempts: 0, lastAttempt: null,
        ...(superseded ? { superseded: old } : {}) });
    });
    const transaction = structuredClone(draft); await signer.signTransaction(transaction); await this.stage(id, transaction); return this.get(id);
  }
  async stage(id, tx) {
    const r = this.get(id);
    if (!r || tx.id !== r.draft.id || !isDeepStrictEqual({ ...tx, signatures: [] }, r.draft) ||
        (await Transaction.prepareTransaction(structuredClone(tx))).id !== tx.id || (await Signer.recoverAddresses(tx)).join() !== r.owner) throw Error("Exact original deployment signature required");
    this.guard.write(this.db, () => { const current = this.get(id); if (current.transaction && !isDeepStrictEqual(current.transaction, tx)) throw Error("Cannot replace deployment signature");
      if (current.state === "signing") { current.transaction = structuredClone(tx); current.state = "signed"; this.save(current); } });
  }
  async reconcile(id) {
    await this.pins(); const r = this.get(id); if (!r || ["finalized", "reverted"].includes(r.state)) return r;
    const found = await this.provider.getTransactionsById([r.draft.id]); if (found.error || found.rpc_error) throw Error("Deployment lookup failed");
    const rows = (found.transactions || []).filter(x => x.transaction?.id === r.draft.id);
    if (!rows.length) return r; if (rows.length !== 1) throw Error("Ambiguous deployment lookup");
    await this.stage(id, rows[0].transaction);
    const head = await this.provider.getHeadInfo(), lib = BigInt(head.last_irreversible_block), now = Date.now();
    if (!Number.isSafeInteger(Number(head.head_block_time)) || Math.abs(now - Number(head.head_block_time)) > 120000 || lib > BigInt(head.head_topology.height)) throw Error("Stale deployment chain head");
    const containing = rows[0].containing_blocks;
    if (!Array.isArray(containing) || containing.length > 100) throw Error("Invalid deployment containing blocks");
    const candidates = await this.provider.getBlocksById(containing, { returnBlock: false, returnReceipt: false });
    for (const b of candidates.block_items || []) {
      if (!containing.includes(b.block_id) || BigInt(b.block_height) > lib) continue;
      const [block] = await this.provider.getBlocks(Number(b.block_height), 1, head.head_topology.id, { returnBlock: true, returnReceipt: true });
      if (block?.block_id !== b.block_id) continue;
      if (block.block?.id !== b.block_id || block.receipt?.id !== b.block_id || block.block_height !== b.block_height || block.block.header?.height !== b.block_height || block.receipt.height !== b.block_height) throw Error("Inconsistent deployment finality");
      const tx = block.block.transactions?.filter(t => t.id === r.draft.id), receipts = block.receipt.transaction_receipts?.filter(t => t.id === r.draft.id);
      if (tx?.length !== 1 || receipts?.length !== 1 || ![undefined, false, true].includes(receipts[0].reverted) || receipts[0].rpc_error) throw Error("Missing deployment receipt");
      await this.stage(id, tx[0]);
      this.guard.write(this.db, () => { const current = this.get(id); current.state = receipts[0].reverted ? "reverted" : "finalized";
        current.finality = { blockId: b.block_id, height: b.block_height, receipt: receipts[0] }; this.save(current); });
      return this.get(id);
    }
    return this.get(id);
  }
  async submit(id, approvedPlan) {
    if (approvedPlan !== (this.resourceRevision()?.planHash || this.identity)) throw Error("Review and pass the exact deployment plan hash");
    await this.pins(); const state = await this.reconcile(id); if (state.state === "finalized") return state;
    if (state.state !== "signed") throw Error("Recover the original deployment signature; do not sign again");
    let simulation;
    // Simulate the exact journaled envelope before its FIRST broadcast. Once a
    // broadcast was attempted, reconcile/retry that same envelope: its nonce
    // may already be in the mempool or on-chain, making a new simulation fail.
    if (this.mode === "mainnet-pilot" && state.attempts === 0) {
      let response;
      try { response = await this.provider.call("chain.submit_transaction", { transaction: structuredClone(state.transaction), broadcast: false }); }
      catch (e) { throw Error("Mainnet deployment simulation failed (" + id + "): " + String(e.message).slice(0, 160)); }
      const receipt = response?.receipt;
      if (response?.error || response?.rpc_error || !receipt || receipt.id !== state.draft.id || receipt.rpc_error || receipt.error ||
          ![undefined, false].includes(receipt.reverted) || typeof receipt.rc_used !== "string" || !/^[1-9]\d{0,19}$/.test(receipt.rc_used) ||
          BigInt(receipt.rc_used) > (1n << 64n) - 1n) throw Error("Invalid or reverted mainnet deployment simulation (" + id + ")");
      const used = BigInt(receipt.rc_used), limit = BigInt(state.draft.header.rc_limit), required = (used * 125n + 99n) / 100n + 10000n;
      if (required > limit) throw Error("Mainnet deployment " + id + " needs " + required + " RC with headroom; approved ceiling is " + limit + ". No broadcast attempted.");
      if (BigInt(await this.provider.getAccountRc(state.owner)) < limit) throw Error("Insufficient mainnet deployment Mana before broadcast");
      simulation = { txId: state.draft.id, rcUsed: receipt.rc_used, requiredRc: String(required), rcLimit: String(limit), checkedAt: Date.now() };
    }
    const tx = this.guard.write(this.db, () => {
      const r = this.get(id);
      if (r.state !== "signed" || r.draft.id !== state.draft.id) throw Error("Deployment changed before broadcast; review current journal");
      if (r.attempts >= 3 || (r.lastAttempt && Date.now() - r.lastAttempt < 10000)) throw Error("Deployment retry limit reached");
      if (this.mode === "mainnet-pilot" && r.attempts === 0) {
        if (!simulation || simulation.txId !== r.draft.id) throw Error("Mainnet deployment simulation required before broadcast");
        r.simulation = simulation;
      }
      r.attempts++; r.lastAttempt = Date.now(); this.save(r); return r.transaction;
    });
    try { await this.provider.call("chain.submit_transaction", { transaction: tx, broadcast: true }); } catch { /* Acknowledgment is uncertain; the journal keeps the exact envelope. */ }
    return this.get(id);
  }
  close() { this.db.close(); this.guard.close(); }
}
module.exports = { TestDeployer };
