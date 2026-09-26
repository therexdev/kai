"use strict";
const { Serializer, utils } = require("koilib");
const ABI = require("./rewards-abi.json"), CABI = require("./credits-abi.json");
const P = require("./job-protocol"), M = require("./reward-manifest");
const { address } = require("./metering"), { uint, DAY } = require("./policy");
const { inspectFinality } = require("./finality");
const enc = utils.encodeBase64url, bytes = a => enc(utils.decodeBase58(address(a)));
const num = v => uint(v ?? "0");
function objectId(v) { if (typeof v !== "string" || !/^0x1220[a-f0-9]{64}$/.test(v)) throw Error("Invalid reward block ID"); return v; }
function bool(v) { if (![undefined, false, true].includes(v)) throw Error("Invalid reward boolean"); return v === true; }

// One trusted coherent RPC, not a light client. No signer or transport for writes.
class RewardObserver {
  #rpc; #target; #clock; #serializer = new Serializer(ABI.types); #snapshots = new Map();
  constructor(provider, { target, clock = Date.now }) {
    this.#rpc = provider; this.#target = M.target(target); this.#clock = clock;
  }
  assertTarget(target) {
    if (JSON.stringify(M.target(target)) !== JSON.stringify(this.#target)) throw Error("Reward observer target mismatch");
  }
  #head(value) {
    const h = { id: objectId(value.head_topology?.id), height: num(value.head_topology.height).toString(),
      lib: num(value.last_irreversible_block).toString(), time: num(value.head_block_time).toString() };
    const now = BigInt(P.integer(this.#clock()));
    if (!uint(h.height) || uint(h.height) > BigInt(Number.MAX_SAFE_INTEGER) || uint(h.lib) > uint(h.height) ||
        uint(h.time) > now + 60000n || uint(h.time) + 120000n < now) throw Error("Stale or invalid reward RPC head");
    return h;
  }
  async #pins() {
    const t = this.#target, p = this.#rpc;
    if (await p.getChainId() !== t.chainId || (await p.invokeGetContractAddress("koin"))?.value?.address !== t.token) throw Error("Reward chain or native token mismatch");
    for (const kind of ["token", "credits", "rewards"]) {
      const m = (await p.invokeGetContractMetadata(t[kind]))?.value;
      if (m?.hash !== t[kind + "Hash"] || (kind !== "token" &&
          ["system", "authorizes_call_contract", "authorizes_transaction_application", "authorizes_upload_contract"].some(k => bool(m[k])))) throw Error("Reward bytecode or authority changed");
    }
  }
  async #read(kind, method, request = {}) {
    const abi = kind === "credits" ? CABI : ABI;
    if (!abi.methods[method]?.read_only) throw Error("Read-only reward method required");
    const canonical = { ...request }; if (canonical.epoch === "0") delete canonical.epoch;
    const response = await this.#rpc.readContract({ contract_id: this.#target[kind], entry_point: abi.methods[method].entry_point,
      args: enc(await this.#serializer.serialize(canonical, "koin.Request")) });
    if (response?.rpc_error || typeof response?.result !== "string" || response.result.length > 32768) throw Error("Invalid reward contract read");
    return this.#serializer.deserialize(response.result, "koin.Result");
  }
  async #capture(epoch, account) {
    uint(epoch); address(account); const t = this.#target, p = this.#rpc;
    const before = this.#head(await p.getHeadInfo()); await this.#pins();
    const rewardConfig = await this.#read("rewards", "config"), creditConfig = await this.#read("credits", "config");
    const value = await this.#read("rewards", "get_epoch", { epoch });
    const claimed = await this.#read("rewards", "claimed", { epoch, account: bytes(account) });
    const balances = await this.#read("rewards", "balances");
    const spent = await this.#read("credits", "get_spend", { epoch, account: bytes(account) });
    const totalSpent = await this.#read("credits", "get_spend", { epoch });
    const after = this.#head(await p.getHeadInfo());
    if (await p.getChainId() !== t.chainId || before.id !== after.id || before.height !== after.height || before.time !== after.time) throw Error("Head changed during reward reads");
    for (const { config: c } of [rewardConfig, creditConfig]) {
      if (!c || c.chain_id !== t.chainId || c.token !== bytes(t.token) || c.credits !== bytes(t.credits) ||
          c.treasury !== bytes(t.rewards) || c.verifier !== bytes(t.verifier) || num(c.version).toString() !== t.version ||
          c.work_cap_bps !== t.workCapBps) throw Error("Reward contract policy mismatch");
    }
    const e = value.epoch;
    if (!e || num(e.id).toString() !== epoch || num(e.version).toString() !== t.version || e.credits !== bytes(t.credits) ||
        e.verifier !== bytes(t.verifier) || e.work_cap_bps !== t.workCapBps) throw Error("Reward epoch identity mismatch");
    const opened = num(e.opened_at), start = uint(epoch) * BigInt(DAY);
    if (opened < start || opened >= start + BigInt(DAY) || opened > uint(after.time) ||
        num(e.availability_budget) + num(e.work_budget) !== num(e.budget)) throw Error("Invalid reward epoch budget");
    bool(e.finalized); bool(e.expired); bool(claimed.claimed);
    if (e.root) {
      if (typeof e.root.hash !== "string" || Buffer.from(e.root.hash, "base64url").length !== 32 ||
          enc(Buffer.from(e.root.hash, "base64url")) !== e.root.hash || bool(e.root.left) ||
          num(e.root.availability) > num(e.availability_budget) || num(e.root.work) > num(e.work_budget) ||
          num(e.root.work) > num(totalSpent.amount) * BigInt(t.workCapBps) / 10000n ||
          num(e.paid) > num(e.root.availability) + num(e.root.work) ||
          num(e.review_until) < start + 2n * BigInt(DAY)) throw Error("Invalid reward root budget or review hold");
    }
    const liability = num(balances.liabilities), liquid = num(balances.liquid);
    if (liquid < liability || (e.finalized && (!e.root || e.expired || uint(after.time) < num(e.review_until) ||
        liability < num(e.root.availability) + num(e.root.work) - num(e.paid)))) throw Error("Reward custody or finalization invariant failed");
    const state = { rewardConfig, creditConfig, epoch: e, claimed: bool(claimed.claimed), balances,
      spent: num(spent.amount).toString(), totalSpent: num(totalSpent.amount).toString() };
    return { head: after, state, stateHash: P.hash(JSON.stringify(state)), observedAt: P.integer(this.#clock()) };
  }
  async inspect({ epoch, account, minimumHeight = "0" }) {
    const key = uint(epoch).toString() + ":" + address(account), now = P.integer(this.#clock());
    for (const [k, v] of this.#snapshots) if (now - v.observedAt > 900000) this.#snapshots.delete(k);
    let snapshot = this.#snapshots.get(key);
    // A revert can leave contract state unchanged. Still obtain evidence at
    // or after its block before resolving that consumed sponsor nonce.
    if (snapshot && uint(snapshot.head.height) < uint(minimumHeight)) {
      this.#snapshots.delete(key); snapshot = null;
    }
    if (!snapshot) {
      if (this.#snapshots.size >= 32) throw Error("Reward observation queue full");
      snapshot = await this.#capture(epoch, account); this.#snapshots.set(key, snapshot);
    }
    if (now < snapshot.observedAt) throw Error("Reward clock moved backwards");
    const head = this.#head(await this.#rpc.getHeadInfo());
    if (await this.#rpc.getChainId() !== this.#target.chainId) throw Error("Reward chain mismatch");
    if (uint(snapshot.head.height) > uint(head.lib)) return { state: "reversible" };
    const [block] = await this.#rpc.getBlocks(Number(snapshot.head.height), 1, head.id, { returnBlock: true, returnReceipt: false });
    if (!block || block.block_id !== snapshot.head.id) { this.#snapshots.delete(key); return { state: "forked" }; }
    if (block.block?.id !== snapshot.head.id || num(block.block_height).toString() !== snapshot.head.height ||
        num(block.block.header?.height).toString() !== snapshot.head.height || num(block.block.header?.timestamp).toString() !== snapshot.head.time) throw Error("Invalid irreversible reward block");
    const current = await this.#capture(epoch, account);
    if (uint(current.head.lib) < uint(head.lib) || uint(current.head.height) < uint(head.height)) throw Error("Reward RPC finality regressed");
    if (current.stateHash !== snapshot.stateHash) { this.#snapshots.set(key, current); return { state: "changed" }; }
    return { state: "verified", account, epoch, ...structuredClone(snapshot.state), checkedAt: now,
      height: snapshot.head.height, blockId: snapshot.head.id, chainTime: current.head.time, paymentsEnabled: false };
  }
  forget({ epoch, account }) { this.#snapshots.delete(epoch + ":" + account); }
  async verifyClaim(txId, expectedOperation) {
    if (expectedOperation?.contract_id !== this.#target.rewards || expectedOperation?.entry_point !== ABI.methods.claim.entry_point) throw Error("Exact reward claim required");
    await this.#pins();
    return inspectFinality(this.#rpc, { chainId: this.#target.chainId, txId, expectedOperation });
  }
}
module.exports = { RewardObserver };
