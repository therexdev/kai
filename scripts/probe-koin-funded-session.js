"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Serializer, utils, Signer } = require("koilib");
const ABI = require("../lib/koin-network/credits-abi.json");
const { FundedSessionObserver } = require("../lib/koin-network/funded-session");
const { hash } = require("../lib/koin-network/metering");
const { DAY } = require("../lib/koin-network/policy");
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
      assert.equal(height, 100); assert.equal(count, 1); assert.equal(headId, head.head_topology.id);
      assert.equal(options.returnBlock, true); return [structuredClone(block)];
    },
  };
  const observer = new FundedSessionObserver(rpc, target), request = { id, owner };
  return { target, owner, id, config, session, balances, head, metadata, block, rpc, observer, request,
    time: (t) => { now = t; }, finalize: () => { head.last_irreversible_block = "100"; head.head_topology = { id: nextId, height: "101" }; } };
}
test("funded snapshot uses exact ABI reads and requires canonical irreversibility", async () => {
  const f = fixture(), observed = await f.observer.observe(f.request);
  assert.equal((await f.observer.verify(observed.observationId)).state, "reversible");
  f.finalize();
  const result = await f.observer.verify(observed.observationId);
  assert.equal(result.state, "verified"); assert.equal(result.remaining, "1000");
  assert.equal(result.perJob, "100"); assert.equal(result.remainingJobs, "10");
  assert.equal(result.spendingAuthorized, false); assert.equal(result.paymentsEnabled, false);
  observed.blockId = nextId;
  assert.equal((await f.observer.verify(observed.observationId)).blockId, blockId);
});
test("old fork and inconsistent canonical block do not verify funds", async () => {
  const f = fixture(), o = await f.observer.observe(f.request); f.finalize();
  f.block.block_id = nextId;
  assert.equal((await f.observer.verify(o.observationId)).state, "forked");
  f.block.block_id = blockId; f.block.block.header.timestamp = "1";
  await assert.rejects(() => f.observer.verify(o.observationId), /Inconsistent/);
});
test("read races, stale nodes and wrong chain or contract are rejected", async () => {
  for (const mutate of [
    (f) => { f.rpc.getChainId = async () => "other"; },
    (f) => { f.metadata.value.hash = "0x1220" + hash("other"); },
    (f) => { f.metadata.value.authorizes_call_contract = true; },
    (f) => { f.head.head_block_time = "1"; },
    (f) => { const read = f.rpc.readContract; f.rpc.readContract = async (op) => { const r = await read(op); f.head.head_topology.id = nextId; return r; }; },
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(() => f.observer.observe(f.request));
  }
});
test("owner, verifier, tariff policy, contract pause and backing balances must match", async () => {
  for (const mutate of [
    (f) => { f.session.session.owner = bytes(addr("other")); },
    (f) => { f.session.session.verifier = bytes(addr("other")); },
    (f) => { f.session.session.policy_hash = enc(Buffer.from(hash("other"), "hex")); },
    (f) => { f.config.paused = true; },
    (f) => { f.balances.balance.reserved = "999"; },
    (f) => { f.balances.liquid = "1019"; },
    (f) => { f.session.session.mining_bps = 5000; },
    (f) => { f.session.session.closed = true; },
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(() => f.observer.observe(f.request));
  }
});
test("revocation, expiry and spending after observation prevent stale approval", async () => {
  for (const mutate of [
    (f) => { f.session.session.revoked_at = String(2 * DAY); },
    (f) => { f.time(2 * DAY + 60000); },
    (f) => { f.session.session.jobs = "10"; f.session.session.nonce = "10"; },
  ]) {
    const f = fixture(), o = await f.observer.observe(f.request); f.finalize(); mutate(f);
    await assert.rejects(() => f.observer.verify(o.observationId));
  }
  const f = fixture(), o = await f.observer.observe(f.request); f.finalize();
  f.session.session.remaining = "990"; f.session.session.jobs = "1"; f.session.session.nonce = "1";
  f.balances.balance.reserved = "990"; f.balances.liabilities = "1010"; f.balances.liquid = "1010";
  assert.equal((await f.observer.verify(o.observationId)).state, "changed");
});
test("RPC failures and missing sessions never create an authorization", async () => {
  const f = fixture(), o = await f.observer.observe(f.request); f.finalize();
  f.rpc.readContract = async () => { throw Error("offline"); };
  await assert.rejects(() => f.observer.verify(o.observationId), /offline/);
  await assert.rejects(() => f.observer.verify(hash("invented")), /Unknown/);
  const g = fixture(); g.rpc.readContract = async () => ({ result: "" });
  await assert.rejects(() => g.observer.observe(g.request));
});
test("observation age, inconsistent head and retained queue are bounded", async () => {
  const f = fixture(), o = await f.observer.observe(f.request);
  f.time(2 * DAY + 900001);
  await assert.rejects(() => f.observer.verify(o.observationId), /expired/);
  const g = fixture(); g.head.last_irreversible_block = "101";
  await assert.rejects(() => g.observer.observe(g.request), /height/);
  const h = fixture();
  for (let i = 0; i < 32; i++) { h.head.head_topology.id = "0x1220" + hash(String(i)); await h.observer.observe(h.request); }
  await assert.rejects(() => h.observer.observe(h.request), /queue full/);
});
test("operator evidence routes do not import chain funds into the simulation ledger", async (t) => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { Scheduler } = require("../lib/scheduler");
  const { Meter } = require("../lib/koin-network/metering");
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "funded-observe-"));
  const scheduler = new Scheduler({ dataDir: dir, operatorSecret: "probe-only", koinWork: {
    domain: "shadow:funded-probe", meter: new Meter(), qualify: () => false, accept: () => false, fundingObserver: f.observer,
  } });
  const port = await scheduler.listen(0, "127.0.0.1");
  t.after(async () => { await scheduler.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = async (route, body, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${port}/koin/shadow/jobs/${route}`, {
      method: "POST", headers: { "content-type": "application/json", ...(auth ? { "x-operator-secret": "probe-only" } : {}) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post("funding-observe", f.request, false)).status, 403);
  const observed = await post("funding-observe", f.request);
  assert.equal(observed.status, 200); f.finalize();
  const result = await post("funding-verify", { observationId: observed.body.evidence.observationId });
  assert.equal(result.status, 200); assert.equal(result.body.evidence.state, "verified");
  assert.equal(result.body.paymentsEnabled, false); assert.equal(result.body.evidence.spendingAuthorized, false);
  assert.throws(() => scheduler.koinWork.ledger.get("grants", f.id), /Unknown/);
  assert.equal((await post("funding-verify", { observationId: hash("unobserved") })).status, 400);
});
