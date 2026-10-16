"use strict";
const { Serializer, Transaction, utils } = require("koilib");
const { KoinChain, encodedAddress, fundingRequest } = require("./chain");
const { uint } = require("./policy"), { hash, integer } = require("./job-protocol");
const native = new Serializer(utils.tokenAbi.types), num = x => uint(x ?? "0");
const objectId = v => {
  if (typeof v !== "string" || !/^0x1220[a-f0-9]{64}$/.test(v)) throw Error("Invalid chain object ID");
  return v;
};
function intent(value) {
  const r = structuredClone(value);
  if (!r || Object.keys(r).sort().join() !== "actor,args,kind,maxRc,method") throw Error("Exact owner-paid funding intent required");
  fundingRequest(r.kind, r.method, r.args, r.actor);
  if (typeof r.maxRc !== "string" || !uint(r.maxRc)) throw Error("Positive funding RC limit required");
  return { kind: r.kind, method: r.method, args: { account: r.args.account, amount: r.args.amount }, actor: r.actor, maxRc: r.maxRc };
}
function response(r) {
  if (!r || typeof r !== "object" || Array.isArray(r) || r.error || r.rpc_error) throw Error("Invalid funding RPC response");
  return r;
}

// Read-only trusted-RPC observer; it is not a light client. A successful deposit
// receipt proves this deposit, not that its credits remain unspent forever.
class FundingObserver {
  #client; #clock; #snapshots = new Map();
  constructor(client, { clock = Date.now } = {}) {
    if (!(client instanceof KoinChain)) throw Error("Pinned funding client required");
    this.#client = client; this.#clock = clock;
  }
  #head(v) {
    response(v);
    const h = { id: objectId(v.head_topology?.id), height: num(v.head_topology.height).toString(),
      lib: num(v.last_irreversible_block).toString(), time: num(v.head_block_time).toString() };
    const now = BigInt(integer(this.#clock()));
    if (!uint(h.height) || uint(h.height) > BigInt(Number.MAX_SAFE_INTEGER) || uint(h.lib) > uint(h.height) ||
        uint(h.time) > now + 60000n || uint(h.time) + 120000n < now) throw Error("Stale funding RPC head");
    return h;
  }
  async #native(method, args) {
    const entry = utils.tokenAbi.methods[method];
    const r = response(await this.#client.provider.readContract({ contract_id: this.#client.d.token,
      entry_point: entry.entry_point, args: utils.encodeBase64url(await native.serialize(args, entry.argument)) }));
    if (r.result !== undefined && (typeof r.result !== "string" || r.result.length > 32768)) throw Error("Invalid native balance response");
    return native.deserialize(r.result ?? "", entry.return);
  }
  async #capture(r) {
    const c = this.#client, startedAt = integer(this.#clock());
    // RPC reads are not block-pinned. Discard the whole capture if a block
    // arrives or the RPC endpoint changes, then retry without signing/sending.
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = c.provider.readGeneration;
      const before = this.#head(await c.provider.getHeadInfo());
      const [config, balances, tokenBalance, tokenAllowance] = await Promise.all([
        c.verify(),
        // Rewards expose aggregate custody; only credits have account balances.
        c.read(r.kind, "balances", r.kind === "credits" ? { account: encodedAddress(r.actor) } : {}),
        this.#native("balanceOf", { owner: c.d[r.kind] }),
        this.#native("allowance", { owner: r.actor, spender: c.d[r.kind] }),
      ]);
      const [head, chainId] = await Promise.all([c.provider.getHeadInfo(), c.provider.getChainId()]);
      const after = this.#head(head), observedAt = integer(this.#clock());
      if (chainId !== c.d.chainId) throw Error("Funding chain mismatch");
      if (observedAt < startedAt) throw Error("Funding clock moved backwards");
      if (generation !== c.provider.readGeneration || before.id !== after.id ||
          before.height !== after.height || before.time !== after.time) continue;
      const liquid = num(tokenBalance.value), allowance = num(tokenAllowance.value);
      const liabilities = num(balances.liabilities), available = num(balances.balance?.available), reserved = num(balances.balance?.reserved);
      if (liquid !== num(balances.liquid) || liquid < liabilities ||
          (r.kind === "credits" && available + reserved > liabilities)) throw Error("Funding custody is not backed");
      const state = { config, liquid: liquid.toString(), liabilities: liabilities.toString(),
        available: available.toString(), reserved: reserved.toString(), allowance: allowance.toString() };
      return { head: after, state, hash: hash(JSON.stringify(state)), observedAt };
    }
    return null;
  }
  async inspect(value, minimumHeight = "0") {
    const r = intent(value), key = r.kind + ":" + r.actor, now = integer(this.#clock()); uint(minimumHeight);
    for (const [k, v] of this.#snapshots) if (now - v.observedAt > 900000) this.#snapshots.delete(k);
    let saved = this.#snapshots.get(key);
    if (saved && uint(saved.head.height) < uint(minimumHeight)) { this.#snapshots.delete(key); saved = null; }
    if (!saved) {
      if (this.#snapshots.size >= 32) throw Error("Funding observer queue full");
      saved = await this.#capture(r);
      if (!saved) return { state: "moving" };
      this.#snapshots.set(key, saved);
    }
    // The capture finishes after inspect starts; elapsed RPC time is normal.
    const capturedAt = integer(this.#clock());
    if (capturedAt < now || capturedAt < saved.observedAt) throw Error("Funding clock moved backwards");
    const c = this.#client, head = this.#head(await c.provider.getHeadInfo());
    if (await c.provider.getChainId() !== c.d.chainId) throw Error("Funding chain mismatch");
    if (uint(saved.head.height) > uint(head.lib)) return { state: "reversible" };
    const [b] = await c.provider.getBlocks(Number(saved.head.height), 1, head.id, { returnBlock: true, returnReceipt: false });
    if (!b || b.block_id !== saved.head.id) { this.#snapshots.delete(key); return { state: "forked" }; }
    if (b.block?.id !== saved.head.id || num(b.block_height).toString() !== saved.head.height ||
        num(b.block.header?.height).toString() !== saved.head.height || num(b.block.header?.timestamp).toString() !== saved.head.time)
      throw Error("Inconsistent funding snapshot block");
    const current = await this.#capture(r);
    if (!current) return { state: "moving" };
    if (uint(current.head.lib) < uint(head.lib) || uint(current.head.height) < uint(head.height)) throw Error("Funding finality regressed");
    if (saved.hash !== current.hash) { this.#snapshots.set(key, current); return { state: "changed" }; }
    const checkedAt = integer(this.#clock());
    if (checkedAt < capturedAt || checkedAt < current.observedAt) throw Error("Funding clock moved backwards");
    return { state: "verified", ...structuredClone(saved.state), height: saved.head.height, blockId: saved.head.id, checkedAt };
  }
  async finality(transaction, value) {
    const tx = structuredClone(transaction), r = intent(value), c = this.#client, p = c.provider;
    objectId(tx.id); await c.verify(); await c.verifyTransaction(tx, r);
    const matches = response(await p.getTransactionsById([tx.id])).transactions ?? [];
    if (!Array.isArray(matches)) throw Error("Invalid funding transaction lookup");
    const records = matches.filter(x => x.transaction?.id === tx.id);
    if (!records.length) return { state: "unknown" };
    if (records.length !== 1) throw Error("Ambiguous funding transaction lookup");
    const verify = async actual => {
      await c.verifyTransaction(actual, r);
      const canonical = await Transaction.prepareTransaction(structuredClone(actual));
      if (canonical.id !== tx.id) throw Error("Funding transaction commitment mismatch");
    };
    await verify(records[0].transaction);
    const containing = records[0].containing_blocks ?? [];
    if (!Array.isArray(containing) || containing.length > 100) throw Error("Invalid funding containing blocks");
    containing.forEach(objectId);
    if (!containing.length) return { state: "pending" };
    const head = this.#head(await p.getHeadInfo());
    const candidates = response(await p.getBlocksById(containing, { returnBlock: false, returnReceipt: false })).block_items ?? [];
    if (!Array.isArray(candidates)) throw Error("Invalid funding blocks");
    let reversible = false;
    for (const b of candidates) {
      if (!containing.includes(b.block_id)) throw Error("Unexpected funding block");
      const height = uint(b.block_height);
      if (height > uint(head.lib)) { reversible = true; continue; }
      const [main] = await p.getBlocks(Number(height), 1, head.id, { returnBlock: true, returnReceipt: true });
      if (!main || main.block_id !== b.block_id) continue;
      if (num(main.block_height) !== height || main.block?.id !== b.block_id || num(main.block.header?.height) !== height ||
          main.receipt?.id !== b.block_id || num(main.receipt.height) !== height) throw Error("Inconsistent finalized funding block");
      const included = main.block.transactions?.filter(t => t.id === tx.id), receipts = main.receipt.transaction_receipts?.filter(t => t.id === tx.id);
      if (included?.length !== 1 || receipts?.length !== 1) throw Error("Missing finalized funding transaction or receipt");
      await verify(included[0]); const receipt = receipts[0];
      if (receipt.rpc_error || ![undefined, false, true].includes(receipt.reverted) || receipt.payer !== r.actor ||
          num(receipt.rc_used) > uint(tx.header.rc_limit)) throw Error("Invalid finalized funding receipt");
      const final = { state: receipt.reverted ? "reverted" : "finalized", txId: tx.id,
        height: height.toString(), blockId: b.block_id, irreversibleHeight: head.lib };
      if (receipt.reverted) return final;
      const events = receipt.events ?? [];
      if (!Array.isArray(events)) throw Error("Invalid funding events");
      const transfers = events.filter(e => e.source === c.d.token && e.name === "token.transfer_event");
      if (transfers.length !== 1) throw Error("Exact native funding transfer required");
      const transfer = await native.deserialize(transfers[0].data, "token.transfer_event");
      if (transfer.from !== r.actor || transfer.to !== c.d[r.kind] || transfer.value !== r.args.amount)
        throw Error("Native funding transfer differs from intent");
      return final;
    }
    return { state: reversible ? "reversible" : "unknown" };
  }
}
module.exports = { FundingObserver, intent };
