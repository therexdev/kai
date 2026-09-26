"use strict";
const assert = require("node:assert/strict");
const { Serializer, utils, Signer } = require("koilib");
const ABI = require("../../lib/koin-network/credits-abi.json");
const { FundedSessionObserver } = require("../../lib/koin-network/funded-session");
const { hash } = require("../../lib/koin-network/metering");
const { DAY } = require("../../lib/koin-network/policy");
const enc = utils.encodeBase64url;
const addr = (s) => Signer.fromSeed("funded-probe-" + s).getAddress();
const bytes = (a) => enc(utils.decodeBase58(a));
const blockId = "0x1220" + hash("observed-block"), nextId = "0x1220" + hash("next-block");
function fixture() {
  let now = 2 * DAY;
  const target = { chainId: enc(Buffer.from("1220" + hash("chain"), "hex")), credits: addr("credits"),
    creditsHash: "0x1220" + hash("wasm"), token: addr("token"), verifier: addr("verifier"), policyHash: hash("tariffs"), version: "1",
    clock: () => now };
  const owner = addr("owner"), id = hash("session");
  const config = { config: { chain_id: target.chainId, credits: bytes(target.credits), token: bytes(target.token), verifier: bytes(target.verifier),
    treasury: bytes(addr("treasury")), mining: bytes(addr("mining")), operations: bytes(addr("operations")),
    version: "1", reward_bps: 6000, mining_bps: 2500, operations_bps: 1500 }, paused: false };
  const session = { session: { id: enc(Buffer.from(id, "hex")), owner: bytes(owner), verifier: bytes(target.verifier),
    policy_hash: enc(Buffer.from(target.policyHash, "hex")), remaining: "1000", per_job: "100", max_jobs: "10", jobs: "0", nonce: "0",
    opened_at: String(now - 1000), expires: String(now + 60000), settle_until: String(now + 60000 + DAY),
    treasury: config.config.treasury, mining: config.config.mining, operations: config.config.operations,
    reward_bps: 6000, mining_bps: 2500, version: "1" } };
  const balances = { balance: { available: "20", reserved: "1000" }, liabilities: "1020", liquid: "1020" };
  const head = { head_topology: { id: blockId, height: "100" }, head_block_time: String(now), last_irreversible_block: "99" };
  const metadata = { value: { hash: target.creditsHash } }, ser = new Serializer(ABI.types);
  const block = { block_id: blockId, block_height: "100", block: { id: blockId, header: { height: "100", timestamp: String(now) } } };
  const rpc = {
    getChainId: async () => target.chainId, getHeadInfo: async () => structuredClone(head),
    invokeGetContractMetadata: async (contract) => { assert.equal(contract, target.credits); return structuredClone(metadata); },
    readContract: async (op) => {
      assert.equal(op.contract_id, target.credits);
      const args = await ser.deserialize(op.args, "koin.Request");
      let result;
      if (op.entry_point === ABI.methods.config.entry_point) result = config;
      else if (op.entry_point === ABI.methods.get_session.entry_point) { assert.equal(args.id, session.session.id); result = session; }
      else if (op.entry_point === ABI.methods.balances.entry_point) { assert.equal(args.account, bytes(owner)); result = balances; }
      else throw Error("Unexpected operation");
      return { result: enc(await ser.serialize(result, "koin.Result")) };
    },
    getBlocks: async (height, count, headId, options) => {
      assert.equal(height, Number(block.block_height)); assert.equal(count, 1); assert.equal(headId, head.head_topology.id);
      assert.equal(options.returnBlock, true); return [structuredClone(block)];
    },
  };
  const observer = new FundedSessionObserver(rpc, target), request = { id, owner };
  return { target, owner, id, config, session, balances, head, metadata, block, rpc, observer, request,
    time: (t) => { now = t; }, finalize: () => { head.last_irreversible_block = "100"; head.head_topology = { id: nextId, height: "101" }; } };
}
module.exports = { fixture, enc, addr, bytes, blockId, nextId };
