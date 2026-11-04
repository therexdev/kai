"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/koin-cycle-fixture");
const { RewardObserver } = require("../lib/koin-network/reward-observer");
const P = require("../lib/koin-network/job-protocol");

test("elapsed RPC time is not a backwards clock; completed reward evidence is fresh", async t => {
  const f = await fixture(t); let now = f.clock();
  const observer = new RewardObserver(f.rpc, { target: f.target, clock: () => now });
  const read = f.rpc.readContract;
  f.rpc.readContract = async op => { const r = await read(op); now += 1001; return r; };
  const first = await observer.inspectCycle({ epoch: "1" });
  assert.equal(first.state, "verified"); assert.equal(first.checkedAt, now);
  const next = await observer.inspectCycle({ epoch: "1" });
  assert.equal(next.checkedAt, now); assert.equal(next.state, "verified");
});
test("reward reads run together but return no verified evidence for a moving head or changed RPC generation", async t => {
  for (const change of ["none", "head", "rpc"]) {
    const f = await fixture(t), read = f.rpc.readContract; f.rpc.readGeneration = 0;
    let pending = 0, peak = 0;
    f.rpc.readContract = async op => {
      pending++; peak = Math.max(peak, pending); await new Promise(r => setImmediate(r));
      const value = await read(op); pending--;
      if (change === "head") f.head.head_topology.id = "0x1220" + P.hash("new-head");
      if (change === "rpc") f.rpc.readGeneration++;
      return value;
    };
    const observer = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
    if (change === "none") assert.equal((await observer.inspectCycle({ epoch: "1" })).state, "verified");
    else assert.deepEqual(await observer.inspectCycle({ epoch: "1" }), { state: "changed" });
    assert.ok(peak >= 5, "Independent contract reads must not span serial network round trips");
  }
});
test("a late chain identity probe cannot hide head advancement", async t => {
  const f = await fixture(t); let calls = 0;
  f.rpc.getChainId = async () => { if (++calls === 2) f.head.head_topology.id = "0x1220" + P.hash("late-head"); return f.target.chainId; };
  const observer = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
  assert.deepEqual(await observer.inspectCycle({ epoch: "1" }), { state: "changed" });
});
test("reward evidence still rejects a real clock rollback", async t => {
  const f = await fixture(t); let now = f.clock();
  const observer = new RewardObserver(f.rpc, { target: f.target, clock: () => now });
  await observer.inspectCycle({ epoch: "1" });
  const read = f.rpc.readContract;
  f.rpc.readContract = async op => { const r = await read(op); now--; return r; };
  await assert.rejects(observer.inspectCycle({ epoch: "1" }), /clock moved backwards/);
});
test("closed-epoch proof requires an irreversible observation made after the requested boundary", async t => {
  const f = await fixture(t), observer = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
  const boundary = String(f.clock() + 1000);
  assert.equal((await observer.inspectCycle({ epoch: "1", minimumTime: boundary })).state, "before_boundary");
  f.advance(1001); f.head.last_irreversible_block = "0";
  assert.equal((await observer.inspectCycle({ epoch: "1", minimumTime: boundary })).state, "reversible");
  f.head.last_irreversible_block = f.head.head_topology.height;
  assert.equal((await observer.inspectCycle({ epoch: "1", minimumTime: boundary })).state, "verified");
});

test("moving snapshots wait without a tight retry loop, then recover on coherent reads", async t => {
  const f = await fixture(t), read = f.rpc.readContract, head = f.rpc.getHeadInfo;
  let heads = 0;
  f.rpc.getHeadInfo = async () => { heads++; return head(); };
  f.rpc.readContract = async op => { const r = await read(op); f.advance(1); return r; };
  const observer = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
  for (let i = 0; i < 3; i++) {
    const before = heads;
    assert.deepEqual(await observer.inspectCycle({ epoch: "1" }), { state: "changed" });
    assert.equal(heads - before, 2, "Each tick makes one capture attempt");
  }
  f.rpc.readContract = read;
  assert.equal((await observer.inspectCycle({ epoch: "1" })).state, "verified");
});

test("movement during revalidation cannot expose previously verified evidence", async t => {
  for (const kind of ["head", "rpc"]) {
    const f = await fixture(t), observer = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
    f.rpc.readGeneration = 0;
    assert.equal((await observer.inspectCycle({ epoch: "1" })).state, "verified");
    const read = f.rpc.readContract, blocks = f.rpc.getBlocks;
    if (kind === "head") f.rpc.readContract = async op => { const r = await read(op); f.advance(1); return r; };
    else f.rpc.getBlocks = async (...args) => { f.rpc.readGeneration++; return blocks(...args); };
    assert.deepEqual(await observer.inspectCycle({ epoch: "1" }), { state: "changed" });
    f.rpc.readContract = read; f.rpc.getBlocks = blocks;
    assert.equal((await observer.inspectCycle({ epoch: "1" })).state, "verified");
  }
});

test("late chain mismatch and unrelated errors remain fatal instead of becoming snapshot waits", async t => {
  for (const kind of ["chain", "message"]) {
    const f = await fixture(t); let calls = 0;
    if (kind === "chain") f.rpc.getChainId = async () => ++calls === 2 ? "wrong-chain" : f.target.chainId;
    else f.rpc.readContract = async () => { throw Error("Head changed during reward reads"); };
    const observer = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
    await assert.rejects(observer.inspectCycle({ epoch: "1" }), kind === "chain" ? /chain mismatch/ : /Head changed/);
  }
});

test("a moving payout snapshot leaves its journal queued while the runtime completes independent reward work", async t => {
  const f = await require("./helpers/koin-claims-fixture").fixture(t), read = f.rpc.readContract;
  const { TestRuntime } = require("../lib/koin-network/test-runtime");
  f.rpc.readContract = async op => { const r = await read(op); f.advance(1); return r; };
  let payout, cycles = 0, collection = 0;
  const noop = async () => {};
  const runtime = Object.assign(Object.create(TestRuntime.prototype), {
    clock: f.clock, errors: [], prepaid: true,
    scheduler: { koinPrepaid: { purchases: { tick: noop } } }, prepaidSettlement: { tick: noop },
    client: { verify: noop, read: async () => ({ liquid: "1", liabilities: "0" }) },
    signing: { reconcile: noop }, recoverPreparedRewards: noop, ledger: { pendingJobs: () => [] },
    submitter: { tick: async () => { payout = await f.runner().tick(); } },
    cycleRunner: { tick: async () => { cycles++; } }, collectRewards: async () => { collection++; },
  });
  await runtime.tick();
  assert.equal(payout.results[0].reason, "reward_changed");
  assert.equal(f.ledger.status(f.ids[0]).state, "queued");
  assert.equal(f.sent.length, 0); assert.equal(f.signed.length, 0);
  assert.equal(cycles, 1); assert.equal(collection, 1); assert.deepEqual(runtime.errors, []);
  assert.equal(runtime.lastRewardSuccess, f.clock());
  f.rpc.readContract = read;
  assert.equal((await f.runner().tick()).results[0].action, "await_finality");
  assert.equal(f.sent.length, 1); assert.equal(f.signed.length, 1);
});

test("a finalized payout still needs coherent claimed evidence and never resends because its read window moved", async t => {
  const f = await require("./helpers/koin-claims-fixture").fixture(t);
  await f.runner().tick(); const tx = f.sent[0]; f.finalized(tx);
  const read = f.rpc.readContract;
  f.rpc.readContract = async op => { const r = await read(op); f.advance(1); return r; };
  const waiting = (await f.runner().tick()).results[0];
  assert.equal(waiting.reason, "reward_changed"); assert.equal(waiting.state, "unknown");
  assert.equal(f.ledger.status(f.ids[0]).attempts, 1);
  assert.equal(f.sent.length, 1); assert.equal(f.signed.length, 1);
  f.rpc.readContract = read;
  assert.equal((await f.runner().tick()).results[0].state, "paid");
  assert.equal(f.ledger.status(f.ids[0]).txId, tx.id);
  assert.equal(f.sent.length, 1); assert.equal(f.signed.length, 1);
});

test("a daily cycle cannot sign or broadcast against a moving snapshot", async t => {
  const f = await fixture(t), read = f.rpc.readContract;
  f.rpc.readContract = async op => { const r = await read(op); f.advance(1); return r; };
  assert.equal((await f.runner().tick()).results[0].reason, "cycle_changed");
  assert.equal(f.cycle.status("1").steps[0].state, "queued");
  assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0);
  f.rpc.readContract = read;
  assert.equal((await f.runner().tick()).results[0].action, "await_finality");
  assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 1);
});
