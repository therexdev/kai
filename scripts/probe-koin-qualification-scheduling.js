"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), http = require("node:http");
const { fixture } = require("./helpers/koin-prepaid-fixture"), { Meter } = require("../lib/koin-network/metering");
const P = require("../lib/koin-network/job-protocol"), Q = require("../lib/koin-network/qualification-protocol");
const { ProviderQualificationSet } = require("../lib/koin-network/provider-qualification-set");
const { Scheduler } = require("../lib/scheduler");

function setup(t, names = ["smart", "alpha", "beta"]) {
  const f = fixture(t), tariffs = names.map(model => ({ ...f.tariff, model, modelHash: P.hash(model), maxLatencyMs: 30000 }));
  const encode = value => [...Buffer.from(value)], meter = new Meter(tariffs.map(tariff => ({ tariff, adapter: { ...tariff,
    render: JSON.stringify, encode, input: m => encode(JSON.stringify(m)).length, output: value => encode(value).length } })));
  const policies = tariffs.map(tariff => ({ schema: 1, model: tariff.model, modelHash: tariff.modelHash, modelWeight: "1", coverageBps: 10000,
    reviewedEvidenceHash: P.hash("review-" + tariff.model), maxLatencyMs: 30000, minPass: 12, renewBeforeMs: 3600000, retryMs: 300000,
    cases: Array.from({ length: 12 }, (_, i) => ({ id: "case-" + i, messages: [{ role: "user", content: "Reply exactly OK." }], expected: ["OK"], maxOutput: 16 })) }));
  const worker = { address: f.provider, fingerprint: "a".repeat(16), proof: "signed", providerAuthorization: "b".repeat(64), providerDeviceId: "fixture-device",
    models: names, capabilities: { koinQualification: 1, koinModelOnDemand: 1, preferredModel: names[0] } };
  let active = true, presence = { ...tariffs[0], ready: true, at: f.ledger.clock() };
  const options = { file: path.join(f.dir, "qualification.json"), policies, meter, target: { ...f.target, policyHash: meter.policyHash },
    clock: () => f.ledger.clock(), providerDevices: { workerActive: () => active,
      verify: (signature, _action, digest, address) => P.signatureMatches(digest, signature, address) }, preparePresence: () => presence };
  let engine = new ProviderQualificationSet(options);
  const next = () => { if (presence) presence.at = f.ledger.clock(); return engine.next(worker); };
  const load = model => presence = { ...tariffs.find(t => t.model === model), ready: true, at: f.ledger.clock() };
  const answer = async (job, output = "OK", ms = 0) => {
    f.time(ms);
    const body = { jobId: job.challenge.id, output, signature: Buffer.from(await f.worker.signHash(Q.resultHash(job, P.hash(output)))).toString("base64") };
    return engine.result(worker, body);
  };
  const check = model => {
    let job = next();
    if (job?.type === "koin-provider-prepare") { assert.equal(job.model, model); load(model); job = next(); }
    assert.equal(job?.type, "koin-provider-qualification"); assert.equal(job.challenge.model, model); return job;
  };
  const finish = async (model, output = "OK", ms = 0) => {
    for (let i = 0; i < 12; i++) await answer(check(model), typeof output === "function" ? output(i) : output, ms);
  };
  return { ...f, worker, policies, tariffs, next, load, answer, check, finish,
    get engine() { return engine; }, restart() { engine = new ProviderQualificationSet(options); },
    get presence() { return presence; }, set presence(value) { presence = value; }, set active(value) { active = value; } };
}

test("long failed model rounds retain qualified serving gaps, fair retries and immutable evidence across restart", async t => {
  const f = setup(t); await f.finish("smart");
  const original = JSON.stringify(f.engine.records());
  assert.equal(f.engine.recoveryVersion, 1); assert.equal(f.next(), null, "initial qualified capacity can serve before checking more models");
  f.time(30000); await f.finish("alpha", "Wrong", 29000);
  const restore = f.next(); assert.equal(restore.type, "koin-provider-prepare"); assert.equal(restore.model, "smart");
  f.load("smart"); assert.equal(f.next(), null);
  f.time(29999); assert.equal(f.next(), null); f.time(1);
  await f.finish("beta", "Wrong", 29000);
  assert.equal(f.engine.status(f.provider, "alpha").retryAt < f.ledger.clock(), true, "old per-model backoff has already elapsed");
  const effective = f.engine.status(f.provider, "alpha", f.worker);
  assert.equal(effective.retryAt, f.engine.status(f.provider, "beta").retryAt);
  assert.equal(f.next().model, "smart", "an elapsed early retry cannot displace the qualified model indefinitely");
  f.load("smart"); f.restart(); assert.equal(f.next(), null, "serving interval survives restart without a new schedule journal");
  f.time(299999); assert.equal(f.next(), null); f.time(1);
  await f.finish("alpha", "Wrong");
  assert.equal(f.next().model, "smart"); f.load("smart");
  f.worker.capabilities.preferredModel = "alpha";
  f.time(300000); assert.equal(f.check("beta").challenge.model, "beta", "oldest failed attempt wins over preferred/alphabetical retries");
  assert.equal(JSON.stringify(f.engine.records()), original, "scheduling never extends qualification or changes signed evidence");
  assert.equal(f.ledger.jobs().length, 0); assert.equal(f.ledger.purchases(f.owner).length, 0);
});

test("serving gaps cannot borrow another wallet, device, fingerprint, revoked authority or unselected model", async t => {
  const f = setup(t); await f.finish("smart");
  assert.equal(f.engine.qualifiedEngines(f.worker).length, 1);
  for (const changed of [{ address: f.owner }, { providerAuthorization: "c".repeat(64) }, { providerDeviceId: "another-device" },
    { fingerprint: "d".repeat(16) }, { proof: "unsigned" }, { models: ["alpha", "beta"] }]) {
    const worker = { ...f.worker, ...changed };
    assert.equal(f.engine.qualifiedEngines(worker).length, 0);
    assert.deepEqual(f.engine.servingBounds(worker), { retryAt: 0, serveUntil: 0 });
    assert.equal(f.engine.restoreQualifiedModel(worker, [...f.engine.engines.values()]), null);
  }
  f.active = false; assert.equal(f.engine.qualifiedEngines(f.worker).length, 0);
  assert.equal(f.engine.next(f.worker), null);
  f.active = true; f.time(86400000); assert.equal(f.engine.qualifiedEngines(f.worker).length, 0, "expired evidence never creates a serving interval");
});

test("same-poll preparation or final-answer expiry restores qualified capacity before starting another model", async t => {
  for (const expiry of ["preparation", "answer"]) {
    const f = setup(t); await f.finish("smart"); f.time(30000);
    if (expiry === "preparation") {
      assert.equal(f.next().model, "alpha"); f.presence = null; f.time(120000);
    } else {
      for (let i = 0; i < 11; i++) await f.answer(f.check("alpha"), "Wrong");
      f.check("alpha"); f.time(30000);
    }
    const next = f.next();
    assert.equal(next?.type, "koin-provider-prepare"); assert.equal(next.model, "smart", expiry);
    assert.equal(f.engine.status(f.provider, "alpha").state, "failed");
    assert.equal(f.engine.status(f.provider, "beta"), null, "the following model is not started using stale serving bounds");
    f.load("smart"); assert.equal(f.next(), null);
    f.time(30000); assert.equal(f.next().model, "beta", "initial models still progress after the short serving interval");
  }
});

test("a cold qualified-model reload earns its serving interval after accepted readiness and keeps that interval across restart", async t => {
  const f = setup(t); await f.finish("smart"); f.time(30000); await f.finish("alpha", "Wrong");
  const restore = f.next(); assert.equal(restore.model, "smart");
  f.time(60000); f.load("smart"); f.restart();
  assert.equal(f.next(), null, "loading longer than thirty seconds does not consume all qualified serving time");
  const record = f.engine.engines.get("smart").state.restores[f.worker.providerAuthorization];
  assert.equal(record.issuedAt, restore.issuedAt); assert.equal(record.expiresAt, restore.expiresAt);
  const readyAt = record.readyAt;
  f.time(15000); f.restart(); assert.equal(f.next(), null);
  assert.equal(f.engine.engines.get("smart").state.restores[f.worker.providerAuthorization].readyAt, readyAt, "fresh polls cannot extend the accepted ready observation");
  f.time(14999); assert.equal(f.next(), null); f.time(1);
  assert.equal(f.next().model, "beta", "the serving interval is finite");
});

test("qualification status exposes bounded actual quality/deadline counts and honest legacy causes without answers or signatures", async t => {
  const f = setup(t, ["smart"]);
  await f.finish("smart", i => i < 10 ? "OK" : "PRIVATE-WRONG");
  const status = f.engine.status(f.provider, "smart", f.worker);
  assert.equal(status.passed, 10); assert.equal(status.completed, 12); assert.equal(status.required, 12); assert.equal(status.total, 12);
  assert.deepEqual(status.failure, { code: "quality", wrongAnswers: 2, deadlines: 0, unknown: 0 });
  assert.equal(/PRIVATE|signature|outputHash|prompt/.test(JSON.stringify(status)), false);
  const e = f.engine.engines.get("smart"), run = e.state.runs[f.provider];
  run.results[10] = { ...run.results[10], reason: "deadline" };
  assert.deepEqual(e.status(f.provider).failure, { code: "quality_and_deadline", wrongAnswers: 1, deadlines: 1, unknown: 0 });
  run.results[11] = { passed: false, at: f.ledger.clock() };
  assert.deepEqual(e.status(f.provider).failure, { code: "unknown", wrongAnswers: 0, deadlines: 1, unknown: 1 });
  run.results = [];
  assert.deepEqual(e.status(f.provider).failure, { code: "unknown", wrongAnswers: 0, deadlines: 0, unknown: 0 });
  assert.equal(f.engine.records().length, 0);
});

test("preparation expiry identifies a load timeout even after partial answers and never fabricates a legacy reason", async t => {
  const f = setup(t, ["smart"]);
  await f.answer(f.check("smart")); await f.answer(f.check("smart"));
  f.presence = null;
  const prepare = f.next(); assert.equal(prepare.type, "koin-provider-prepare");
  assert.equal(f.engine.status(f.provider, "smart").phase, "preparing"); assert.equal(f.engine.assigned(f.provider), true);
  f.time(120000); assert.equal(f.engine.assigned(f.provider), false); assert.equal(f.next(), null);
  const status = f.engine.status(f.provider, "smart");
  assert.equal(status.completed, 2); assert.equal(status.passed, 2);
  assert.deepEqual(status.failure, { code: "preparation_timeout", wrongAnswers: 0, deadlines: 0, unknown: 0 });
  f.restart(); assert.deepEqual(f.engine.status(f.provider, "smart"), status);
  const e = f.engine.engines.get("smart"); delete e.state.runs[f.provider].failureCode; e.save(); f.restart();
  assert.equal(f.engine.status(f.provider, "smart").failure.code, "unknown"); assert.equal(f.engine.records().length, 0);
});

test("real scheduler gives qualified paid work priority between answers without interrupting signed challenges or preparation", async t => {
  const f = setup(t); await f.finish("smart"); f.time(30000);
  let paid = true, fundedCalls = 0;
  const fundedJob = { type: "fixture-paid", model: "smart", id: P.hash("paid") };
  const scheduler = Object.assign(Object.create(Scheduler.prototype), { providerQualification: f.engine,
    _rehearsalPolls: new Set(), pending: new Map(), workers: new Map(), queue: [],
    koinPrepaid: { handle: async () => false, work: { busy: () => false, next: async (worker, guard) => {
      fundedCalls++; if (paid && guard() && f.engine.qualifiedEngines(worker).some(e => e.policy.model === "smart")) { paid = false; return fundedJob; } return null;
    } } }, _auth: req => new URL(req.url, "http://fixture").searchParams.get("token") === "signed-fixture" ? f.worker : null });
  const server = http.createServer((req, res) => scheduler.handle(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/worker/next-job?token=`;
  assert.equal((await fetch(base + "wrong")).status, 401);
  assert.deepEqual((await (await fetch(base + "signed-fixture")).json()).job, fundedJob, "queued paid Smart is served before the next initial model check");
  assert.equal(f.engine.status(f.provider, "alpha"), null);
  const challenge = f.check("alpha"); paid = true; const callsBefore = fundedCalls;
  assert.equal((await fetch(base + "signed-fixture")).status, 204);
  assert.equal(fundedCalls, callsBefore, "an issued signed challenge is not preempted");
  await f.answer(challenge, "Wrong"); assert.equal(f.engine.assigned(f.provider), false);
  assert.deepEqual((await (await fetch(base + "signed-fixture")).json()).job, fundedJob, "paid work can run between benchmark answers");
  assert.equal(f.engine.status(f.provider, "alpha").completed, 1);
  f.load("smart");
  const preparation = f.next(); assert.equal(preparation.type, "koin-provider-prepare"); paid = true;
  const beforePreparationPoll = fundedCalls;
  assert.deepEqual((await (await fetch(base + "signed-fixture")).json()).job, preparation);
  assert.equal(fundedCalls, beforePreparationPoll, "model preparation retains its original deadline and assignment");
  f.load("alpha"); const second = f.next(); f.time(30000);
  await assert.rejects(f.answer(second), /expired/);
  assert.deepEqual((await (await fetch(base + "signed-fixture")).json()).job, fundedJob, "an expired challenge cannot hold paid capacity indefinitely");
  assert.equal(f.engine.records().length, 1); assert.equal(f.engine.records()[0].model, "smart");
});
