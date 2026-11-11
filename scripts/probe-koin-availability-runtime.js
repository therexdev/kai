"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { TestRuntime } = require("../lib/koin-network/test-runtime");
const { refreshAvailability } = require("../lib/koin-network/availability-runtime");
const { earningHealth } = require("../lib/koin-network/earning-health");
const { DAY } = require("../lib/koin-network/policy");
function fixture() {
  const now = DAY + 120000, current = new Map(), writes = [], workers = new Map();
  const r = Object.assign(Object.create(TestRuntime.prototype), {
    clock: () => now, errors: [], config: {}, qualifications: () => [],
    scheduler: { workers, koinShadow: { ledger: {
      getPresence: () => null, getQualification: id => current.get(id), listQualifications: () => [...current.values()],
      expireQualifications(ids, at) { writes.push(["retire", ids, at]); for (const id of ids) current.get(id).expires = at; },
      qualify(q) { writes.push(["qualify", q.capacityId]); current.set(q.capacityId, { ...q }); },
      tick() { writes.push(["tick"]); }, getBudget: () => ({ openedAt: DAY }),
      getDayProgress: () => ({ present: true, intervalCount: 1, lastIntervalEnd: DAY + 60000 }),
    } } },
    client: new Proxy({}, { get() { throw Error("Local availability must not access RPC"); } }),
  });
  return { r, now, current, writes, workers };
}
test("local earning progress continues while the financial pass is blocked, with no chain or signer access", async () => {
  const { r, now, writes } = fixture(); r.busy = true;
  r.signing = new Proxy({}, { get() { throw Error("No signing from local earning pass"); } });
  await r.availabilityTick(); assert.deepEqual(writes, [["tick"]]);
  assert.equal(r.lastAvailabilitySuccess, now); assert.equal(r.busy, true);
  assert.equal(r.lastRewardSuccess, undefined); assert.equal(r.lastSuccess, undefined);
  assert.equal(earningHealth(r).ready, true);
});
test("one qualification snapshot preserves live device, model and expiry boundaries", async () => {
  const { r, now, current, writes, workers } = fixture(); let reads = 0, presenceReads = 0;
  const records = Array.from({ length: 16 }, (_, i) => ({ address: "wallet", model: "model-" + i, modelHash: "hash-" + i,
    capacityId: "slot-" + i, benchmarkHash: "benchmark", expires: now + DAY - 1, providerAuthorization: "auth", providerDeviceId: "device" }));
  current.set("revoked-slot", { capacityId: "revoked-slot", expires: now + 1000 });
  const worker = { address: "wallet", providerAuthorization: "auth", providerDeviceId: "device", lastSeen: now };
  workers.set("worker", worker);
  r.providerDevices = { workerActive: w => w === worker,
    presence: () => { presenceReads++; return { ready: true, at: now, model: "model-3", modelHash: "hash-3" }; } };
  r.qualifications = () => { reads++; return records; };
  await refreshAvailability(r);
  assert.equal(reads, 1); assert.equal(presenceReads, 1);
  assert.deepEqual(writes, [["retire", ["revoked-slot"], now], ["qualify", "slot-3"], ["tick"]]);
  assert.equal(current.get("revoked-slot").expires, now);
  r.providerDevices.workerActive = () => false;
  await refreshAvailability(r); assert.equal(current.get("slot-3").expires, now);
});
test("availability errors do not claim progress and overlapping local passes do not multiply work", async () => {
  const { r, now } = fixture(); let release, count = 0;
  r.scheduler.koinShadow.ledger.tick = () => { count++; return new Promise(resolve => { release = resolve; }); };
  const first = r.availabilityTick(); await r.availabilityTick(); assert.equal(count, 1);
  release(); await first; assert.equal(r.lastAvailabilitySuccess, now);
  r.clock = () => now + 5000;
  r.scheduler.koinShadow.ledger.tick = () => { throw Error("Disk write failed"); };
  await r.availabilityTick(); assert.equal(r.lastAvailabilitySuccess, now);
  assert.equal(r.availabilityBusy, false); assert.equal(r.availabilityError.at, now + 5000);
  assert.ok(earningHealth(r).reasons.includes("availability_processing_error"));
  r.stopped = true; r.scheduler.koinShadow.ledger.tick = () => { throw Error("must not run"); };
  await r.availabilityTick(); assert.equal(r.availabilityError.at, now + 5000);
});
test("earning health distinguishes funded tracking, delayed opening, a stale local pass and stalled intervals", () => {
  const { r, now } = fixture(); r.lastAvailabilitySuccess = now;
  r.lastRewardSuccess = now - DAY;
  assert.equal(earningHealth(r).ready, true, "a payout finality wait is not an earning outage");
  r.clock = () => now + 30001; assert.ok(earningHealth(r).reasons.includes("availability_processing_stale"));
  r.lastAvailabilitySuccess = now + 30001;
  r.scheduler.koinShadow.ledger.getDayProgress = () => ({ present: true, intervalCount: 0, lastIntervalEnd: null });
  assert.ok(earningHealth(r).reasons.includes("earning_intervals_stale"));
  r.scheduler.koinShadow.ledger.getBudget = () => null;
  assert.ok(earningHealth(r).reasons.includes("awaiting_funded_epoch"));
  r.clock = () => DAY + 1000;
  r.lastAvailabilitySuccess = DAY + 1000;
  r.scheduler.koinShadow.ledger.getBudget = () => ({ openedAt: DAY });
  assert.equal(earningHealth(r).ready, true, "first full minute gets its evidence grace");
  r.stopped = true; assert.ok(earningHealth(r).reasons.includes("stopping"));
});
test("current-day budget import precedes a failing historical lookup", async () => {
  const { r, writes } = fixture(), reads = [];
  r.cycle = { days: () => ["0", "1"] };
  r.scheduler.koinShadow.ledger.getBudget = () => null;
  r.scheduler.koinShadow.ledger.importBudget = (epoch, budget) => { writes.push(["budget", epoch, budget.openedAt]); };
  r.client = { read: async (_contract, _method, { epoch }) => {
    reads.push(epoch);
    if (epoch === "0") throw Error("Historical RPC unavailable");
    return { epoch: { opened_at: String(DAY), version: "1", budget: "10", availability_budget: "7", work_budget: "3" } };
  } };
  await assert.rejects(r.collectRewards(), /Historical RPC unavailable/);
  assert.deepEqual(reads, ["1", "0"]);
  assert.deepEqual(writes, [["budget", "1", DAY], ["tick"]]);
});
