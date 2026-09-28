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
  async reconcile() {
    for (const { id } of this.#db.prepare("SELECT id FROM signatures WHERE state='signed' LIMIT 16").all()) {
      const r = this.#get(id), proof = await inspectFinality(this.#client.provider, { chainId: this.#client.d.chainId,
        txId: r.transaction.id, expectedOperation: r.transaction.operations[0].call_contract });
      if (["finalized", "reverted"].includes(proof.state)) {
        const blocks = await this.#client.provider.getBlocksById([proof.blockId], { returnBlock: true, returnReceipt: true });
        const block = blocks.block_items?.find(b => b.block_id === proof.blockId), receipt = block?.receipt?.transaction_receipts?.find(t => t.id === r.transaction.id);
        if (!receipt || receipt.payer !== r.transaction.header.payer || uint(receipt.rc_used || "0") > uint(r.transaction.header.rc_limit)) throw Error("Missing finalized resource receipt");
        const resources = { payer: receipt.payer, used: String(receipt.rc_used || "0"), limit: r.transaction.header.rc_limit,
          day: String(Math.floor(Number(block.block.header.timestamp) / 86400000)) };
        this.#guard.write(this.#db, () => {
          const current = this.#get(id); current.state = proof.state; current.finality = proof; current.resources = resources; this.#save(current);
        });
      }
    }
  }
  envelope(id) { return structuredClone(this.#get(id)?.transaction || null); }
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
