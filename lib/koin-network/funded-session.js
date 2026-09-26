"use strict";

// Read-only evidence, never a grant importer or spending authorization.
// Requires one trusted, coherent RPC node. This is not a light client.
const { Serializer, utils } = require("koilib");
const ABI = require("./credits-abi.json");
const { address, digest, hash, integer } = require("./metering");
const { uint, DAY } = require("./policy");
const { inspectFinality } = require("./finality");
const chainObject = (v) => {
  if (typeof v !== "string" || !/^0x1220[a-f0-9]{64}$/.test(v)) throw Error("Invalid chain object ID");
  return v;
};
const encoded = (v) => utils.encodeBase64url(v);
const account = (v) => encoded(utils.decodeBase58(address(v)));
const number = (v) => uint(v ?? "0");
const off = (v) => v === undefined || v === false;

class FundedSessionObserver {
  #provider; #target; #serializer = new Serializer(ABI.types); #snapshots = new Map(); #clock; #maxAge;
  constructor(provider, { chainId, credits, creditsHash, token, verifier, policyHash, version,
    clock = Date.now, maxSnapshotAgeMs = 900000 }) {
    if (typeof chainId !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(chainId) ||
        Buffer.from(chainId, "base64url").length !== 34 ||
        encoded(Buffer.from(chainId, "base64url")) !== chainId) throw Error("Canonical chain ID required");
    const chainBytes = Buffer.from(chainId, "base64url");
    if (chainBytes[0] !== 0x12 || chainBytes[1] !== 0x20) throw Error("Invalid chain digest");
    if (!uint(version)) throw Error("Pinned policy version required");
    integer(maxSnapshotAgeMs, 1000, DAY);
    this.#target = Object.freeze({ chainId, credits: address(credits), creditsHash: chainObject(creditsHash),
      token: address(token), verifier: address(verifier), policyHash: digest(policyHash), version });
    this.#provider = provider; this.#clock = clock; this.#maxAge = maxSnapshotAgeMs;
  }
  #head(h) {
    const height = uint(h.head_topology?.height), lib = uint(h.last_irreversible_block);
    if (!height || lib > height || height > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("Invalid head height");
    const time = uint(h.head_block_time), now = BigInt(integer(this.#clock()));
    if (time > now + 60000n || now > time + 120000n) throw Error("Stale or future RPC head");
    return { id: chainObject(h.head_topology.id), height: height.toString(), lib: lib.toString(), time: time.toString() };
  }
  async #read(method, request) {
    const args = encoded(await this.#serializer.serialize(request, "koin.Request"));
    const response = await this.#provider.readContract({ contract_id: this.#target.credits,
      entry_point: ABI.methods[method].entry_point, args });
    if (response?.rpc_error || typeof response?.result !== "string" || response.result.length > 32768) throw Error("Invalid contract read");
    return this.#serializer.deserialize(response.result, "koin.Result");
  }
  async #capture(id, owner, purpose = "admission") {
    digest(id); address(owner);
    const p = this.#provider, t = this.#target;
    if (await p.getChainId() !== t.chainId) throw Error("RPC chain mismatch");
    const before = this.#head(await p.getHeadInfo());
    const metadata = (await p.invokeGetContractMetadata(t.credits))?.value;
    if (metadata?.hash !== t.creditsHash || !["system", "authorizes_call_contract", "authorizes_transaction_application", "authorizes_upload_contract"].every((k) => off(metadata[k]))) throw Error("Credits bytecode or authority changed");
    const config = await this.#read("config", {});
    const { session: s } = await this.#read("get_session", { id: encoded(Buffer.from(id, "hex")) });
    const balances = await this.#read("balances", { account: account(owner) });
    const after = this.#head(await p.getHeadInfo());
    if (await p.getChainId() !== t.chainId || before.id !== after.id || before.height !== after.height || before.time !== after.time) throw Error("Head changed during contract reads; retry observation");
    const c = config.config;
    const reconciliation = purpose === "reconciliation";
    if (!c || (!reconciliation && !off(config.paused)) || c.chain_id !== t.chainId || c.credits !== account(t.credits) ||
        c.token !== account(t.token) || c.verifier !== account(t.verifier) || number(c.version).toString() !== t.version) throw Error("Contract policy mismatch or paused");
    if (!s || s.id !== encoded(Buffer.from(id, "hex")) || s.owner !== account(owner) ||
        s.verifier !== account(t.verifier) || s.policy_hash !== encoded(Buffer.from(t.policyHash, "hex")) ||
        number(s.version).toString() !== t.version) throw Error("Session identity or policy mismatch");
    for (const k of ["treasury", "mining", "operations"]) {
      if (!s[k] || s[k] !== c[k]) throw Error("Session revenue destination mismatch");
      address(utils.encodeBase58(utils.decodeBase64url(s[k])));
    }
    if (!Number.isInteger(c.reward_bps) || !Number.isInteger(c.mining_bps) || !Number.isInteger(c.operations_bps) ||
        Math.min(c.reward_bps, c.mining_bps, c.operations_bps) < 0 || c.reward_bps + c.mining_bps + c.operations_bps !== 10000 ||
        s.reward_bps !== c.reward_bps || s.mining_bps !== c.mining_bps) throw Error("Session revenue split mismatch");
    const remaining = number(s.remaining), perJob = number(s.per_job), jobs = number(s.jobs), maxJobs = number(s.max_jobs);
    const opened = number(s.opened_at), expires = number(s.expires), settleUntil = number(s.settle_until);
    const now = BigInt(integer(this.#clock()));
    if ((!reconciliation && (!off(s.closed) || number(s.revoked_at) !== 0n || !remaining || jobs >= maxJobs)) ||
        !perJob || !maxJobs || maxJobs > 10000n || jobs > maxJobs || number(s.nonce) !== jobs || (s.closed && remaining !== 0n)) throw Error("Session revoked, closed or exhausted");
    const revoked = number(s.revoked_at);
    const expectedSettle = revoked && revoked < expires ? revoked + BigInt(DAY) : expires + BigInt(DAY);
    if (!opened || opened > BigInt(after.time) || expires <= opened || expires > opened + BigInt(DAY) ||
        (revoked && (revoked < opened || revoked > BigInt(after.time))) ||
        settleUntil !== expectedSettle || now < opened || (!reconciliation && (now >= expires || BigInt(after.time) >= expires))) throw Error("Session expired or invalid time limits");
    const b = balances.balance, liabilities = number(balances.liabilities), liquid = number(balances.liquid);
    if (!b || number(b.reserved) < remaining || number(b.available) + number(b.reserved) > liabilities || liquid < liabilities) throw Error("Session custody invariant failed");
    // The stable-head snapshot is private and immutable to the caller.
    return { id, owner, purpose, head: after, state: { config, session: s, balances },
      stateHash: hash(JSON.stringify({ config, session: s, balances })) };
  }
  async observe({ id, owner, purpose = "admission" }) {
    if (!["admission", "reconciliation"].includes(purpose)) throw Error("Invalid observation purpose");
    const now = integer(this.#clock());
    for (const [key, value] of this.#snapshots) if (now - value.observedAt > this.#maxAge) this.#snapshots.delete(key);
    if (this.#snapshots.size >= 32) throw Error("Observation queue full");
    const snapshot = await this.#capture(id, owner, purpose);
    if (this.#snapshots.size >= 32) throw Error("Observation queue full");
    snapshot.observedAt = now;
    const observationId = hash(JSON.stringify([this.#target, snapshot]));
    this.#snapshots.set(observationId, snapshot);
    return { observationId, state: "observed", blockId: snapshot.head.id, height: snapshot.head.height,
      paymentsEnabled: false, spendingAuthorized: false };
  }
  async verify(observationId) {
    const s = this.#snapshots.get(digest(observationId)), now = integer(this.#clock());
    if (!s || now < s.observedAt || now - s.observedAt > this.#maxAge) throw Error("Unknown or expired observation; observe again");
    const p = this.#provider;
    if (await p.getChainId() !== this.#target.chainId) throw Error("RPC chain mismatch");
    const head = this.#head(await p.getHeadInfo());
    const result = { observationId, paymentsEnabled: false, spendingAuthorized: false };
    if (BigInt(s.head.height) > BigInt(head.lib)) return { ...result, state: "reversible" };
    const [block] = await p.getBlocks(Number(s.head.height), 1, head.id, { returnBlock: true, returnReceipt: false });
    if (!block || block.block_id !== s.head.id) return { ...result, state: "forked" };
    if (block.block?.id !== s.head.id || uint(block.block_height).toString() !== s.head.height ||
        uint(block.block.header?.height).toString() !== s.head.height || uint(block.block.header?.timestamp).toString() !== s.head.time) throw Error("Inconsistent irreversible block");
    const current = await this.#capture(s.id, s.owner, s.purpose);
    if (BigInt(current.head.lib) < BigInt(head.lib) || BigInt(current.head.height) < BigInt(head.height)) throw Error("RPC head or irreversibility regressed");
    if (current.stateHash !== s.stateHash) return { ...result, state: "changed" };
    return { ...result, state: "verified", purpose: s.purpose, chainId: this.#target.chainId, credits: this.#target.credits,
      creditsHash: this.#target.creditsHash, session: s.id, owner: s.owner, policyHash: this.#target.policyHash,
      remaining: number(s.state.session.remaining).toString(), perJob: number(s.state.session.per_job).toString(),
      remainingJobs: (number(s.state.session.max_jobs) - number(s.state.session.jobs)).toString(),
      nonce: number(s.state.session.nonce).toString(), expires: number(s.state.session.expires).toString(),
      openedAt: number(s.state.session.opened_at).toString(), settleUntil: number(s.state.session.settle_until).toString(),
      revokedAt: number(s.state.session.revoked_at).toString(), closed: s.state.session.closed === true, paused: s.state.config.paused === true,
      blockId: s.head.id, height: s.head.height, irreversibleHeight: head.lib, stateHash: s.stateHash,
      checkedHead: current.head.id, checkedAt: now };
  }
  async verifySettlement(txId, expectedOperation) {
    if (expectedOperation?.contract_id !== this.#target.credits || expectedOperation?.entry_point !== ABI.methods.settle.entry_point) throw Error("Expected credits settlement required");
    const metadata = (await this.#provider.invokeGetContractMetadata(this.#target.credits))?.value;
    if (metadata?.hash !== this.#target.creditsHash || !["system", "authorizes_call_contract", "authorizes_transaction_application", "authorizes_upload_contract"].every((k) => off(metadata[k]))) throw Error("Credits bytecode or authority changed");
    return inspectFinality(this.#provider, { chainId: this.#target.chainId, txId, expectedOperation });
  }
}
module.exports = { FundedSessionObserver };
