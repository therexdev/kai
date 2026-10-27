"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http");
const { Signer } = require("koilib"), { fixture } = require("./helpers/koin-prepaid-fixture");
const { ProviderDevices } = require("../lib/koin-network/provider-devices"), D = require("../lib/koin-network/provider-device-protocol"), P = require("../lib/koin-network/job-protocol");
const schedulerUrl = "https://credits.example.com/scheduler";
function setup(t) {
  const f = fixture(t), directory = f.dir + "-devices";
  const options = { directory, schedulerUrl, target: f.target, deployment: { chainId: f.target.chainId }, clock: () => f.ledger.clock() };
  let devices = new ProviderDevices(options); f.ledger.providerDevices = devices;
  t.after(() => { devices.close(); fs.rmSync(directory, { recursive: true, force: true }); for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(directory + ".recovery-anchor.sqlite" + suffix, { force: true }); });
  const enroll = async (label = "device1", wallet = f.worker) => {
    const keys = crypto.generateKeyPairSync("ed25519"), deviceId = P.hash(label), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const { authorization } = devices.challenge({ wallet: wallet.getAddress(), deviceId, publicKey });
    const walletSignature = Buffer.from(await wallet.signHash(D.authorizationHash(authorization))).toString("base64");
    const sign = (action, digest, at = f.ledger.clock()) => D.encodeAction(authorization, walletSignature, keys.privateKey, action, digest, at);
    const body = D.decodeAction(sign("register", D.authorizationHash(authorization)));
    const approved = devices.enroll(body);
    return { ...approved, authorization, walletSignature, sign, body, keys, binding: { providerAuthorization: approved.authorizationId, providerDeviceId: approved.deviceId } };
  };
  return { ...f, options, enroll, get devices() { return devices; }, restartDevices() { devices.close(); devices = new ProviderDevices(options); f.ledger.providerDevices = devices; } };
}
test("wallet-only provider enrollment binds deployment, requires both keys, recovers exact response and persists replay/expiry/revocation", async t => {
  const f = setup(t), d = await f.enroll();
  assert.equal(f.devices.active(d.authorizationId, f.provider, d.deviceId), true);
  assert.deepEqual(f.devices.enroll(d.body), { ok: true, authorizationId: d.authorizationId, deviceId: d.deviceId, wallet: f.provider, expiresAt: d.expiresAt });
  assert.throws(() => f.devices.enroll({ ...d.body, authorization: { ...d.authorization, wallet: f.owner } }), /signature|mismatch/i);
  assert.throws(() => f.devices.enroll({ ...d.body, authorization: { ...d.authorization, schedulerUrl: "https://wrong.example/scheduler" } }), /deployment|signature/i);
  assert.throws(() => f.devices.enroll({ ...d.body, authorization: { ...d.authorization, target: { ...f.target, policyHash: P.hash("wrong") } } }), /deployment|signature/i);
  assert.throws(() => f.devices.enroll({ ...d.body, signature: Buffer.alloc(64).toString("base64") }), /signature/);
  const forged = structuredClone(d.body); forged.authorization.challenge = P.hash("unknown-challenge");
  forged.walletSignature = Buffer.from(await f.worker.signHash(D.authorizationHash(forged.authorization))).toString("base64");
  forged.signature = crypto.sign(null, D.actionHash(forged.authorization, "register", D.authorizationHash(forged.authorization), forged.at), d.keys.privateKey).toString("base64");
  assert.throws(() => f.devices.enroll(forged), /challenge/);
  f.restartDevices(); assert.equal(f.devices.active(d.authorizationId, f.provider, d.deviceId), true);
  const status = d.sign("status", D.hash("status:" + d.authorizationId));
  assert.equal(f.devices.verify(status, "status", D.hash("status:" + d.authorizationId)).wallet, f.provider);
  f.devices.revoke(d.sign("revoke", D.hash("revoke:" + d.authorizationId)));
  f.restartDevices(); assert.equal(f.devices.active(d.authorizationId), false);
  assert.throws(() => f.devices.verify(status, "status", D.hash("status:" + d.authorizationId)), /revoked/);
  assert.throws(() => f.devices.enroll(d.body), /revoked/);
});
test("provider credentials cannot authorize purchases, transfers, grants, changed owners or changed action bytes", async t => {
  const f = setup(t), d = await f.enroll(), digest = D.hash("assigned-result");
  const proof = d.sign("result", digest);
  for (const action of ["purchase", "transfer", "grant", "linkWallet", "withdraw", "contract_call"]) assert.throws(() => d.sign(action, digest), /outside/);
  assert.throws(() => f.devices.verify(proof, "chunk", digest, f.provider), /signature/);
  assert.throws(() => f.devices.verify(proof, "result", D.hash("other-job"), f.provider), /signature/);
  assert.throws(() => f.devices.verify(proof, "result", digest, f.owner), /wallet changed/);
  f.time(60001); assert.throws(() => f.devices.verify(proof, "result", digest, f.provider), /expired/);
  f.time(2592000000); assert.equal(f.devices.active(d.authorizationId), false);
});
test("two devices remain distinct, registration replay survives restart, and revoking one does not revoke the other", async t => {
  const f = setup(t), a = await f.enroll("one"), b = await f.enroll("two");
  const registration = { address: f.provider, ts: f.ledger.clock(), fingerprint: "a".repeat(16), models: ["koinos-smart"], capabilities: { koinQualification: 1, koinPrepaidMainnet: 1 } };
  registration.signature = a.sign("register", D.registrationHash(registration));
  assert.deepEqual(f.devices.register(registration), a.binding);
  assert.throws(() => f.devices.register({ ...registration, models: ["another-model"] }), /signature/);
  f.restartDevices(); assert.throws(() => f.devices.register(registration), /already used/);
  assert.equal(f.devices.active(b.authorizationId), true);
  f.devices.revoke(a.sign("revoke", D.hash("revoke:" + a.authorizationId)));
  assert.equal(f.devices.active(a.authorizationId), false); assert.equal(f.devices.active(b.authorizationId), true);
  const other = b.sign("result", D.hash("assigned"));
  assert.throws(() => f.devices.verify(other, "result", D.hash("assigned"), f.provider, a.binding), /assigned device/);
});
test("assigned prepaid replies use the non-spending device while wallet signing is unavailable and cannot be stolen by a second device", async t => {
  const f = setup(t), a = await f.enroll("one"), b = await f.enroll("two"); f.purchase();
  f.worker.signHash = () => { throw Error("wallet locked"); };
  const req = { ...f.request("delegated-reply"), providerDeviceProof: 1 }; f.ledger.reserve(req);
  const job = f.ledger.dispatch(req.id, f.provider, a.binding), output = "Device reply";
  const digest = require("../lib/koin-network/funded-protocol").fundedResultHash(f.target, job, output);
  assert.throws(() => f.ledger.complete(req.id, { output, signature: b.sign("result", digest) }, true), /assigned device/);
  const signature = a.sign("result", digest), finished = f.ledger.complete(req.id, { output, signature }, true);
  assert.equal(finished.provider, f.provider); assert.equal(finished.receipt.signature, signature);
  assert.equal(D.verifyAction(signature, "result", digest, { wallet: f.provider, target: f.target, schedulerUrl, historical: true, now: f.ledger.clock(), completedAt: finished.receipt.completedAt }).deviceId, a.deviceId);
  assert.equal(f.ledger.acknowledge(req.id, f.owner, finished.receiptHash).state, "charged");
  const before = f.ledger.balance(f.owner); assert.equal(f.ledger.complete(req.id, { output, signature }, true).receiptHash, finished.receiptHash); assert.deepEqual(f.ledger.balance(f.owner), before);
});
test("revoked device results cannot debit a held request and scoped worker tokens cannot call legacy or payment routes", async t => {
  const f = setup(t), d = await f.enroll(); f.purchase(); const req = { ...f.request("revoked-result"), providerDeviceProof: 1 }; f.ledger.reserve(req);
  const job = f.ledger.dispatch(req.id, f.provider, d.binding), output = "ignored";
  const signature = d.sign("result", require("../lib/koin-network/funded-protocol").fundedResultHash(f.target, job, output));
  const Scheduler = require("../lib/scheduler").Scheduler, worker = { address: f.provider, ...d.binding };
  const scheduler = Object.assign(Object.create(Scheduler.prototype), { providerDevices: f.devices, workers: new Map([["token", worker]]), koinPrepaid: { ledger: f.ledger } });
  for (const route of ["/worker/producer", "/worker/result", "/worker/chunk", "/consume/chat/completions", "/koin/prepaid/purchase", "/deposit/submit"]) assert.equal(scheduler._auth({ url: route + "?token=token" }), null);
  assert.equal(scheduler._auth({ url: "/worker/heartbeat?token=token" }), worker);
  f.devices.revoke(d.sign("revoke", D.hash("revoke:" + d.authorizationId)));
  assert.equal(scheduler._auth({ url: "/worker/heartbeat?token=token" }), null);
  assert.throws(() => f.ledger.complete(req.id, { output, signature }, true), /revoked/);
  assert.equal(f.ledger.job(req.id).state, "running"); assert.equal(f.ledger.balance(f.owner).spent, "0");
});
test("real public bootstrap HTTP routes require explicit signed enrollment and reject oversized or unsupported actions", async t => {
  const f = setup(t); const server = http.createServer((req, res) => f.devices.handle(req, res));
  await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}/koin/provider/device/`;
  const capabilities = await (await fetch(base + "capabilities")).json(); assert.equal(capabilities.capabilities.delegatedProvider, 1);
  assert.equal(f.devices.db.prepare("SELECT count(*) AS n FROM authorizations").get().n, 0);
  const response = await fetch(base + "enroll", { method: "POST", body: "{}" }); assert.equal(response.status, 400);
  const unknown = await fetch(base + "transfer", { method: "POST", body: "{}" }); assert.equal(unknown.status, 404);
  const huge = await fetch(base + "challenge", { method: "POST", body: JSON.stringify({ bad: "x".repeat(17000) }) }); assert.equal(huge.status, 400);
});
test("fresh delegated qualification archives verify independently and reject a different device or revoked authority", async t => {
  const f = setup(t), a = await f.enroll("qualifier-one"), b = await f.enroll("qualifier-two");
  const Q = require("../lib/koin-network/qualification-protocol"), { ProviderQualification } = require("../lib/koin-network/provider-qualification");
  const policy = { schema: 1, model: "fixture", modelHash: f.tariff.modelHash, modelWeight: "1", coverageBps: 10000,
    reviewedEvidenceHash: P.hash("reviewed-fixture"), maxLatencyMs: 4000, minPass: 1, renewBeforeMs: 60000, retryMs: 60000,
    cases: [{ id: "simple", messages: [{ role: "user", content: "Reply OK." }], expected: ["OK"], maxOutput: 16 }] };
  const engine = new ProviderQualification({ file: path.join(f.dir, "device-qualification.json"), policy, target: f.target, meter: f.meter, clock: () => f.ledger.clock(), providerDevices: f.devices });
  const worker = { address: f.provider, fingerprint: "d".repeat(16), proof: "signed", capabilities: { koinQualification: 1 }, models: ["fixture"], ...a.binding };
  const job = engine.next(worker), digest = Q.resultHash(job, P.hash("OK"));
  assert.throws(() => engine.result({ ...worker, ...b.binding }, { jobId: job.challenge.id, output: "OK", signature: b.sign("qualification", digest) }), /another authorized device/);
  const signature = a.sign("qualification", digest); assert.equal(engine.result(worker, { jobId: job.challenge.id, output: "OK", signature }).qualification.state, "qualified");
  const [record] = engine.records(); assert.equal(record.providerAuthorization, a.authorizationId);
  const result = engine.state.runs[f.provider].results[0];
  assert.deepEqual(require("../lib/koin-network/qualification-evidence").verifyResult(result, { target: f.target, policyHash: engine.policyHash, address: f.provider, schedulerUrl, now: f.ledger.clock() }), { state: "signature-verified", qualityReplayed: false });
  f.devices.revoke(a.sign("revoke", D.hash("revoke:" + a.authorizationId)));
  assert.equal(engine.next(worker), null); assert.throws(() => engine.result(worker, { jobId: job.challenge.id, output: "OK", signature }), /another authorized device/);
});
test("delegated streaming chunks preserve cumulative metering and cannot change the assigned device", async t => {
  const f = setup(t), a = await f.enroll("stream-one"), b = await f.enroll("stream-two"); f.purchase();
  const req = { ...f.request("device-stream"), stream: true, providerDeviceProof: 1 }; f.ledger.reserve(req);
  const job = f.ledger.dispatch(req.id, f.provider, a.binding), F = require("../lib/koin-network/funded-protocol");
  const output = "first", digest = F.fundedChunkHash(f.target, job, output, 1), signature = a.sign("chunk", digest);
  assert.throws(() => f.ledger.streamChunk(req.id, { output, sequence: 1, signature: b.sign("chunk", digest) }, true), /assigned device/);
  const partial = f.ledger.streamChunk(req.id, { output, sequence: 1, signature }, true);
  assert.equal(partial.delivered.sequence, 1);
  assert.equal(f.ledger.streamChunk(req.id, { output, sequence: 1, signature }, true).receiptHash, partial.receiptHash);
  const final = "first complete", result = a.sign("result", F.fundedResultHash(f.target, job, final));
  const complete = f.ledger.complete(req.id, { output: final, signature: result }, true); assert.equal(complete.state, "charged");
  assert.equal(complete.receipt.provider, f.provider); assert.equal(complete.receipt.signature, result);
});
test("HTTP revocation gives a specific reauthorization state, preserves another device, and expired pending challenges can recover safely", async t => {
  const f = setup(t), a = await f.enroll("stable-device"), b = await f.enroll("other-device");
  const server = http.createServer((req, res) => f.devices.handle(req, res));
  await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const post = (action, body) => fetch(`http://127.0.0.1:${server.address().port}/koin/provider/device/${action}`, { method: "POST", body: JSON.stringify(body) });
  let response = await post("revoke", { signature: a.sign("revoke", D.hash("revoke:" + a.authorizationId)) }); assert.equal(response.status, 200);
  response = await post("status", { signature: a.sign("status", D.hash("status:" + a.authorizationId)) }); assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "PROVIDER_AUTHORIZATION_REQUIRED");
  const replaced = await f.enroll("stable-device"); assert.equal(replaced.deviceId, a.deviceId); assert.notEqual(replaced.authorizationId, a.authorizationId);
  response = await post("status", { signature: replaced.sign("status", D.hash("status:" + replaced.authorizationId)) }); assert.equal(response.status, 200);
  assert.equal(f.devices.active(b.authorizationId), true); assert.equal(f.devices.active(a.authorizationId), false);
  const keys = crypto.generateKeyPairSync("ed25519"), pending = f.devices.challenge({ wallet: f.provider, deviceId: P.hash("pending"), publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }).authorization;
  const walletSignature = Buffer.from(await f.worker.signHash(D.authorizationHash(pending))).toString("base64"); f.time(300001);
  const proof = D.decodeAction(D.encodeAction(pending, walletSignature, keys.privateKey, "register", D.authorizationHash(pending), f.ledger.clock()));
  response = await post("enroll", proof); assert.equal(response.status, 409); assert.equal((await response.json()).code, "PROVIDER_CHALLENGE_EXPIRED");
  const recovered = D.decodeAction(replaced.sign("register", D.authorizationHash(replaced.authorization)));
  response = await post("enroll", recovered); assert.equal(response.status, 200, "already committed authorization recovers after its challenge expired");
});
test("distinct authorized devices cannot borrow presence or multiply the wallet's effective reward capacity", async t => {
  const f = setup(t), a = await f.enroll("presence-a"), b = await f.enroll("presence-b"), Q = require("../lib/koin-network/qualification-protocol");
  const { ProviderQualification } = require("../lib/koin-network/provider-qualification");
  const policy = { schema: 1, model: "fixture", modelHash: f.tariff.modelHash, modelWeight: "1", coverageBps: 10000, reviewedEvidenceHash: P.hash("reviewed"), maxLatencyMs: 4000,
    minPass: 1, renewBeforeMs: 60000, retryMs: 60000, cases: [{ id: "one", messages: [{ role: "user", content: "OK" }], expected: ["OK"], maxOutput: 16 }] };
  const engine = new ProviderQualification({ file: path.join(f.dir, "two-device-qualification.json"), policy, target: f.target, meter: f.meter, clock: () => f.ledger.clock(), providerDevices: f.devices });
  const makeWorker = (d, n) => ({ address: f.provider, fingerprint: n.repeat(16), proof: "signed", capabilities: { koinQualification: 1, [require("../lib/koin-network/payment-network").protocol(f.target).capability]: 1 }, models: ["fixture"], lastSeen: f.ledger.clock(), ...d.binding });
  const wa = makeWorker(a, "a"), wb = makeWorker(b, "b");
  for (const [device, worker] of [[a, wa], [b, wb]]) {
    const job = engine.next(worker); assert.ok(job); engine.result(worker, { jobId: job.challenge.id, output: "OK", signature: device.sign("qualification", Q.resultHash(job, P.hash("OK"))) });
  }
  assert.equal(engine.records().length, 2); assert.equal(new Set(engine.records().map(q => q.capacityId)).size, 1, "new device IDs do not create reward slots");
  const report = { schema: 1, session: "f".repeat(32), sequence: 1, at: f.ledger.clock(), model: "fixture", modelHash: f.tariff.modelHash, ready: true };
  f.devices.observePresence(a.sign("presence", require("../lib/koin-network/presence").presenceHash(f.provider, schedulerUrl, report)), f.provider, report);
  assert.equal(f.devices.presence(wa).ready, true); assert.equal(f.devices.presence(wb), null);
  const shadow = { state: { qualifications: {}, presence: {} }, save() {}, qualify(q) { this.state.qualifications[q.capacityId] = q; } };
  const Runtime = require("../lib/koin-network/test-runtime").TestRuntime;
  const runtime = Object.assign(Object.create(Runtime.prototype), { clock: () => f.ledger.clock(), qualifier: engine, reviewedQualifications: () => [], providerDevices: f.devices, config: { tariff: f.tariff },
    scheduler: { workers: new Map([["a", wa], ["b", wb]]), koinShadow: { ledger: shadow } }, target: f.target, cycle: { days: () => [] }, prepaid: true, lastServing: f.ledger.clock() });
  assert.equal(require("../lib/koin-network/provider-readiness").providerReadiness(runtime, f.provider, undefined, a.deviceId).state, "online");
  assert.equal(require("../lib/koin-network/provider-readiness").providerReadiness(runtime, f.provider, undefined, b.deviceId).state, "preparing");
  await runtime.collectRewards(); assert.equal(Object.keys(shadow.state.qualifications).length, 1);
  f.devices.observePresence(b.sign("presence", require("../lib/koin-network/presence").presenceHash(f.provider, schedulerUrl, report)), f.provider, report);
  await runtime.collectRewards(); assert.equal(Object.values(shadow.state.qualifications)[0].providerAuthorization, a.authorizationId, "a second live device does not reset the active capacity's evidence every poll");
  f.devices.revoke(a.sign("revoke", D.hash("revoke:" + a.authorizationId)));
  assert.equal(require("../lib/koin-network/provider-readiness").providerReadiness(runtime, f.provider, undefined, b.deviceId).state, "online");
  await runtime.collectRewards(); assert.equal(Object.keys(shadow.state.qualifications).length, 1); assert.equal(Object.values(shadow.state.qualifications)[0].providerAuthorization, b.authorizationId);
  f.restartDevices(); assert.equal(f.devices.presence(wb).ready, true); assert.equal(f.devices.presence(wa), null);
});
test("authenticated preparation presence is acknowledged before reward qualification and cannot manufacture reward capacity", async t => {
  const f = setup(t), d = await f.enroll(), router = require("../lib/koin-network/shadow-router").createShadowRouter({
    dataDir: path.join(f.dir, "preparation-shadow"), operatorSecret: "fixture-only", audience: schedulerUrl, clock: () => f.ledger.clock(), providerDevices: f.devices });
  const server = http.createServer((req, res) => router.handle(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const report = { schema: 1, session: "e".repeat(32), sequence: 1, at: f.ledger.clock(), model: "fixture", modelHash: f.tariff.modelHash, ready: true };
  const signature = d.sign("presence", require("../lib/koin-network/presence").presenceHash(f.provider, schedulerUrl, report));
  const send = value => fetch(`http://127.0.0.1:${server.address().port}/koin/presence`, { method: "POST", body: JSON.stringify(value) });
  const response = await send({ address: f.provider, report, signature }); assert.equal(response.status, 200);
  assert.equal(f.devices.presence({ address: f.provider, ...d.binding }).ready, true);
  assert.deepEqual(router.ledger.state.qualifications, {}); assert.equal(router.ledger.state.presence[f.provider], undefined);
  assert.equal((await send({ address: f.provider, report, signature })).status, 400, "replayed device presence is still rejected");
  assert.equal((await send({ address: f.provider, report: { ...report, modelHash: P.hash("wrong") }, signature })).status, 400);
});
