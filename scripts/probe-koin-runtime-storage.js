"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { TestRuntime } = require("../lib/koin-network/test-runtime");
const { refreshQualifications } = require("../lib/koin-network/availability-runtime");
const { earningHealth, currentEpoch, rewardStorageStatus } = require("../lib/koin-network/earning-health");
const { rewardSummary } = require("../lib/koin-network/reward-summary");
const { providerReadiness } = require("../lib/koin-network/provider-readiness");
const { DAY } = require("../lib/koin-network/policy");
const runtime = properties => Object.assign(Object.create(TestRuntime.prototype), properties);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("startup waits for storage, seals saved manifests and supplies retirement before replay or scheduling", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-runtime-storage-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stateDir, "manifest-1.json"), "{}");
  const ready = deferred(), recovery = deferred(), events = [], verified = [{ capacityId: "verified" }];
  const r = runtime({ stateDir, rewardStorageInitialized: false, config: { qualificationPolicies: [{ schema: 2, kind: "runtime-readiness", model: "model" }] },
    qualifications: () => verified, scheduler: { koinShadow: { ledger: { ready: ready.promise,
      async readUnsealedEpochs() { events.push("epochs"); return ["1", "2"]; },
      async initialize(options) { events.push(options); await recovery.promise; events.push("replay-complete"); }
    } } }, startScheduling() { this.assertRewardStorageInitialized(); events.push("scheduling"); } });
  const first = r.initialize(); assert.equal(r.initialize(), first);
  const started = r.start();
  assert.deepEqual(events, []); assert.throws(() => r.assertRewardStorageInitialized(), /not initialized/);
  ready.resolve(); await new Promise(setImmediate);
  assert.deepEqual(events, ["epochs", { sealedEpochs: ["1"], retirement: { models: ["model"], verified } }]);
  assert.equal(r.rewardStorageInitialized, false);
  recovery.resolve(); await started;
  assert.deepEqual(events.slice(-2), ["replay-complete", "scheduling"]);
  assert.equal(r.rewardStorageInitialized, true);
});

test("failed startup cannot start timers or enter financial operations", async () => {
  const r = runtime({ rewardStorageInitialized: false, scheduler: { koinShadow: { ledger: { ready: Promise.reject(Error("Worker failed")), initialize() {} } } },
    startScheduling() { throw Error("Must not schedule"); }, clock: () => DAY, errors: [], processMetrics: { eventLoopSnapshot: () => ({ available: false }) } });
  await assert.rejects(r.start(), /Worker failed/);
  await r.tick(); assert.match(r.errors[0].message, /not initialized/);
  await r.availabilityTick(); assert.match(r.availabilityError.message, /not initialized/);
  await assert.rejects(r.collectRewards(), /not initialized/);
  assert.equal(r.lastRewardSuccess, undefined); assert.equal(r.lastAvailabilitySuccess, undefined);
});

test("async qualification reads preserve an expired benchmark winner and never consult a false sync miss", async () => {
  const now = DAY + 1000, calls = [], applied = []; let projectionAt = now, currentTime = now;
  const records = ["new", "selected"].map((benchmarkHash, i) => ({ capacityId: "same", benchmarkHash,
    address: "wallet", model: "model", modelHash: "hash", providerAuthorization: "auth-" + i, expires: now + 1000 }));
  const workers = records.map((q, i) => ({ ...q, lastSeen: now, at: now - i }));
  const r = { clock: () => currentTime, qualifications: () => records, qualified: () => true,
    providerDevices: { workerActive: () => true, presence: worker => ({ ...worker, ready: true }) },
    scheduler: { workers: new Map(workers.map(w => [w.providerAuthorization, w])), koinShadow: { ledger: {
      getQualification() { throw Error("Historical records require asynchronous reads"); },
      async readQualifications(ids) { calls.push(ids); projectionAt++; currentTime = projectionAt; return ids.map(capacityId => ({ capacityId, qualification: { benchmarkHash: "selected", expires: now - 1 } })); },
      listQualifications({ expiresAfter }) { assert.ok(expiresAfter >= projectionAt, "retirement uses a fresh cutoff after the cold read advances the projection"); return [{ capacityId: "old", expires: now + 1000 }]; },
      async applyQualificationRefresh(batch) { applied.push(batch); },
      qualify() { throw Error("Worker qualification refresh must be atomic"); },
      expireQualifications() { throw Error("Worker qualification refresh must be atomic"); }
    } } } };
  await refreshQualifications(r);
  assert.deepEqual(calls, [["same"]]); assert.equal(applied.length, 1);
  assert.deepEqual(applied[0], { retired: ["old"], qualifications: [records[1]], cutoff: now + 1 });
  projectionAt = currentTime = now;
  r.scheduler.koinShadow.ledger.readQualifications = async () => [];
  await assert.rejects(refreshQualifications(r), /Incomplete reward qualification snapshot/);
  assert.equal(applied.length, 1, "a partial read cannot alter qualification selection");
});

test("historical reward budget and progress are awaited through cold reads", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-runtime-cold-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stateDir, "manifest-1.json"), '{"manifest":"saved"}');
  const calls = [], budget = deferred(), r = runtime({ stateDir, clock: () => 2 * DAY + 1000, availabilityBusy: true,
    cycle: { days: () => ["1"], importManifest: manifest => calls.push(manifest) },
    client: { read: async () => ({ epoch: { opened_at: String(DAY) } }) },
    scheduler: { koinShadow: { ledger: {
      getBudget() { throw Error("No sync archive reads"); }, getDayProgress() { throw Error("No sync archive reads"); },
      async readBudget(epoch) { calls.push(["budget", epoch]); return budget.promise; },
      async readDayProgress(epoch) { calls.push(["day", epoch]); return { sealed: false }; },
      async markSealed(epoch) { calls.push(["seal", epoch]); }
    } } } });
  const collected = r.collectRewards(); await new Promise(setImmediate);
  assert.deepEqual(calls, [["budget", "1"]]);
  budget.resolve({ openedAt: DAY }); await collected;
  assert.deepEqual(calls, [["budget", "1"], ["day", "1"], ["seal", "1"], { manifest: "saved" }]);
});

test("an empty local qualification pass refreshes a stale projection before reading it or closing minutes", async () => {
  const events = [], refreshed = deferred(); let valid = false;
  const r = runtime({ clock: () => DAY, qualifications: () => [], scheduler: { workers: new Map(), koinShadow: { ledger: {
    async refreshProjection() { events.push("refresh"); await refreshed.promise; valid = true; },
    listQualifications() { assert.equal(valid, true); events.push("active"); return []; },
    async tick() { events.push("tick"); }
  } } } });
  const pass = r.availabilityTick(); assert.deepEqual(events, ["refresh"]);
  refreshed.resolve(); await pass;
  assert.deepEqual(events, ["refresh", "active", "tick"]); assert.equal(r.lastAvailabilitySuccess, DAY);
});

test("financial and availability passes share one qualification refresh until its writes finish", async () => {
  const refreshed = deferred(), retired = deferred(), events = [];
  const r = { clock: () => DAY, qualifications: () => { events.push("qualifications"); return []; },
    scheduler: { workers: new Map(), koinShadow: { ledger: {
      async refreshProjection() { events.push("refresh"); await refreshed.promise; },
      listQualifications: () => [{ capacityId: "obsolete", expires: DAY + 1000 }],
      async applyQualificationRefresh(batch) { events.push(["refresh-batch", batch]); await retired.promise; }
    } } } };
  const first = refreshQualifications(r), second = refreshQualifications(r);
  assert.equal(first, second); assert.deepEqual(events, ["refresh"]);
  refreshed.resolve(); await new Promise(setImmediate);
  assert.deepEqual(events, ["refresh", "qualifications", ["refresh-batch", { retired: ["obsolete"], qualifications: [], cutoff: DAY }]]);
  assert.equal(refreshQualifications(r), first, "shared pass remains active through its final mutation");
  retired.resolve(); await first;
  assert.equal(r.qualificationRefresh, null);
});

test("storage diagnostics distinguish activated worker readiness without leaking raw state or errors", () => {
  assert.deepEqual(rewardStorageStatus({}), { schema: 1, mode: "legacy-json", ready: true, initialized: true, worker: null });
  const r = { rewardStorageInitialized: true, scheduler: { koinShadow: { ledger: { storageStatus: () => ({
    mode: "sqlite-shadow", initialized: true, ready: true, failure: "private path", worker: {
      state: "ready", ready: true, projectionAgeMs: 100, queueDepth: 2, failure: "private error", directory: "private directory"
    } }) } } } };
  assert.deepEqual(rewardStorageStatus(r), { schema: 1, mode: "sqlite-shadow", ready: true, initialized: true,
    worker: { state: "ready", ready: true, projectionAgeMs: 100, queueDepth: 2 } });
  r.rewardStorageInitialized = false;
  assert.equal(rewardStorageStatus(r).ready, false);
  r.scheduler.koinShadow.ledger.storageStatus = () => { throw Error("private state"); };
  assert.deepEqual(rewardStorageStatus(r), { schema: 1, mode: "sqlite-shadow", ready: false, initialized: false, worker: null });
});

test("stale or failed storage reports unavailable earnings without hiding signed pending rewards", () => {
  const now = 2 * DAY + 120000, forbidden = () => { throw Error("No unavailable storage reads"); };
  const r = { clock: () => now, lastAvailabilitySuccess: now, config: { models: [{ tariff: { model: "a" } }, { tariff: { model: "b" } }] },
    qualifications: forbidden, scheduler: { koinShadow: { ledger: { storageStatus: () => ({ ready: false }), getBudget: forbidden,
      getDayProgress: forbidden, getAvailability: forbidden, getPresence: forbidden } } },
    claims: { accountStatus: () => [] }, cycle: { days: () => ["1"], readyDays: () => [],
      accountAllocation: () => ({ availability: "10", work: "3" }), status: () => ({ steps: [] }) } };
  const health = earningHealth(r);
  assert.equal(health.ready, false); assert.deepEqual(health.reasons, ["reward_storage_unavailable"]);
  assert.equal(health.currentEpoch.budgetPresent, null); assert.equal(health.currentEpoch.intervalCount, null);
  assert.deepEqual(currentEpoch(r), health.currentEpoch);
  const summary = rewardSummary(r, "wallet");
  assert.equal(summary.current.availability, null); assert.equal(summary.current.asOf, null);
  assert.deepEqual(summary.pending, [{ epoch: "1", availability: "10", work: "3", state: "awaiting_review", reviewUntil: null }]);
  const readiness = providerReadiness(r, "wallet");
  assert.equal(readiness.state, "network-paused"); assert.deepEqual(readiness.readyModels, []);
  r.scheduler.koinShadow.ledger.storageStatus = () => ({ ready: true });
  assert.equal(earningHealth(r).ready, false, "an inconsistent projection getter also fails closed");
  assert.equal(rewardSummary(r, "wallet").pending.length, 1);
});

test("runtime closes source journals only after scheduler worker drain settles, even on failure", async () => {
  const drain = deferred(), events = [], resource = name => ({ close() { events.push(name); } });
  const r = runtime({ prices: {}, scheduler: { close: () => drain.promise }, claims: resource("claims"), cycle: resource("cycle"),
    signing: resource("signing"), hosts: resource("hosts"), providerDevices: resource("source") });
  const closing = r.close(); assert.deepEqual(events, []);
  drain.reject(Error("Worker failed after joining"));
  await assert.rejects(closing, /Worker failed after joining/);
  assert.deepEqual(events, ["claims", "cycle", "signing", "hosts", "source"]);
});
