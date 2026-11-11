"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http");
const { Worker } = require("node:worker_threads"), { DatabaseSync } = require("node:sqlite"), { EventEmitter } = require("node:events"), { spawn } = require("node:child_process");
const { fixture } = require("./helpers/koin-prepaid-fixture"), { ShadowStore } = require("../lib/koin-network/shadow-store"), { WorkerShadow } = require("../lib/koin-network/shadow-worker");
const { ProviderDevices } = require("../lib/koin-network/provider-devices"), { createShadowRouter } = require("../lib/koin-network/shadow-router");
const { createHandler, startRuntimeServer } = require("../test-server"), { presenceHash } = require("../lib/koin-network/presence");
const D = require("../lib/koin-network/provider-device-protocol"), P = require("../lib/koin-network/job-protocol"), { DAY } = require("../lib/koin-network/policy");
const audience = "https://credits.example.com/scheduler", faultEntry = path.join(__dirname, "helpers/koin-storage-worker-fault.js");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = "fixture did not reach its boundary", timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) { if (performance.now() >= deadline) throw Error(message); await wait(5); }
}
function fault(mode) {
  const barrier = new SharedArrayBuffer(32), words = new Int32Array(barrier), value = { mode, words, worker: null, methods: [] };
  value.arm = () => { words.fill(0); Atomics.store(words, 0, 1); };
  value.release = () => { Atomics.store(words, 2, 1); Atomics.notify(words, 2); };
  value.entered = () => until(() => Atomics.load(words, 1) === 1);
  value.factory = (entry, options) => {
    const worker = value.worker = new Worker(mode ? faultEntry : entry, {
      ...options, workerData: { ...options.workerData, ...(mode && { integrationFault: { entry, mode, barrier } }) },
    }), post = worker.postMessage.bind(worker);
    worker.postMessage = message => { value.methods.push(message.method); post(message); }; return worker;
  };
  return value;
}
async function setup(t) {
  const f = fixture(t), now = f.ledger.clock(), today = Math.floor(now / DAY), old = today - 1;
  const sourceDirectory = path.join(f.dir, "devices"), directory = path.join(f.dir, "durable-shadow"), markerFile = path.join(f.dir, "activation.json"), legacy = path.join(f.dir, "source.json");
  const identity = { schedulerUrl: audience, target: f.target }, budget = (epoch, openedAt) => ({ epoch, version: 1, openedAt, total: "1000003", availability: "700002", work: "300001" });
  const qualification = { address: f.provider, capacityId: "fixture-capacity", model: f.tariff.model, modelHash: f.tariff.modelHash,
    benchmarkHash: P.hash("worker-integration"), modelWeight: "10000", coverageBps: 10000, approvedAt: now - 1000, expires: now + 600000 };
  fs.writeFileSync(legacy, JSON.stringify({ schema: 1, mode: "shadow", qualifications: { "fixture-capacity": qualification }, presence: {}, observations: {},
    budgets: { [old]: budget(old, old * DAY), [today]: budget(today, Math.floor(now / 60000) * 60000) },
    days: { [old]: { sealed: true, intervals: Array.from({ length: 120 }, (_, i) => ({ start: old * DAY + i * 60000, end: old * DAY + (i + 1) * 60000, slots: [] })), work: [] }, [today]: { intervals: [], work: [] } } }));
  const migration = ShadowStore.migrateLegacy({ sourceFile: legacy, directory, identity, clock: () => now });
  fs.writeFileSync(markerFile, JSON.stringify(migration.descriptor), { mode: 0o600 });
  const sourceOptions = { directory: sourceDirectory, schedulerUrl: audience, target: f.target, presenceOutbox: true }, devices = new ProviderDevices({ ...sourceOptions, clock: () => now });
  let body;
  try {
    const keys = crypto.generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const { authorization } = devices.challenge({ wallet: f.provider, deviceId: P.hash("worker-integration-device"), publicKey });
    const walletSignature = Buffer.from(await f.worker.signHash(D.authorizationHash(authorization))).toString("base64");
    const sign = (action, digest) => D.encodeAction(authorization, walletSignature, keys.privateKey, action, digest, now);
    const device = devices.enroll(D.decodeAction(sign("register", D.authorizationHash(authorization))));
    const report = { schema: 1, session: device.deviceId.slice(0, 32), sequence: 1, at: now, model: f.tariff.model, modelHash: f.tariff.modelHash, ready: true };
    body = { address: f.provider, report, signature: sign("presence", presenceHash(f.provider, audience, report)) };
  } finally { devices.close(); }
  return { now, today, old, identity, directory, markerFile, sourceOptions, body, target: f.target, qualification,
    storage: { mode: "sqlite-shadow", directory, markerFile, descriptor: migration.descriptor } };
}
function request(origin, route, body) {
  let request;
  const promise = new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    request = http.request(origin + route, { method: encoded ? "POST" : "GET", agent: false,
      headers: encoded ? { "content-type": "application/json", "content-length": encoded.length } : {} }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); }
      }); response.on("error", reject);
    });
    request.on("error", reject); if (encoded) request.write(encoded); request.end();
  });
  return { promise, abort: () => request.destroy(Error("Fixture client disconnected")) };
}
function build(f, control = fault(null), clock = () => f.now) {
  const source = new ProviderDevices({ ...f.sourceOptions, clock });
  const router = createShadowRouter({ dataDir: path.join(f.directory, "unused-legacy"), operatorSecret: "a".repeat(64), audience,
    clock, providerDevices: source, storage: f.storage, identity: f.identity, workerOptions: { workerFactory: control.factory } });
  let closed = false;
  const runtime = { clock, stopped: false, busy: false, availabilityBusy: false, prepaid: true, lastServing: f.now, lastAvailabilitySuccess: f.now,
    scheduler: { koinShadow: router, handle: (req, res) => router.handle(req, res) }, client: { verify: async () => {} }, claims: {},
    initialize: async () => { await router.ledger.ready; await router.ledger.initialize({ sealedEpochs: [String(f.old)] }); }, start: async () => {},
    stopScheduling: () => {}, close: async () => { try { await router.ledger.close(); } finally { source.close(); closed = true; } } };
  const config = { mode: "mainnet-pilot", schedulerUrl: audience, deployment: { chainId: f.target.chainId, credits: f.target.credits, product: "prepaid-usd-v1" } };
  const server = http.createServer(createHandler({ runtime, config, secret: "a".repeat(64) })), signals = new EventEmitter(), exits = [];
  return { source, router, runtime, server, signals, exits, control, get closed() { return closed; },
    start: () => startRuntimeServer({ runtime, server, port: 0, signals, exit: code => exits.push(code), report: () => {} }),
    get origin() { return `http://127.0.0.1:${server.address().port}`; },
    async cleanup() { control.release(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); try { await router.ledger.close(); } catch {} if (!closed) { source.close(); closed = true; } }
  };
}
function stored(f) {
  const db = new DatabaseSync(path.join(f.directory, "shadow.sqlite"), { readOnly: true });
  try { return { samples: db.prepare("SELECT count(*) AS n FROM presence_samples").get().n, receipts: db.prepare("SELECT count(*) AS n FROM ingested_events").get().n }; }
  finally { db.close(); }
}
async function child(f, mode) {
  const p = spawn(process.execPath, [__filename, "--fault-child", mode], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const parts = [], errors = []; p.stdout.on("data", value => parts.push(value)); p.stderr.on("data", value => errors.push(value));
  p.stdin.end(JSON.stringify(f));
  const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
  try {
    const [code, signal] = await new Promise((resolve, reject) => { p.once("error", reject); p.once("close", (...args) => resolve(args)); });
    assert.equal(signal, null, Buffer.concat(errors).toString()); assert.equal(code, 0, Buffer.concat(errors).toString());
    return JSON.parse(Buffer.concat(parts).toString());
  } finally { clearTimeout(timer); }
}
async function faultChild() {
  const f = JSON.parse(fs.readFileSync(0, "utf8")), mode = process.argv[3], control = fault(mode === "recover" ? null : mode), app = build(f, control);
  let result;
  try {
    try { await app.start(); }
    catch (error) { result = { ready: false, failure: String(error.message), pending: app.source.pendingPresenceStatus().pending }; return; }
    if (mode === "recover") {
      const response = await request(app.origin, "/scheduler/koin/presence", f.body).promise;
      result = { ready: true, status: response.status, pending: app.source.pendingPresenceStatus().pending, stored: stored(f) }; return;
    }
    control.arm(); const pending = request(app.origin, "/scheduler/koin/presence", f.body).promise;
    await control.entered(); assert.equal(app.source.pendingPresenceStatus().pending, 1);
    await control.worker.terminate();
    const response = await pending;
    result = { ready: false, status: response.status, pending: app.source.pendingPresenceStatus().pending, storageReady: app.router.ledger.storageStatus().ready, stored: stored(f) };
  } finally { await app.cleanup(); if (result) process.stdout.write(JSON.stringify(result)); }
}
if (process.argv[2] === "--fault-child") faultChild().catch(error => { console.error(error); process.exitCode = 1; });
else {
  test("real historical worker CPU contention keeps HTTP health responsive and coordinator admission bounded", { timeout: 20000 }, async t => {
    const f = await setup(t), control = fault("allocation"), app = build(f, control);
    try {
      await app.start(); control.arm(); const history = app.router.ledger.getManifestEvidence(f.old); await control.entered();
      const limit = app.router.ledger.storageStatus().limit, responses = [], offered = limit + 4;
      const heartbeats = Array.from({ length: offered }, () => request(app.origin, "/scheduler/koin/presence", f.body).promise.then(value => { responses.push(value); return value; }));
      await until(() => responses.filter(value => value.status === 503).length >= 5);
      assert.equal(app.router.ledger.storageStatus().pending, limit); assert.equal(app.source.pendingPresenceStatus().pending, 0);
      const started = performance.now();
      const health = await Promise.all(Array.from({ length: 12 }, () => request(app.origin, "/health/earnings").promise));
      assert.ok(health.every(value => value.status === 200)); assert.equal(Atomics.load(control.words, 3), 0);
      t.diagnostic(JSON.stringify({ fixture: "held-worker-allocation", distinctDevices: 1, exactRetries: true, capacityBenchmark: false,
        offeredHeartbeats: offered, coordinatorLimit: limit, healthRequests: health.length, healthElapsedMs: Math.round(performance.now() - started) }));
      control.release(); await history; const all = await Promise.all(heartbeats);
      assert.equal(all.filter(value => value.status === 503).length, 5); assert.equal(all.filter(value => value.status === 200).length, limit - 1);
      assert.equal(app.source.pendingPresenceStatus().pending, 0); assert.deepEqual(stored(f), { samples: 1, receipts: 1 });
    } finally { await app.cleanup(); }
  });
  test("a real SQLite checkpoint waiting for an old reader does not block HTTP health or lose an admitted heartbeat", { timeout: 15000 }, async t => {
    const f = await setup(t), control = fault("checkpoint"), app = build(f, control); let reader;
    try {
      await app.start(); reader = new DatabaseSync(path.join(f.directory, "shadow.sqlite"), { readOnly: true });
      reader.exec("BEGIN"); reader.prepare("SELECT count(*) AS n FROM qualifications").get();
      await app.router.ledger.qualify({ ...f.qualification, expires: f.now + 700000 });
      control.arm(); const history = app.router.ledger.getManifestEvidence(f.old); await control.entered();
      const heartbeat = request(app.origin, "/scheduler/koin/presence", f.body).promise;
      const health = await request(app.origin, "/health").promise; assert.equal(health.status, 200); assert.equal(Atomics.load(control.words, 3), 0);
      reader.exec("COMMIT"); reader.close(); reader = null; await history;
      assert.equal(Atomics.load(control.words, 4), 0); assert.equal((await heartbeat).status, 200); assert.deepEqual(stored(f), { samples: 1, receipts: 1 });
    } finally { reader?.close(); await app.cleanup(); }
  });
  test("the actual worker queue refuses overflow without dispatch and close waits for its occupied slot", { timeout: 15000 }, async t => {
    const f = await setup(t), control = fault("allocation"), client = new WorkerShadow(f.directory, { identity: f.identity, markerFile: f.markerFile, clock: () => f.now, limits: { queueLimit: 4 }, workerFactory: control.factory });
    try {
      assert.equal(control.worker, null); await client.ready; control.arm(); const first = client.getManifestEvidence(f.old); await control.entered();
      const queued = Array.from({ length: 3 }, () => client.readBudget(f.old));
      await assert.rejects(client.readBudget(f.old), error => error.code === "SHADOW_QUEUE_FULL" && error.uncertain === false);
      assert.equal(client.health().queueDepth, 4); let closed = false; const closing = client.close().then(() => { closed = true; });
      await wait(30); assert.equal(closed, false); assert.notEqual(control.worker.threadId, -1);
      control.release(); await Promise.all([first, ...queued]); await closing;
      assert.equal(client.health().state, "closed"); assert.equal(control.worker.threadId, -1);
    } finally { control.release(); await client.close().catch(() => {}); }
  });
  test("HTTP cancellation after durable commit cannot acknowledge the source before the worker reply", { timeout: 15000 }, async t => {
    const f = await setup(t), control = fault("after_commit"), app = build(f, control);
    try {
      await app.start(); control.arm(); const heartbeat = request(app.origin, "/scheduler/koin/presence", f.body), disconnected = assert.rejects(heartbeat.promise, /disconnected|hang up|reset/i);
      await control.entered(); assert.deepEqual(stored(f), { samples: 1, receipts: 1 }); assert.equal(app.source.pendingPresenceStatus().pending, 1);
      heartbeat.abort(); await disconnected; assert.equal(app.source.pendingPresenceStatus().pending, 1);
      assert.equal((await request(app.origin, "/health").promise).status, 200);
      control.release(); await until(() => app.source.pendingPresenceStatus().pending === 0);
      assert.equal((await request(app.origin, "/scheduler/koin/presence", f.body).promise).status, 200); assert.deepEqual(stored(f), { samples: 1, receipts: 1 });
    } finally { await app.cleanup(); }
  });
  test("advancing-clock runtime refresh is single-flight and a heartbeat cannot observe a partially replaced qualification set", { timeout: 15000 }, async t => {
    const f = await setup(t), control = fault("before_commit"), app = build(f, control, () => ++f.now);
    const { refreshQualifications } = require("../lib/koin-network/availability-runtime");
    try {
      await app.start();
      const replacement = { ...f.qualification, capacityId: "replacement-capacity", benchmarkHash: P.hash("replacement-benchmark") };
      app.runtime.qualifications = () => [replacement]; app.runtime.qualified = () => true;
      control.arm(); const first = refreshQualifications(app.runtime), second = refreshQualifications(app.runtime);
      assert.equal(first, second); await control.entered();
      assert.deepEqual(app.router.ledger.listQualifications().map(row => row.capacityId), ["fixture-capacity"]);
      const reader = new DatabaseSync(path.join(f.directory, "shadow.sqlite"), { readOnly: true });
      try { assert.deepEqual(reader.prepare("SELECT capacity_id FROM qualifications ORDER BY capacity_id").all().map(row => row.capacity_id), ["fixture-capacity"]); }
      finally { reader.close(); }
      const tick = app.router.ledger.tick({ maxIntervals: 1 }), heartbeat = request(app.origin, "/scheduler/koin/presence", f.body).promise;
      await until(() => app.router.ledger.storageStatus().pending >= 3);
      assert.equal(app.source.pendingPresenceStatus().pending, 0);
      assert.equal((await request(app.origin, "/health/earnings").promise).status, 200);
      control.release(); await Promise.all([first, second, tick]); assert.equal((await heartbeat).status, 200);
      assert.equal(control.methods.filter(method => method === "applyQualificationRefresh").length, 1);
      assert.equal(control.methods.filter(method => ["expireQualifications", "qualify"].includes(method)).length, 0);
      assert.deepEqual(app.router.ledger.listQualifications().map(row => row.capacityId), ["replacement-capacity"]);
      assert.equal(app.source.pendingPresenceStatus().pending, 0); assert.deepEqual(stored(f), { samples: 1, receipts: 1 });
    } finally { await app.cleanup(); }
  });
  for (const mode of ["before_commit", "after_commit", "between_commits"]) test(`actual worker death ${mode} never returns success and recovery respects the durable boundary`, { timeout: 30000 }, async t => {
    const f = await setup(t), failed = await child(f, mode);
    assert.equal(failed.status, 503); assert.equal(failed.pending, 1); assert.equal(failed.storageReady, false);
    assert.deepEqual(failed.stored, mode === "before_commit" ? { samples: 0, receipts: 0 } : { samples: 1, receipts: 1 });
    const recovered = await child({ ...f, now: f.now + 120000 }, "recover");
    if (mode === "between_commits") { assert.equal(recovered.ready, false); assert.match(recovered.failure, /generation|rollback|commit/i); assert.equal(recovered.pending, 1); }
    else { assert.equal(recovered.ready, true); assert.equal(recovered.status, 200); assert.equal(recovered.pending, 0); assert.deepEqual(recovered.stored, { samples: 1, receipts: 1 }); }
  });
  test("server startup waits for the real worker and SIGTERM waits for the active heartbeat and worker join", { timeout: 15000 }, async t => {
    const f = await setup(t), control = fault("before_commit"), app = build(f, control);
    try {
      control.arm(); const starting = app.start(); await control.entered(); assert.equal(app.server.listening, false);
      control.release(); const running = await starting; control.arm();
      const heartbeat = request(app.origin, "/scheduler/koin/presence", f.body).promise; await control.entered(); app.signals.emit("SIGTERM");
      await wait(30); assert.equal(app.closed, false); assert.deepEqual(app.exits, []); assert.notEqual(control.worker.threadId, -1);
      control.release(); assert.equal((await heartbeat).status, 200); await running.close();
      assert.equal(app.closed, true); assert.deepEqual(app.exits, [0]); assert.equal(control.worker.threadId, -1); assert.deepEqual(stored(f), { samples: 1, receipts: 1 });
    } finally { await app.cleanup(); }
  });
}
