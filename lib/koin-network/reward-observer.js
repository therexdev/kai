"use strict";
const { Serializer, utils } = require("koilib");
const ABI = require("./rewards-abi.json"), CABI = require("./credits-abi.json");
const P = require("./job-protocol"), M = require("./reward-manifest");
const { address } = require("./metering"), { uint, DAY } = require("./policy");
const { inspectFinality } = require("./finality");
const { readGroup } = require("./read-group");
const { readScope } = require("./rpc-scheduler");
const enc = utils.encodeBase64url, bytes = a => enc(utils.decodeBase58(address(a)));
const num = v => uint(v ?? "0");
function objectId(v) { if (typeof v !== "string" || !/^0x1220[a-f0-9]{64}$/.test(v)) throw Error("Invalid reward block ID"); return v; }
function bool(v) { if (![undefined, false, true].includes(v)) throw Error("Invalid reward boolean"); return v === true; }
const INTENT_SCOPES = new Set(["funded_cycle", "reward_claim", "closed_epoch_work"]);
function rewardIntent(target, { scope, epoch, method = null, account = null, operationHash = null, minimumTime = "0" }) {
  if (!INTENT_SCOPES.has(scope) || typeof epoch !== "string") throw Error("Explicit reward intent scope required");
  uint(epoch); uint(minimumTime);
  if (scope === "closed_epoch_work") {
    if (method !== null || account !== null || operationHash !== null || uint(minimumTime) !== (uint(epoch) + 1n) * BigInt(DAY))
      throw Error("Exact closed reward epoch boundary required");
  } else {
    P.digest(operationHash);
    if (minimumTime !== "0") throw Error("Unexpected reward intent boundary");
    if (scope === "funded_cycle" && (!["propose_root", "finalize_root"].includes(method) || account !== null))
      throw Error("Exact funded lifecycle intent required");
    if (scope === "reward_claim" && (method !== "claim" || !account)) throw Error("Exact reward claim intent required");
    if (account !== null) address(account);
  }
  return { scope, targetHash: P.hash(JSON.stringify(M.target(target))), epoch, method, account, operationHash, minimumTime };
}
function assertRewardIntentEvidence(evidence, { target, now, claimAmount = null, ...request }) {
  const intent = rewardIntent(target, request), hash = P.hash(JSON.stringify(intent));
  if (evidence?.state !== "verified" || evidence.scope !== intent.scope || evidence.intentHash !== hash ||
      !evidence.intent || Object.keys(evidence.intent).length !== Object.keys(intent).length ||
      Object.entries(intent).some(([key, value]) => evidence.intent[key] !== value) ||
      evidence.day !== intent.epoch || evidence.account !== intent.account)
    throw Error("Reward evidence differs from the exact intent");
  P.integer(now); P.integer(evidence.checkedAt);
  if (evidence.checkedAt > now || now - evidence.checkedAt > 5000) throw Error("Stale reward intent evidence");
  const height = uint(evidence.height), chainTime = uint(evidence.chainTime), live = evidence.liveCustody, head = evidence.revalidatedHead;
  const observedTime = uint(evidence.observedChainTime);
  objectId(evidence.blockId);
  if (!height || !head || !live || live.kind !== "current" || live.intentHash !== hash || live.checkedAt !== evidence.checkedAt)
    throw Error("Fresh live custody evidence required");
  objectId(head.id); P.integer(head.generation);
  const headHeight = uint(head.height), lib = uint(head.lib), time = uint(head.time);
  if (headHeight < lib || lib < height || time !== chainTime || observedTime > time ||
      (headHeight === height && head.id !== evidence.blockId) || time > BigInt(now) + 60000n || time + 120000n < BigInt(now) ||
      live.headId !== head.id || live.height !== head.height || live.lib !== head.lib || live.chainTime !== head.time || live.generation !== head.generation)
    throw Error("Live custody head or generation binding differs");
  const liquid = uint(live.liquid), liabilities = uint(live.liabilities), paid = uint(live.epochPaid), e = evidence.epoch;
  if (liquid < liabilities) throw Error("Reward live custody invariant failed");
  if (Object.hasOwn(evidence, "balances") || (e && Object.hasOwn(e, "paid"))) throw Error("Mutable custody cannot be irreversible intent evidence");
  const projectionHash = P.hash(JSON.stringify(intentProjection(evidence, intent.scope)));
  if (evidence.projectionHash !== projectionHash || live.projectionHash !== projectionHash)
    throw Error("Live custody projection binding differs");
  uint(evidence.totalSpent);
  if (e) {
    bool(e.finalized); bool(e.expired);
    if (num(e.id).toString() !== intent.epoch) throw Error("Reward intent epoch identity differs");
    const total = e.root ? num(e.root.availability) + num(e.root.work) : 0n;
    if (paid > total || (e.finalized && (!e.root || e.expired || chainTime < num(e.review_until) || liabilities < total - paid)) ||
        (!e.finalized && !e.expired && liabilities < num(e.budget))) throw Error("Reward live custody invariant failed");
    if (intent.scope === "reward_claim") {
      if (typeof evidence.claimed !== "boolean") throw Error("Exact account claim state required");
      uint(evidence.spent); uint(evidence.totalSpent);
      if (claimAmount !== null && !evidence.claimed && e.finalized && !e.expired &&
          (uint(claimAmount) === 0n || total - paid < uint(claimAmount) || liabilities < uint(claimAmount)))
        throw Error("Unfunded reward entitlement");
    }
  }
  return evidence;
}
function intentProjection(state, scope) {
  return { rewardConfig: state.rewardConfig, creditConfig: state.creditConfig, epoch: state.epoch,
    ...(scope === "reward_claim" && { claimed: state.claimed, spent: state.spent }), totalSpent: state.totalSpent };
}
function assertClosedEpochWorkEvidence(evidence, { target, epoch, minimumTime, now }) {
  assertRewardIntentEvidence(evidence, { target, scope: "closed_epoch_work", epoch, minimumTime, now });
  if (!evidence.epoch || evidence.epoch.expired || uint(evidence.observedChainTime) < uint(minimumTime))
    throw Error("Funded irreversible closed epoch work evidence required");
  uint(evidence.totalSpent);
  return evidence;
}
// A moving read window supplies no usable evidence. Keep it distinct from
// malformed data, changed deployment pins and financial invariant failures.
class SnapshotChanged extends Error {}

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
    const kinds = ["token", "credits", "rewards"];
    const [chain, native, ...metadata] = await readGroup(p, [() => p.getChainId(), () => p.invokeGetContractAddress("koin"),
      ...kinds.map(kind => () => p.invokeGetContractMetadata(t[kind]))]);
    if (chain !== t.chainId || native?.value?.address !== t.token) throw Error("Reward chain or native token mismatch");
    for (const [index, kind] of kinds.entries()) {
      const m = metadata[index]?.value;
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
    // Koinos protobuf JSON omits result when the wire message is empty
    // (for example claimed=false or paid spend=0). Required identity fields
    // are still checked by capture after decoding these protobuf defaults.
    if (!response || typeof response !== "object" || Array.isArray(response) || response.rpc_error || response.error ||
        (response.result !== undefined && (typeof response.result !== "string" || response.result.length > 32768))) throw Error("Invalid reward contract read");
    return this.#serializer.deserialize(response.result ?? "", "koin.Result");
  }
  async #capture(epoch, account, completion = false, intent = null) {
    const traffic = account === null && !intent && !completion && epoch === String(Math.floor(this.#clock() / DAY))
      ? "availability" : "background";
    return readScope(traffic, () => this.#captureState(epoch, account, completion, intent));
  }
  async #captureState(epoch, account, completion, intent) {
    uint(epoch); if (account !== null) address(account); const t = this.#target, p = this.#rpc;
    const startedAt = P.integer(this.#clock()), generation = p.readGeneration;
    const before = this.#head(await p.getHeadInfo());
    const [, rewardConfig, creditConfig, value, claimed, balances, spent, totalSpent] = await readGroup(p, [
      () => this.#pins(), () => this.#read("rewards", "config"), () => this.#read("credits", "config"),
      () => this.#read("rewards", "get_epoch", { epoch }),
      () => account === null ? {} : this.#read("rewards", "claimed", { epoch, account: bytes(account) }),
      () => this.#read("rewards", "balances"),
      () => account === null ? {} : this.#read("credits", "get_spend", { epoch, account: bytes(account) }),
      () => this.#read("credits", "get_spend", { epoch }),
    ]);
    const chainAfter = await p.getChainId();
    const after = this.#head(await p.getHeadInfo());
    if (chainAfter !== t.chainId) throw Error("Reward chain mismatch");
    if (before.id !== after.id || before.height !== after.height || before.time !== after.time) throw new SnapshotChanged("Head changed during reward reads");
    if (p.readGeneration !== generation) throw new SnapshotChanged("RPC changed during reward reads");
    for (const { config: c } of [rewardConfig, creditConfig]) {
      if (!c || c.chain_id !== t.chainId || c.token !== bytes(t.token) || c.credits !== bytes(t.credits) ||
          c.treasury !== bytes(t.rewards) || c.verifier !== bytes(t.verifier) || num(c.version).toString() !== t.version ||
          (c.reward_basis || 0) !== (t.rewardBasis === "usd-pool" ? 1 : 0) || c.work_cap_bps !== t.workCapBps) throw Error("Reward contract policy mismatch");
    }
    const e = value.epoch;
    if (e || account !== null) {
    if (!e || num(e.id).toString() !== epoch || num(e.version).toString() !== t.version || e.credits !== bytes(t.credits) ||
        e.verifier !== bytes(t.verifier) || (e.reward_basis || 0) !== (t.rewardBasis === "usd-pool" ? 1 : 0) || e.work_cap_bps !== t.workCapBps) throw Error("Reward epoch identity mismatch");
    const opened = num(e.opened_at), start = uint(epoch) * BigInt(DAY);
    if (opened < start || opened >= start + BigInt(DAY) || opened > uint(after.time) ||
        num(e.availability_budget) + num(e.work_budget) !== num(e.budget)) throw Error("Invalid reward epoch budget");
    bool(e.finalized); bool(e.expired); bool(claimed.claimed);
    if (e.root) {
      if (typeof e.root.hash !== "string" || Buffer.from(e.root.hash, "base64url").length !== 32 ||
          enc(Buffer.from(e.root.hash, "base64url")) !== e.root.hash || bool(e.root.left) ||
          num(e.root.availability) > num(e.availability_budget) || num(e.root.work) > num(e.work_budget) ||
          num(e.root.work) > require("./policy").workCap({ basis: t.rewardBasis, budget: num(e.work_budget), spent: num(totalSpent.amount), totalSpent: num(totalSpent.amount), workCapBps: t.workCapBps }) ||
          num(e.paid) > num(e.root.availability) + num(e.root.work) ||
          num(e.review_until) < start + 2n * BigInt(DAY)) throw Error("Invalid reward root budget or review hold");
    }
    }
    const liability = num(balances.liabilities), liquid = num(balances.liquid);
    if (liquid < liability || (e?.finalized && (!e.root || e.expired || uint(after.time) < num(e.review_until) ||
        liability < num(e.root.availability) + num(e.root.work) - num(e.paid)))) throw Error("Reward custody or finalization invariant failed");
    if (intent && e && !e.finalized && !e.expired && liability < num(e.budget)) throw Error("Funded reward epoch custody invariant failed");
    const state = completion || intent ? {
      // These intents depend on the fixed epoch commitments (and, for a claim,
      // this account's claim/spend), not a quiet global pool. Custody is checked
      // on every capture; mutable balances/paid never become irreversible facts.
      rewardConfig, creditConfig,
      epoch: e ? Object.fromEntries(Object.entries(e).filter(([key]) => key !== "paid")) : null,
      ...(intent?.scope === "reward_claim" && { claimed: bool(claimed.claimed), spent: num(spent.amount).toString() }),
      totalSpent: num(totalSpent.amount).toString(),
    } : { rewardConfig, creditConfig, epoch: e ?? null, claimed: bool(claimed.claimed), balances,
      spent: num(spent.amount).toString(), totalSpent: num(totalSpent.amount).toString() };
    const observedAt = P.integer(this.#clock());
    if (observedAt < startedAt) throw Error("Reward clock moved backwards");
    return { head: after, state, stateHash: P.hash(JSON.stringify(state)), observedAt,
      ...(intent && { live: { liquid: liquid.toString(), liabilities: liability.toString(), epochPaid: num(e?.paid).toString() },
        generation: generation === undefined ? 0 : P.integer(generation) }) };
  }
  async inspect({ epoch, account, minimumHeight = "0" }) {
    address(account); return this.#inspect(epoch, account, minimumHeight);
  }
  async inspectCycle({ epoch, minimumHeight = "0", minimumTime = "0" }) {
    return this.#inspect(epoch, null, minimumHeight, minimumTime);
  }
  async inspectFinalizedCycle({ epoch, minimumHeight }) {
    if (!uint(minimumHeight)) throw Error("Exact finalized lifecycle height required");
    return this.#inspect(epoch, null, minimumHeight, "0", true);
  }
  async inspectFundedCycle({ epoch, method, operationHash, minimumHeight = "0" }) {
    const intent = rewardIntent(this.#target, { scope: "funded_cycle", epoch, method, operationHash });
    return this.#inspect(epoch, null, minimumHeight, "0", false, intent);
  }
  async inspectClaim({ epoch, account, operationHash, minimumHeight = "0" }) {
    const intent = rewardIntent(this.#target, { scope: "reward_claim", epoch, method: "claim", account, operationHash });
    return this.#inspect(epoch, account, minimumHeight, "0", false, intent);
  }
  async inspectClosedEpochWork({ epoch, minimumTime }) {
    const intent = rewardIntent(this.#target, { scope: "closed_epoch_work", epoch, minimumTime });
    return this.#inspect(epoch, null, "0", minimumTime, false, intent);
  }
  async #inspect(epoch, account, minimumHeight, minimumTime = "0", completion = false, intent = null) {
    try { return await this.#coherentEvidence(epoch, account, minimumHeight, minimumTime, completion, intent); }
    catch (error) {
      // Existing claim/cycle gates already wait on changed evidence. Never
      // return the mixed snapshot or retry in a tight loop; the next tick reads
      // again while independent work can continue in the current pass.
      if (error instanceof SnapshotChanged) return { state: "changed" };
      throw error;
    }
  }
  async #coherentEvidence(epoch, account, minimumHeight, minimumTime, completion, intent) {
    uint(minimumTime);
    uint(minimumHeight);
    const key = (intent ? intent.scope + ":" + P.hash(JSON.stringify(intent)) + ":" : completion ? "finalized-cycle:" : "") + uint(epoch).toString() + ":" + (account ?? "cycle"), now = P.integer(this.#clock());
    for (const [k, v] of this.#snapshots) if (now - v.observedAt > 900000) this.#snapshots.delete(k);
    let snapshot = this.#snapshots.get(key);
    // A revert can leave contract state unchanged. Still obtain evidence at
    // or after its block before resolving that consumed sponsor nonce.
    if (snapshot && (uint(snapshot.head.height) < uint(minimumHeight) || uint(snapshot.head.time) < uint(minimumTime))) {
      this.#snapshots.delete(key); snapshot = null;
    }
    if (!snapshot) {
      if (this.#snapshots.size >= 32) throw Error("Reward observation queue full");
      snapshot = await this.#capture(epoch, account, completion, intent); this.#snapshots.set(key, snapshot);
    }
    if ((completion || intent) && uint(snapshot.head.height) < uint(minimumHeight)) return { state: "before_finality" };
    if (uint(snapshot.head.time) < uint(minimumTime)) return { state: "before_boundary" };
    if (P.integer(this.#clock()) < snapshot.observedAt) throw Error("Reward clock moved backwards");
    const generation = this.#rpc.readGeneration;
    const head = this.#head(await this.#rpc.getHeadInfo());
    if (await this.#rpc.getChainId() !== this.#target.chainId) throw Error("Reward chain mismatch");
    if (uint(snapshot.head.height) > uint(head.lib)) return { state: "reversible" };
    const [block] = await this.#rpc.getBlocks(Number(snapshot.head.height), 1, head.id, { returnBlock: true, returnReceipt: false });
    if (!block || block.block_id !== snapshot.head.id) { this.#snapshots.delete(key); return { state: "forked" }; }
    if (block.block?.id !== snapshot.head.id || num(block.block_height).toString() !== snapshot.head.height ||
        num(block.block.header?.height).toString() !== snapshot.head.height || num(block.block.header?.timestamp).toString() !== snapshot.head.time) throw Error("Invalid irreversible reward block");
    const current = await this.#capture(epoch, account, completion, intent);
    if (this.#rpc.readGeneration !== generation) throw new SnapshotChanged("RPC changed during reward verification");
    if (uint(current.head.lib) < uint(head.lib) || uint(current.head.height) < uint(head.height)) throw Error("Reward RPC finality regressed");
    if (current.stateHash !== snapshot.stateHash) { this.#snapshots.set(key, current); return { state: "changed" }; }
    const checkedAt = P.integer(this.#clock());
    if (checkedAt < now || checkedAt < snapshot.observedAt) throw Error("Reward clock moved backwards");
    if (checkedAt - snapshot.observedAt > 900000) { this.#snapshots.delete(key); return { state: "changed" }; }
    const proof = { state: "verified", ...(completion && { scope: "finalized_cycle" }), account, day: epoch, ...structuredClone(snapshot.state), checkedAt,
      height: snapshot.head.height, blockId: snapshot.head.id, chainTime: current.head.time, paymentsEnabled: false };
    if (intent) {
      const intentHash = P.hash(JSON.stringify(intent));
      Object.assign(proof, { scope: intent.scope, intent: { ...intent }, intentHash, projectionHash: snapshot.stateHash, observedChainTime: snapshot.head.time,
        revalidatedHead: { ...current.head, generation: current.generation },
        liveCustody: { kind: "current", ...current.live, checkedAt, intentHash, projectionHash: current.stateHash, headId: current.head.id,
          height: current.head.height, lib: current.head.lib, chainTime: current.head.time, generation: current.generation } });
    }
    return proof;
  }
  forget({ epoch, account }) {
    const key = epoch + ":" + (account ?? "cycle");
    this.#snapshots.delete(key); this.#snapshots.delete("finalized-cycle:" + key);
    for (const id of this.#snapshots.keys()) if (id.endsWith(":" + key) && INTENT_SCOPES.has(id.split(":")[0])) this.#snapshots.delete(id);
  }
  async verifyClaim(txId, expectedOperation) {
    if (expectedOperation?.contract_id !== this.#target.rewards || expectedOperation?.entry_point !== ABI.methods.claim.entry_point) throw Error("Exact reward claim required");
    await this.#pins();
    return inspectFinality(this.#rpc, { chainId: this.#target.chainId, txId, expectedOperation });
  }
  async verifyCycle(txId, expectedOperation) {
    if (expectedOperation?.contract_id !== this.#target.rewards ||
        !["open_epoch", "propose_root", "finalize_root"].some(k => ABI.methods[k].entry_point === expectedOperation?.entry_point))
      throw Error("Exact daily reward operation required");
    await this.#pins();
    return inspectFinality(this.#rpc, { chainId: this.#target.chainId, txId, expectedOperation });
  }
}
module.exports = { RewardObserver, assertRewardIntentEvidence, assertClosedEpochWorkEvidence };
