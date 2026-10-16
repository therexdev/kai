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
test("reward reads run together but reject a moving head or a changed RPC generation", async t => {
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
    else await assert.rejects(observer.inspectCycle({ epoch: "1" }), /Head changed|RPC changed/);
    assert.ok(peak >= 5, "Independent contract reads must not span serial network round trips");
  }
});
test("a late chain identity probe cannot hide head advancement", async t => {
  const f = await fixture(t); let calls = 0;
  f.rpc.getChainId = async () => { if (++calls === 2) f.head.head_topology.id = "0x1220" + P.hash("late-head"); return f.target.chainId; };
  const observer = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
  await assert.rejects(observer.inspectCycle({ epoch: "1" }), /Head changed/);
});
test("reward evidence still rejects a real clock rollback", async t => {
  const f = await fixture(t); let now = f.clock();
  const observer = new RewardObserver(f.rpc, { target: f.target, clock: () => now });
  await observer.inspectCycle({ epoch: "1" });
  const read = f.rpc.readContract;
  f.rpc.readContract = async op => { const r = await read(op); now--; return r; };
  await assert.rejects(observer.inspectCycle({ epoch: "1" }), /clock moved backwards/);
});
