"use strict";
const { isDeepStrictEqual } = require("node:util");
const fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
const { Transaction, Signer } = require("koilib"), { JournalSet } = require("./journal-set"), P = require("./job-protocol");
const { FOUNDATION_CHAIN, FOUNDATION_TOKEN } = require("./payment-mode");
class TestDeployer {
  constructor(directory, { provider, identity, tokenHash }) {
    if (!/^0x1220[a-f0-9]{64}$/.test(tokenHash)) throw Error("Pin native Test KOIN bytecode"); this.tokenHash = tokenHash;
    this.provider = provider; this.identity = identity;
    this.guard = new JournalSet(directory, { files: ["deployment.sqlite"] });
    try {
      const file = path.join(directory, "deployment.sqlite"); this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS steps(id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,hash TEXT NOT NULL);
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
    const r = JSON.parse(row.data); if (r.id !== id || r.state !== row.state || r.owner !== row.owner) throw Error("Deployment binding changed"); return r;
  }
  save(r) { const text = JSON.stringify(r); this.db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?,?,?)").run(r.id, r.owner, r.state, text, P.hash(text)); }
  async pins() {
    if (await this.provider.getChainId() !== FOUNDATION_CHAIN || (await this.provider.invokeGetContractAddress("koin"))?.value?.address !== FOUNDATION_TOKEN || (await this.provider.invokeGetContractMetadata(FOUNDATION_TOKEN))?.value?.hash !== this.tokenHash) throw Error("Foundation testnet identity mismatch");
  }
  async prepare(id, operations, signer, rcLimit) {
    await this.pins(); const owner = signer.getAddress(), scope = P.hash(JSON.stringify({ operations, owner, rcLimit })), old = this.get(id);
    if (old) { if (old.scope !== scope) throw Error("Cannot change a saved deployment step"); return old; }
    const draft = await Transaction.prepareTransaction({ header: { chain_id: FOUNDATION_CHAIN, payer: owner, rc_limit: rcLimit }, operations, signatures: [] }, this.provider);
    this.guard.write(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM steps WHERE owner=? AND state IN ('signing','signed')").get(owner)) throw Error("Recover the previous deployment transaction first");
      this.save({ id, owner, scope, state: "signing", draft, transaction: null, attempts: 0, lastAttempt: null });
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
    if (approvedPlan !== this.identity) throw Error("Review and pass the exact deployment plan hash");
    await this.pins(); const state = await this.reconcile(id); if (state.state === "finalized") return state;
    if (state.state !== "signed") throw Error("Recover the original deployment signature; do not sign again");
    const tx = this.guard.write(this.db, () => {
      const r = this.get(id); if (r.attempts >= 3 || (r.lastAttempt && Date.now() - r.lastAttempt < 10000)) throw Error("Deployment retry limit reached");
      r.attempts++; r.lastAttempt = Date.now(); this.save(r); return r.transaction;
    });
    try { await this.provider.call("chain.submit_transaction", { transaction: tx, broadcast: true }); } catch { /* Acknowledgment is uncertain; the journal keeps the exact envelope. */ }
    return this.get(id);
  }
  close() { this.db.close(); this.guard.close(); }
}
module.exports = { TestDeployer };
