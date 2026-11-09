"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { Worker } = require("node:worker_threads");
const { Signer } = require("koilib"), { ShadowStore } = require("../lib/koin-network/shadow-store"), { WorkerShadow } = require("../lib/koin-network/shadow-worker"), P = require("../lib/koin-network/policy");
const address = Signer.fromSeed("worker-shadow-a").address, other = Signer.fromSeed("worker-shadow-b").address, start = P.DAY, identity = { chain: "test", scheduler: "worker" };
const q = (capacityId = "slot", changes = {}) => ({ address, capacityId, model: "approved", modelHash: "1".repeat(64), modelWeight: "10000", coverageBps: 10000,
  benchmarkHash: "2".repeat(64), approvedAt: start, expires: 2 * P.DAY, ...changes });
const sample = offset => ({ session: "a".repeat(32), sequence: offset + 1, model: "approved", modelHash: "1".repeat(64), ready: true, at: start + offset, signedAt: start + offset });
function fixture(t, { qualifications = { slot: q() }, limits, workerFactory } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-worker-"));
  const samples = [0,25000,50000,75000].map(sample), source = path.join(root, "koin-shadow.json"), directory = path.join(root, "store");
  const state = { schema: 1, mode: "shadow", qualifications, presence: { [address]: { ...samples.at(-1), samples } }, observations: {},
    budgets: { 1: { epoch: 1, version: 1, openedAt: start, total: "1000000", availability: "700000", work: "300000" } }, days: { 1: { intervals: [], work: [] } } };
  fs.writeFileSync(source, JSON.stringify(state)); ShadowStore.migrateLegacy({ sourceFile: source, directory, identity, clock: () => start + 105001 });
  const f = { root, directory, state, now: start + 105001, spawned: 0, messages: [] };
  f.client = new WorkerShadow(directory, { identity, staging: true, clock: () => f.now, limits,
    workerFactory: (entry, options) => { f.spawned++; const worker = workerFactory ? workerFactory(entry, options) : new Worker(entry, options); worker.on("message", message => f.messages.push(message)); return worker; } });
  t.after(async () => { await f.client.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }); return f;
}
test("worker startup is lazy and complete committed projections exclude all archive evidence", async t => {
  const f = fixture(t);
  assert.equal(f.spawned, 0); assert.equal(f.client.health().state, "new"); assert.throws(() => f.client.getBudget(1), /unavailable/);
  await f.client.ready; assert.equal(f.spawned, 1); assert.equal(f.client.health().ready, true);
  assert.deepEqual(f.client.getBudget(1), f.state.budgets[1]);
  assert.deepEqual(f.client.getPresence(address), Object.fromEntries(Object.entries(f.state.presence[address]).filter(([key]) => key !== "samples")));
  assert.equal(f.client.getPresence(other), null); assert.deepEqual(f.client.getAvailability(1, other), { availability: "0", asOf: start });
  assert.deepEqual(f.client.listQualifications({ expiresAfter: f.now }), [q()]); assert.equal(f.client.hasQualifiedCapacity(address), true);
  const snapshot = f.messages.find(message => message.type === "ready").snapshot;
  assert.equal(JSON.stringify(snapshot).includes('"samples"'), false); assert.equal(JSON.stringify(snapshot).includes('"intervals"'), false);
  const budget = f.client.getBudget(1); budget.total = "0"; assert.equal(f.client.getBudget(1).total, "1000000");
  await f.client.close(); assert.equal(f.client.health().state, "closed"); assert.equal(f.client.worker.threadId, -1);
});
test("mutation acknowledgments update only changed metadata and exact current totals before resolving", async t => {
  const f = fixture(t); await f.client.ready;
  await f.client.tick(); assert.equal(f.client.getDayProgress(1).intervalCount, 1);
  const evidence = await f.client.getManifestEvidence(1), allocation = evidence.allocation.allocations.find(row => row.address === address);
  assert.equal(f.client.getAvailability(1, address).availability, allocation.availability);
  f.now += 10000; const report = { schema: 1, session: "a".repeat(32), sequence: 999999, at: f.now, model: "approved", modelHash: "1".repeat(64), ready: false };
  await f.client.observe(address, report); assert.equal(f.client.getPresence(address).at, f.now); assert.equal(f.client.getPresence(address).ready, false);
  const delta = f.messages.filter(message => message.type === "result").at(-1).delta;
  assert.deepEqual(Object.keys(delta).sort(), ["epoch", "observedAt", "presence"]); assert.equal(delta.presence.length, 1);
  const work = [{ epoch: 1, jobId: "worker-job", address, points: "1", charged: "101", verified: true, finalized: true }];
  await f.client.commitWork(1, work); assert.equal(f.client.status(address).estimate.work, "80");
  const newQ = q("second", { address: other, approvedAt: undefined, expires: f.now + P.DAY }); delete newQ.approvedAt;
  await f.client.qualify(newQ); assert.equal(f.client.getQualification("second").approvedAt, f.now);
  assert.equal(f.client.hasQualifiedCapacity(other), true); await f.client.expireQualifications(["second"], f.now);
  assert.equal(f.client.hasQualifiedCapacity(other), false); assert.throws(() => f.client.getQualification("second"), { code: "SHADOW_ASYNC_READ_REQUIRED" });
  assert.equal((await f.client.readQualification("second")).expires, f.now);
});
test("expired latest qualification identity remains available only through explicit bounded cold reads", async t => {
  const expired = q("expired", { expires: start + 100000, benchmarkHash: "3".repeat(64) }), f = fixture(t, { qualifications: { slot: q(), expired } });
  await f.client.ready; assert.throws(() => f.client.getQualification("expired"), { code: "SHADOW_ASYNC_READ_REQUIRED" });
  assert.throws(() => f.client.getQualification("missing"), { code: "SHADOW_ASYNC_READ_REQUIRED" });
  assert.deepEqual(await f.client.readQualifications(["expired", "missing", "slot"]), [
    { capacityId: "expired", qualification: expired }, { capacityId: "missing", qualification: null }, { capacityId: "slot", qualification: q() }]);
  assert.throws(() => f.client.getBudget(0), { code: "SHADOW_ASYNC_READ_REQUIRED" }); assert.equal(await f.client.readBudget(0), null);
  assert.deepEqual(await f.client.getUnsealedEpochs(), ["1"]);
});
test("missing data and rejected domain operations cannot shut down healthy storage", async t => {
  const f = fixture(t); await f.client.ready;
  await assert.rejects(f.client.getManifestEvidence(999), { code: "SHADOW_NOT_FOUND" });
  await assert.rejects(f.client.readManifest(1), { code: "SHADOW_INVALID_ARGUMENT" });
  await assert.rejects(f.client.readQualification("__proto__"), { code: "SHADOW_INVALID_ARGUMENT" });
  await assert.rejects(f.client.readQualifications(["slot", "invalid space"]), { code: "SHADOW_INVALID_ARGUMENT" });
  await assert.rejects(f.client.qualify(q("bad", { modelHash: "invalid" })), /Verified benchmark/);
  await assert.rejects(f.client.tick({ maxIntervals: 9 }), { code: "SHADOW_INVALID_ARGUMENT" });
  await assert.rejects(f.client.invoke("db.exec", ["DELETE FROM days"]), { code: "SHADOW_INVALID_ARGUMENT" });
  assert.equal(f.client.health().ready, true); await f.client.tick(); assert.equal(f.client.getDayProgress(1).intervalCount, 1);
});
test("stale and rolled-over projections fail closed until an ordered refresh completes", async t => {
  const f = fixture(t); await f.client.ready;
  f.now += 30001; assert.equal(f.client.health().ready, false); assert.equal(f.client.health().available, true);
  assert.throws(() => f.client.getPresence(address), { code: "SHADOW_WORKER_UNAVAILABLE" });
  await f.client.refreshProjection(); assert.equal(f.client.health().ready, true);
  f.now = 2 * P.DAY + 1000; assert.equal(f.client.health().ready, false);
  await f.client.refreshProjection(); assert.equal(f.client.health().ready, true); assert.equal(f.client.getBudget(2), null);
  assert.deepEqual(f.client.getAvailability(2, address), { availability: null, asOf: null });
  assert.deepEqual(f.client.listQualifications(), []); assert.equal((await f.client.readQualification("slot")).benchmarkHash, q().benchmarkHash);
  const manifest = await f.client.readManifest(1); assert.equal(manifest.epoch, 1);
});
test("projection and payload bounds are explicit and no worker starts merely to close", async t => {
  const never = fixture(t); await never.client.close(); assert.equal(never.spawned, 0);
  const capped = fixture(t, { qualifications: { one: q("one"), two: q("two", { address: other }) }, limits: { maxRows: 1 } });
  await assert.rejects(capped.client.ready, /row limit/); await assert.rejects(capped.client.close());
  assert.equal(capped.client.health().ready, false); assert.equal(capped.client.worker.threadId, -1);
  const normal = fixture(t, { limits: { maxRequestBytes: 512, queueBytes: 1024 } }); await normal.client.ready;
  await assert.rejects(normal.client.readQualifications(["x".repeat(1024)]), { code: "SHADOW_PAYLOAD_LIMIT" });
  assert.equal(normal.client.health().queueDepth, 0); assert.equal(normal.client.health().ready, true);
});
test("close waits for admitted commands and worker exit, including close during startup", async t => {
  const f = fixture(t); const starting = f.client.ready, closing = f.client.close(); await starting; await closing;
  assert.equal(f.client.worker.threadId, -1); assert.equal(f.client.health().state, "closed");
  const g = fixture(t); await g.client.ready;
  const one = g.client.tick(), two = g.client.markSealedMany([1]), done = g.client.close();
  await assert.rejects(g.client.readBudget(1), { code: "SHADOW_WORKER_UNAVAILABLE" });
  await one; assert.equal(await two, 1); await done; assert.equal(g.client.worker.threadId, -1);
  const reopened = new ShadowStore(g.directory, { identity, clock: () => g.now, staging: true });
  try { assert.equal(reopened.getDayProgress(1).sealed, true); assert.equal(reopened.getDayProgress(1).intervalCount, 1); } finally { reopened.close(); }
});
test("atomic qualification refresh publishes only the final committed capacity set", async t => {
  const f = fixture(t); await f.client.ready;
  const second = q("second", { address: other, expires: f.now + P.DAY }); delete second.approvedAt;
  const before = f.client.getQualification("slot");
  await assert.rejects(f.client.applyQualificationRefresh({ retired: ["slot"], qualifications: [{ ...second, modelWeight: "0" }], cutoff: f.now }), /expire within a day/);
  assert.deepEqual(f.client.getQualification("slot"), before); assert.equal(f.client.health().ready, true);
  assert.deepEqual(await f.client.applyQualificationRefresh({ retired: ["slot"], qualifications: [second], cutoff: f.now }), { retired: 1, qualified: 1 });
  assert.deepEqual(f.client.listQualifications().map(row => row.capacityId), ["second"]);
  assert.equal(f.client.hasQualifiedCapacity(address), false); assert.equal(f.client.hasQualifiedCapacity(other), true);
  assert.deepEqual(await f.client.applyQualificationRefresh({ cutoff: f.now }), { retired: 0, qualified: 0 }, "valid omitted arrays do not become a postcommit protocol failure");
});
test("the production worker clock advances through proof verification before legacy acceptance", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-worker-clock-")), directory = path.join(root, "store"); let client;
  t.after(async () => { await client?.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const signer = Signer.fromSeed("worker-shadow-a"), store = new ShadowStore(directory, { identity, create: true, staging: true });
  try { store.open("1000000"); store.qualify(q("slot", { expires: Date.now() + P.DAY })); } finally { store.close(); }
  const wrapper = path.join(root, "worker-clock-wrapper.js"), storePath = require.resolve("../lib/koin-network/shadow-store"), presencePath = require.resolve("../lib/koin-network/presence");
  fs.writeFileSync(wrapper, `const {workerData}=require('node:worker_threads');const entry=workerData.clockEntry;delete workerData.clockEntry;
const presence=require(${JSON.stringify(presencePath)}),verify=presence.verifyPresence;presence.verifyPresence=(...args)=>{const value=verify(...args);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60);return value;};
const {ShadowStore}=require(${JSON.stringify(storePath)}),accept=ShadowStore.prototype.acceptLegacyPresence;ShadowStore.prototype.acceptLegacyPresence=function(...args){const testStartedAt=this.clock();return {...accept.apply(this,args),testStartedAt};};require(entry);`);
  let deliveryDelay = 0;
  client = new WorkerShadow(directory, { identity, staging: true, workerFactory: (entry, options) => {
    const worker = new Worker(wrapper, { ...options, workerData: { ...options.workerData, clockEntry: entry } }), post = worker.postMessage.bind(worker);
    worker.postMessage = message => { if (message.method === "acceptLegacyPresence" && deliveryDelay) setTimeout(() => post(message), deliveryDelay); else post(message); };
    return worker;
  } });
  await client.ready;
  const audience = "https://worker.invalid", report = { schema: 1, session: "a".repeat(32), sequence: 1, at: Date.now(), model: "approved", modelHash: "1".repeat(64), ready: true };
  const signature = Buffer.from(await signer.signHash(require("../lib/koin-network/presence").presenceHash(address, audience, report))).toString("base64");
  const result = await client.acceptLegacyPresence({ address, report, signature }, { audience });
  assert.ok(result.acceptedAt - result.testStartedAt >= 50, "acceptance uses post-verification wall time, not frozen dispatch time");
  assert.equal(client.getPresence(address).at, result.acceptedAt); assert.equal(client.health().ready, true);
  const secondSigner = Signer.fromSeed("worker-shadow-b");
  await client.qualify(q("second", { address: other, expires: Date.now() + 150 }));
  const secondReport = { ...report, at: Date.now() }, secondSignature = Buffer.from(await secondSigner.signHash(require("../lib/koin-network/presence").presenceHash(other, audience, secondReport))).toString("base64");
  deliveryDelay = 300;
  await assert.rejects(client.acceptLegacyPresence({ address: other, report: secondReport, signature: secondSignature }, { audience }), /Capacity qualification required/);
  assert.equal(client.getPresence(other), null, "IPC delay cannot backdate acceptance across qualification expiry");
  assert.equal(client.health().ready, true); await client.close();
});
