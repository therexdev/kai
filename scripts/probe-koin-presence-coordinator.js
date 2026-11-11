"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const { fixture } = require("./helpers/koin-prepaid-fixture"), { ProviderDevices } = require("../lib/koin-network/provider-devices"), { ShadowStore } = require("../lib/koin-network/shadow-store");
const { PresenceCoordinator } = require("../lib/koin-network/presence-coordinator"), { presenceHash } = require("../lib/koin-network/presence");
const D = require("../lib/koin-network/provider-device-protocol"), P = require("../lib/koin-network/job-protocol");
const audience = "https://credits.example.com/scheduler";
function deferred() { let resolve; return { promise: new Promise(r => resolve = r), resolve: value => resolve(value) }; }
function setup(t, options = {}) {
  const f = fixture(t); f.time(86400000 - f.ledger.clock() % 86400000);
  const directory = path.join(f.dir, "shadow"), identity = { schedulerUrl: audience, target: f.target };
  const source = new ProviderDevices({ directory: path.join(f.dir, "presence"), schedulerUrl: audience, target: f.target, clock: () => f.ledger.clock(), presenceOutbox: true });
  let store = new ShadowStore(directory, { identity, staging: true, create: true, clock: () => f.ledger.clock() });
  const client = { ready: Promise.resolve(), health: () => ({ ready: true, state: "ready" }), close: async () => store.close() };
  for (const name of Object.getOwnPropertyNames(ShadowStore.prototype)) if (!name.startsWith("_") && !["constructor", "close"].includes(name)) client[name] = async (...args) => store[name](...args);
  const coordinator = new PresenceCoordinator({ source, client, audience, clock: () => f.ledger.clock(), ...options });
  const q = () => ({ address: f.provider, capacityId: "coordinator-capacity", model: f.tariff.model, modelHash: f.tariff.modelHash,
    benchmarkHash: P.hash("coordinator-benchmark"), modelWeight: "10000", coverageBps: 10000, expires: f.ledger.clock() + 86400000 });
  async function enroll(label = "coordinator") {
    const keys = crypto.generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const { authorization } = source.challenge({ wallet: f.provider, deviceId: P.hash(label), publicKey });
    const walletSignature = Buffer.from(await f.worker.signHash(D.authorizationHash(authorization))).toString("base64");
    const sign = (action, digest) => D.encodeAction(authorization, walletSignature, keys.privateKey, action, digest, f.ledger.clock());
    return { ...source.enroll(D.decodeAction(sign("register", D.authorizationHash(authorization)))), sign };
  }
  function report(sequence = 1) { return { schema: 1, session: "9".repeat(32), sequence, at: f.ledger.clock(), model: f.tariff.model, modelHash: f.tariff.modelHash, ready: true }; }
  function delegated(device, sequence = 1) { const value = report(sequence); return { address: f.provider, report: value, signature: device.sign("presence", presenceHash(f.provider, audience, value)) }; }
  async function legacy(sequence = 1) { const value = report(sequence); return { address: f.provider, report: value, signature: Buffer.from(await f.worker.signHash(presenceHash(f.provider, audience, value))).toString("base64") }; }
  return { ...f, directory, identity, source, client, coordinator, q, enroll, report, delegated, legacy, get store() { return store; },
    reopenStore() { store.close(); store = new ShadowStore(directory, { identity, staging: true, clock: () => f.ledger.clock() }); },
    async close() { await coordinator.close().catch(() => {}); source.close(); } };
}
test("initialization seals and retires before source replay, and a queued tick waits for the complete durable drain", async t => {
  const f = setup(t, { batchSize: 2 });
  try {
    const d = await f.enroll(); f.store.open("100000000000"); f.store.qualify(f.q());
    for (let sequence = 1; sequence <= 4; sequence++) { const b = f.delegated(d, sequence); f.source.observePresence(b.signature, b.address, b.report, { rewardQualified: true }); if (sequence < 4) f.time(25000); }
    f.time(30001); const epoch = Math.floor(f.ledger.clock() / 86400000), gate = deferred(), entered = deferred(), order = [];
    for (const method of ["markSealedMany", "retireUnmatchedQualifications", "qualificationProjection", "ingestPresenceBatch", "tick"]) {
      const call = f.client[method]; f.client[method] = async (...args) => { order.push(method); if (method === "ingestPresenceBatch" && !entered.used) { entered.used = true; entered.resolve(); await gate.promise; } return call(...args); };
    }
    const initializing = f.coordinator.initialize({ sealedEpochs: [], retirement: { models: [], verified: [] } }); await entered.promise;
    const tick = f.coordinator.tick({ maxIntervals: 1 });
    assert.equal(f.store.getDayProgress(epoch).intervalCount, 0); assert.equal(f.source.pendingPresenceStatus().pending, 4);
    assert.deepEqual(order, ["markSealedMany", "retireUnmatchedQualifications", "qualificationProjection", "ingestPresenceBatch"]);
    gate.resolve(); await initializing; await tick;
    assert.deepEqual(order.slice(-3), ["ingestPresenceBatch", "ingestPresenceBatch", "tick"]);
    assert.equal(f.source.pendingPresenceStatus().pending, 0); assert.equal(f.store.getDayProgress(epoch).intervalCount, 1);
    assert.equal(f.store.getClosedEvidence(epoch).intervals[0].slots.length, 1);
  } finally { await f.close(); }
});
test("qualification mutation and source acceptance share one turn and admission overflow never advances replay", async t => {
  const f = setup(t, { maxPending: 2 });
  try {
    const d = await f.enroll(); await f.coordinator.initialize(); const gate = deferred(), entered = deferred();
    const qualify = f.client.qualify; f.client.qualify = async q => { entered.resolve(); await gate.promise; return qualify(q); };
    const qualification = f.coordinator.mutate("qualify", [f.q()]); await entered.promise;
    const p = f.delegated(d), accept = f.coordinator.acceptDelegated(p);
    await assert.rejects(f.coordinator.acceptDelegated(p), error => error.status === 503 && error.code === "SHADOW_STORAGE_BACKPRESSURE");
    assert.equal(f.source.pendingPresenceStatus().nextSequence, 1); gate.resolve(); await qualification;
    const receipt = await accept; assert.equal(receipt.presenceEvent.rewardQualified, true); assert.equal(f.store.getPresence(f.provider).at, receipt.presenceEvent.acceptedAt);
    f.time(10000); await f.coordinator.mutate("expireQualifications", [["coordinator-capacity"], f.ledger.clock()]);
    const next = await f.coordinator.acceptDelegated(f.delegated(d, 2)); assert.equal(next.presenceEvent.rewardQualified, false);
    assert.equal(f.store.getPresence(f.provider).sequence, 1); assert.equal(f.source.pendingPresenceStatus().pending, 0);
  } finally { await f.close(); }
});
test("qualification eligibility uses the server acceptance time after cryptographic verification", async t => {
  const f = setup(t);
  try {
    const d = await f.enroll(); f.store.qualify({ ...f.q(), expires: f.ledger.clock() + 1 }); await f.coordinator.initialize();
    const verify = f.source.verify.bind(f.source); f.source.verify = (...args) => { const result = verify(...args); f.time(1); return result; };
    const accepted = await f.coordinator.acceptDelegated(f.delegated(d));
    assert.equal(accepted.presenceEvent.rewardQualified, false); assert.equal(f.store.getPresence(f.provider), null);
    f.store.qualify({ ...f.q(), expires: f.ledger.clock() + 1 });
    const presence = require("../lib/koin-network/presence"), original = presence.verifyPresence, body = await f.legacy(2);
    presence.verifyPresence = (...args) => { const report = original(...args); f.time(1); return report; };
    try { await assert.rejects(f.coordinator.acceptLegacy(body), /Capacity qualification required/); }
    finally { presence.verifyPresence = original; }
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM legacy_presence_receipts").get().n, 0); assert.equal(f.store.getPresence(f.provider), null);
  } finally { await f.close(); }
});
test("worker loss after commit leaves source pending and blocks closure until a new ordering owner replays it", async t => {
  const f = setup(t);
  try {
    const d = await f.enroll(); f.store.qualify(f.q()); await f.coordinator.initialize();
    const ingest = f.client.ingestPresenceBatch; f.client.ingestPresenceBatch = async events => { await ingest(events); throw Object.assign(Error("worker response lost"), { code: "SHADOW_WRITE_UNCERTAIN" }); };
    await assert.rejects(f.coordinator.acceptDelegated(f.delegated(d)), /response lost/);
    assert.equal(f.source.pendingPresenceStatus().pending, 1); assert.equal(f.coordinator.storageStatus().ready, false);
    await assert.rejects(f.coordinator.tick({ maxIntervals: 1 }), /restart and ordered replay/);
    const at = f.store.getPresence(f.provider).at; await f.coordinator.close(); f.reopenStore(); f.client.ingestPresenceBatch = ingest;
    const resumed = new PresenceCoordinator({ source: f.source, client: f.client, audience, clock: () => f.ledger.clock() });
    try {
      f.time(120000); await resumed.initialize(); assert.equal(f.source.pendingPresenceStatus().pending, 0);
      assert.equal(f.store.getPresence(f.provider).at, at); assert.equal(f.store.db.prepare("SELECT count(*) n FROM presence_samples").get().n, 1);
    } finally { await resumed.close(); }
  } finally { await f.close(); }
});
test("an already dead worker rejects source admission before advancing its replay watermark", async t => {
  const f = setup(t);
  try {
    const d = await f.enroll(); f.store.qualify(f.q()); await f.coordinator.initialize();
    f.client.health = () => ({ ready: false, available: false, state: "failed", failure: { code: "SHADOW_WORKER_UNAVAILABLE" } });
    await assert.rejects(f.coordinator.acceptDelegated(f.delegated(d)), error => error.status === 503 && /before admission/.test(error.message));
    assert.equal(f.source.pendingPresenceStatus().nextSequence, 1); assert.equal(f.source.pendingPresenceStatus().pending, 0);
    assert.equal(f.coordinator.storageStatus().ready, false);
  } finally { await f.close(); }
});
test("stale committed projections can refresh without poisoning an available worker", async t => {
  const f = setup(t);
  try {
    await f.coordinator.initialize(); let fresh = false;
    f.client.health = () => ({ ready: fresh, available: true, state: "ready" });
    f.client.status = async () => { if (!fresh) throw Object.assign(Error("projection is stale"), { code: "SHADOW_WORKER_UNAVAILABLE" }); return f.store.status(f.provider); };
    f.client.refreshProjection = async () => { fresh = true; return { observedAt: f.ledger.clock() }; };
    await assert.rejects(f.coordinator.read("status", [f.provider]), /projection is stale/);
    assert.equal(f.coordinator.storageStatus().failure, null); assert.equal(f.coordinator.storageStatus().ready, false);
    await f.coordinator.read("refreshProjection"); assert.equal(f.coordinator.storageStatus().ready, true);
    assert.equal((await f.coordinator.read("status", [f.provider])).mode, "shadow");
  } finally { await f.close(); }
});
test("source postcommit uncertainty poisons readiness while ordinary invalid signatures remain recoverable", async t => {
  const f = setup(t);
  try {
    const d = await f.enroll(); f.store.qualify(f.q()); await f.coordinator.initialize(); const p = f.delegated(d);
    await assert.rejects(f.coordinator.acceptDelegated({ ...p, signature: "invalid" })); assert.equal(f.coordinator.storageStatus().ready, true);
    const write = f.source.guard.write.bind(f.source.guard); f.source.guard.write = (...args) => { write(...args); throw Error("simulated anchor completion uncertainty"); };
    await assert.rejects(f.coordinator.acceptDelegated(p), error => error.code === "PROVIDER_PRESENCE_WRITE_UNCERTAIN" && error.status === 503);
    assert.equal(f.source.pendingPresenceStatus().pending, 1); assert.equal(f.coordinator.storageStatus().ready, false);
    await assert.rejects(f.coordinator.tick(), /restart and ordered replay/); f.source.guard.write = write;
  } finally { await f.close(); }
});
test("a damaged delivered source receipt blocks readiness even when no source event remains pending", async t => {
  const f = setup(t);
  try {
    const d = await f.enroll(); f.store.qualify(f.q()); await f.coordinator.initialize(); const body = f.delegated(d);
    await f.coordinator.acceptDelegated(body); assert.equal(f.source.pendingPresenceStatus().pending, 0);
    f.source.write(() => f.source.db.prepare("UPDATE presence_receipts SET data=?").run("{"));
    await assert.rejects(f.coordinator.acceptDelegated(body), error => error.code === "PROVIDER_PRESENCE_STORAGE_INVALID" && error.status === 503);
    assert.equal(f.coordinator.storageStatus().ready, false); await assert.rejects(f.coordinator.tick(), /restart and ordered replay/);
  } finally { await f.close(); }
});
test("legacy wallet receipt and sample commit together and an exact stale retry keeps its original acceptance", async t => {
  const f = setup(t);
  try {
    f.store.qualify(f.q()); await f.coordinator.initialize(); const body = await f.legacy(), at = f.ledger.clock();
    const accepted = await f.coordinator.acceptLegacy(body); assert.equal(accepted.acceptedAt, at); assert.equal(accepted.duplicate, false);
    f.time(120000); f.reopenStore();
    const retry = await f.coordinator.acceptLegacy(body); assert.equal(retry.duplicate, true); assert.equal(retry.eventId, accepted.eventId); assert.equal(retry.acceptedAt, at);
    assert.equal(f.store.getPresence(f.provider).at, at); assert.equal(f.store.db.prepare("SELECT count(*) n FROM presence_samples").get().n, 1);
    await assert.rejects(f.coordinator.acceptLegacy({ ...body, report: { ...body.report, ready: false } }), /Expired|signer/);
    const latest = await f.legacy(2); await f.coordinator.acceptLegacy(latest);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM legacy_presence_receipts").get().n, 1);
    await assert.rejects(f.coordinator.acceptLegacy(body), /Expired|Replayed/);
  } finally { await f.close(); }
});
test("legacy worker process death after durable commit recovers exact receipt after qualification expiration", async t => {
  const f = setup(t);
  try {
    f.store.qualify({ ...f.q(), expires: f.ledger.clock() + 15000 }); const body = await f.legacy(), acceptedAt = f.ledger.clock(); f.store.close();
    const script = `const fs=require('node:fs');const {ShadowStore}=require(${JSON.stringify(path.resolve(__dirname, "../lib/koin-network/shadow-store"))});
      const a=JSON.parse(fs.readFileSync(0,'utf8'));const s=new ShadowStore(a.directory,{identity:a.identity,staging:true,clock:()=>a.acceptedAt});
      const r=s.acceptLegacyPresence(a.body,{audience:a.audience,acceptedAt:a.acceptedAt});process.stdout.write(JSON.stringify(r),()=>process.kill(process.pid,'SIGKILL'));`;
    const killed = spawnSync(process.execPath, ["-e", script], { input: JSON.stringify({ directory: f.directory, identity: f.identity, body, audience, acceptedAt }), encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr); const committed = JSON.parse(killed.stdout);
    f.time(120000); f.reopenStore(); await f.coordinator.initialize(); assert.equal(f.store.hasQualifiedCapacity(f.provider), false);
    const retry = await f.coordinator.acceptLegacy(body); assert.equal(retry.eventId, committed.eventId); assert.equal(retry.acceptedAt, acceptedAt); assert.equal(retry.duplicate, true);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM presence_samples").get().n, 1);
  } finally { await f.close(); }
});
test("batch ingestion commits all ordered events once or rolls the entire batch back", async t => {
  const f = setup(t);
  try {
    const d = await f.enroll(); f.store.qualify(f.q()); const events = [];
    for (let sequence = 1; sequence <= 3; sequence++) { const b = f.delegated(d, sequence); events.push(f.source.observePresence(b.signature, b.address, b.report, { rewardQualified: true }).presenceEvent); f.time(10000); }
    await assert.rejects(f.client.ingestPresenceBatch([events[0], events[2]]), /contiguous/);
    assert.equal(f.store.getPresence(f.provider), null); assert.equal(f.store.db.prepare("SELECT count(*) n FROM ingested_events").get().n, 0);
    const before = f.store.db.prepare("SELECT generation FROM recovery_generation").get().generation;
    assert.deepEqual(await f.client.ingestPresenceBatch(events), [{ applied: true }, { applied: true }, { applied: true }]);
    assert.equal(f.store.db.prepare("SELECT generation FROM recovery_generation").get().generation, before + 1);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM presence_samples").get().n, 3);
  } finally { await f.close(); }
});
test("legacy receipt failure rolls back its sample and replay state before acknowledgment", async t => {
  const f = setup(t);
  try {
    f.store.qualify(f.q()); await f.coordinator.initialize(); const body = await f.legacy();
    const write = f.store.guard.write.bind(f.store.guard);
    f.store.guard.write = (db, fn) => write(db, () => { fn(); throw Error("fault before legacy transaction commit"); });
    await assert.rejects(f.coordinator.acceptLegacy(body), /fault before/); f.store.guard.write = write;
    assert.equal(f.store.getPresence(f.provider), null); assert.equal(f.store.db.prepare("SELECT count(*) n FROM legacy_presence_receipts").get().n, 0);
    const retry = await f.coordinator.acceptLegacy(body); assert.equal(retry.duplicate, false);
  } finally { await f.close(); }
});
test("exclusive sink rejects same-process and child writers and close waits for admitted work", async t => {
  const f = setup(t);
  try {
    assert.throws(() => new ShadowStore(f.directory, { identity: f.identity, staging: true }), /Stop every shadow storage writer/);
    const script = `const {ShadowStore}=require(${JSON.stringify(path.resolve(__dirname, "../lib/koin-network/shadow-store"))});new ShadowStore(${JSON.stringify(f.directory)},{identity:${JSON.stringify(f.identity)},staging:true});`;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" }); assert.notEqual(child.status, 0); assert.match(child.stderr, /Stop every shadow storage writer/);
    await f.coordinator.initialize(); const gate = deferred(), entered = deferred();
    const qualify = f.client.qualify; f.client.qualify = async q => { entered.resolve(); await gate.promise; return qualify(q); };
    const work = f.coordinator.mutate("qualify", [f.q()]); await entered.promise; let closed = false;
    const closing = f.coordinator.close().then(() => closed = true); await Promise.resolve(); assert.equal(closed, false);
    await assert.rejects(f.coordinator.acceptLegacy(await f.legacy()), error => error.status === 503);
    gate.resolve(); await work; await closing; assert.equal(closed, true);
  } finally { await f.close(); }
});
test("bounded fair ticking advances today's earnings while a full old day remains queued", async t => {
  const f = setup(t);
  try {
    const old = f.store.open("100000000000"); f.time(2 * 86400000); const today = f.store.open("100000000000"); f.time(105001);
    f.store.tick({ maxIntervals: 8, currentFirst: true });
    assert.equal(f.store.getDayProgress(today.epoch).intervalCount, 1);
    assert.equal(f.store.getDayProgress(old.epoch).intervalCount, 7);
    assert.equal(f.store.getClosedEvidence(today.epoch).intervals[0].start, today.openedAt);
    assert.equal(f.store.getClosedEvidence(old.epoch).intervals[0].start, old.openedAt);
    f.time(600000); f.store.tick({ maxIntervals: 8, currentFirst: true });
    assert.equal(f.store.getDayProgress(today.epoch).intervalCount, 5, "current catch-up reserves four of the eight slots");
    assert.equal(f.store.getDayProgress(old.epoch).intervalCount, 11, "historical catch-up still progresses");
  } finally { await f.close(); }
});
test("qualification refresh validates and commits all retirements and replacements in one ordered transaction", async t => {
  const f = setup(t);
  try {
    const old = f.q(); f.store.qualify(old); await f.coordinator.initialize(); const original = f.store.getQualification(old.capacityId);
    const first = { ...f.q(), capacityId: "new-one" }, second = { ...f.q(), capacityId: "new-two" };
    const refresh = { retired: [old.capacityId], qualifications: [first, second], cutoff: f.ledger.clock() };
    await assert.rejects(f.coordinator.mutate("applyQualificationRefresh", [{ ...refresh, qualifications: [first, { ...second, coverageBps: 0 }] }]), /Invalid coverage/);
    assert.deepEqual(f.store.getQualification(old.capacityId), original); assert.equal(f.store.getQualification(first.capacityId), null);
    f.store._write(() => f.store.db.exec("CREATE TEMP TRIGGER fail_refresh BEFORE INSERT ON qualifications WHEN NEW.capacity_id='new-two' BEGIN SELECT RAISE(ABORT,'refresh failure'); END"));
    await assert.rejects(f.coordinator.mutate("applyQualificationRefresh", [refresh]), /refresh failure/);
    assert.deepEqual(f.store.getQualification(old.capacityId), original); assert.equal(f.store.getQualification(first.capacityId), null);
    f.store._write(() => f.store.db.exec("DROP TRIGGER fail_refresh"));
    const before = f.store.db.prepare("SELECT generation FROM recovery_generation").get().generation;
    const result = await f.coordinator.mutate("applyQualificationRefresh", [refresh]); assert.deepEqual(result, { retired: 1, qualified: 2 });
    assert.equal(f.store.db.prepare("SELECT generation FROM recovery_generation").get().generation, before + 1);
    assert.equal(f.store.getQualification(old.capacityId).expires, refresh.cutoff); assert.equal(f.store.getQualification(first.capacityId).approvedAt, refresh.cutoff);
    await assert.rejects(f.coordinator.mutate("applyQualificationRefresh", [{ ...refresh, cutoff: f.ledger.clock() + 1 }]), /nonfuture cutoff/);
  } finally { await f.close(); }
});
