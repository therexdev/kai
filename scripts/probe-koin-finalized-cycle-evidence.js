"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/koin-cycle-fixture");
const { RewardObserver } = require("../lib/koin-network/reward-observer");
const { DAY } = require("../lib/koin-network/policy");
const P = require("../lib/koin-network/job-protocol");

async function finalization(t, { prepare = true } = {}) {
  const f = await fixture(t);
  const tick = () => f.runner().tick({ openCurrentDay: false });
  const confirm = async () => {
    await f.include(f.sent.at(-1));
    for (let i = 0; i < 3; i++) if ((await f.cycle.advance("1")).action === "step_complete") return;
    throw Error("Fixture confirmation failed");
  };
  await tick(); await confirm();
  f.cycle.importManifest(f.envelope); f.advance(DAY);
  await tick(); await confirm(); f.advance(DAY);
  if (prepare) await tick();
  return f;
}
function poolChanges(f, { paid = true } = {}) {
  const get = f.rpc.getBlocks;
  f.rpc.getBlocks = async (...args) => {
    const result = await get(...args);
    f.balances.liquid = String(BigInt(f.balances.liquid) + 100n);
    if (paid) {
      const e = f.epochs.get("1");
      e.paid = String(BigInt(e.paid || "0") + 1n);
      f.balances.liabilities = String(BigInt(f.balances.liabilities) - 1n);
    }
    return result;
  };
}

test("an exact finalized lifecycle transaction completes through unrelated pool funding and claim payments without signing or resending", async t => {
  const f = await finalization(t), tx = f.sent.at(-1);
  await f.include(tx); poolChanges(f);
  const before = f.cycle.status("1").steps[2], signed = f.signed.length, sent = f.sent.length;
  assert.equal(before.state, "unknown");
  assert.equal((await f.cycle.advance("1")).action, "step_complete");
  const after = f.cycle.status("1").steps[2];
  assert.equal(after.state, "complete"); assert.equal(after.txId, tx.id);
  assert.equal(after.attempts, before.attempts);
  assert.equal(f.signed.length, signed); assert.equal(f.sent.length, sent);
});

test("completion proof exposes only its irreversible projection and never warms normal admission evidence", async t => {
  const f = await finalization(t); await f.include(f.sent.at(-1));
  const o = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
  const args = { epoch: "1", minimumHeight: f.head.head_topology.height };
  poolChanges(f);
  const proof = await o.inspectFinalizedCycle(args);
  assert.equal(proof.state, "verified"); assert.equal(proof.scope, "finalized_cycle");
  for (const key of ["balances", "claimed", "spent"]) assert.ok(!Object.hasOwn(proof, key));
  assert.ok(!Object.hasOwn(proof.epoch, "paid"));
  assert.equal(proof.epoch.finalized, true);
  assert.equal((await o.inspectCycle(args)).state, "changed", "normal signing evidence still requires the complete state");
  assert.equal((await o.inspectFinalizedCycle(args)).state, "verified");
  assert.equal((await o.inspectCycle(args)).state, "changed", "both caches remain separate after repeated calls");
});

test("completion requires a positive own-finality height and never returns a lower or still-reversible snapshot", async t => {
  const f = await fixture(t), o = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
  for (const minimumHeight of [undefined, "0", "-1"]) await assert.rejects(o.inspectFinalizedCycle({ epoch: "1", minimumHeight }));
  assert.deepEqual(await o.inspectFinalizedCycle({ epoch: "1", minimumHeight: "101" }), { state: "before_finality" });
  f.advance(1); f.head.last_irreversible_block = "100";
  assert.deepEqual(await o.inspectFinalizedCycle({ epoch: "1", minimumHeight: "101" }), { state: "reversible" });
  f.head.last_irreversible_block = "101";
  assert.equal((await o.inspectFinalizedCycle({ epoch: "1", minimumHeight: "101" })).height, "101");
  f.advance(1);
  assert.equal((await o.inspectFinalizedCycle({ epoch: "1", minimumHeight: "102" })).height, "102", "an older completion snapshot cannot satisfy a newer finality bound");
});

test("new openings, new finalizations and claims cannot use completion evidence", async t => {
  for (const phase of ["opening", "finalization"]) {
    const f = phase === "opening" ? await fixture(t) : await finalization(t, { prepare: false });
    const o = new RewardObserver(f.rpc, { target: f.target, clock: f.clock }), inspect = o.inspectCycle.bind(o);
    o.inspectCycle = async args => ({ ...await inspect(args), scope: "finalized_cycle" });
    o.inspectFinalizedCycle = async () => { throw Error("Unsigned lifecycle must not request completion evidence"); };
    const cycle = f.open({ observer: o }), signed = f.signed.length, sent = f.sent.length;
    await assert.rejects(cycle.advance("1"), /Completion evidence requires/);
    assert.equal(f.signed.length, signed); assert.equal(f.sent.length, sent);
  }
  const f = await require("./helpers/koin-claims-fixture").fixture(t), inspect = f.observer.inspect.bind(f.observer);
  f.observer.inspect = async args => ({ ...await inspect(args), scope: "finalized_cycle" });
  await assert.rejects(f.ledger.advance(f.ids[0]), /Completion evidence cannot authorize/);
  assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0);
});

test("unknown, pending, reversible and reverted finalizations retain the full evidence path", async t => {
  for (const state of ["unknown", "pending", "reversible", "reverted"]) {
    const f = await finalization(t), tx = f.sent.at(-1);
    if (state === "pending") f.lookups.set(tx.id, { transaction: tx, containing_blocks: [] });
    if (state === "reversible") await f.include(tx, { irreversible: false });
    if (state === "reverted") await f.include(tx, { reverted: true });
    const o = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
    o.inspectFinalizedCycle = async () => { throw Error("Unfinalized transaction requested completion evidence"); };
    const cycle = f.open({ observer: o }), signed = f.signed.length, sent = f.sent.length;
    const result = await cycle.advance("1");
    assert.notEqual(result.action, "step_complete", state);
    assert.notEqual(cycle.status("1").steps[2].state, "complete", state);
    if (state === "reverted") assert.equal(result.reason, "finalized_revert");
    assert.equal(f.signed.length, signed); assert.equal(f.sent.length, sent);
  }
});

test("completion scope must bind the saved transaction, its finalized height and the explicit completion marker", async t => {
  for (const change of ["transaction", "height", "scope", "unknown_scope"]) {
    const f = await finalization(t); await f.include(f.sent.at(-1));
    const o = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
    const verify = o.verifyCycle.bind(o), inspect = o.inspectFinalizedCycle.bind(o);
    if (change === "transaction") o.verifyCycle = async (...args) => ({ ...await verify(...args), txId: "0x1220" + P.hash("another-transaction") });
    else o.inspectFinalizedCycle = async args => {
      const evidence = await inspect(args);
      if (change === "height") evidence.height = String(BigInt(args.minimumHeight) - 1n);
      else if (change === "unknown_scope") evidence.scope = "unrecognized";
      else delete evidence.scope;
      return evidence;
    };
    const cycle = f.open({ observer: o }), signed = f.signed.length, sent = f.sent.length;
    await assert.rejects(cycle.advance("1"), /Completion evidence requires|completion scope required/);
    assert.equal(cycle.status("1").steps[2].state, "unknown");
    assert.equal(f.signed.length, signed); assert.equal(f.sent.length, sent);
  }
});

test("completion preserves changed root, expired epoch and live custody review guards", async t => {
  for (const change of ["root", "expired", "not_finalized", "custody", "paid", "pins"]) {
    const f = await finalization(t); await f.include(f.sent.at(-1));
    const epoch = f.epochs.get("1");
    if (change === "root") epoch.root.hash = Buffer.from(P.hash("replacement-root"), "hex").toString("base64url");
    if (change === "expired") { epoch.expired = true; epoch.finalized = false; }
    if (change === "not_finalized") epoch.finalized = false;
    if (change === "custody") f.balances.liabilities = "0";
    if (change === "paid") epoch.paid = "999";
    if (change === "pins") f.metadata[f.target.rewards].value.hash = "0x1220" + P.hash("changed-code");
    if (["root", "expired", "not_finalized"].includes(change)) {
      const result = await f.cycle.advance("1");
      assert.equal(result.action, "review"); assert.equal(f.cycle.status("1").steps[2].state, "needs_review");
    } else await assert.rejects(f.cycle.advance("1"), /custody|budget|bytecode/);
    assert.notEqual(f.cycle.status("1").steps[2].state, "complete");
  }
});

test("completion does not equate changed roots, policy, old-day spend or moving/forked observations", async t => {
  for (const change of ["root", "config", "spend", "head", "generation", "fork"]) {
    const f = await finalization(t); await f.include(f.sent.at(-1));
    const o = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
    const args = { epoch: "1", minimumHeight: f.head.head_topology.height };
    assert.equal((await o.inspectFinalizedCycle(args)).state, "verified");
    const get = f.rpc.getBlocks, read = f.rpc.readContract;
    if (change === "root") f.epochs.get("1").root.hash = Buffer.from(P.hash("new-root"), "hex").toString("base64url");
    if (change === "config") f.config.config.daily_bps++;
    if (change === "spend") {
      const ABI = require("../lib/koin-network/credits-abi.json"), { Serializer, utils } = require("koilib");
      const serializer = new Serializer(ABI.types);
      f.rpc.readContract = async op => op.contract_id === f.target.credits && op.entry_point === ABI.methods.get_spend.entry_point
        ? { result: utils.encodeBase64url(await serializer.serialize({ amount: "21" }, "koin.Result")) } : read(op);
    }
    if (change === "head") f.rpc.readContract = async op => { const value = await read(op); f.advance(1); return value; };
    if (change === "generation") {
      f.rpc.readGeneration = 0;
      f.rpc.getBlocks = async (...args) => { const value = await get(...args); f.rpc.readGeneration++; return value; };
    }
    if (change === "fork") f.rpc.getBlocks = async (...args) => (await get(...args)).map(b => ({ ...b, block_id: "0x1220" + P.hash("fork") }));
    assert.equal((await o.inspectFinalizedCycle(args)).state, change === "fork" ? "forked" : "changed", change);
  }
});
