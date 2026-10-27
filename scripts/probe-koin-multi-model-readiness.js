"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("path"), fs = require("fs");
const { fixture } = require("./helpers/koin-prepaid-fixture"), { Meter } = require("../lib/koin-network/metering");
const P = require("../lib/koin-network/job-protocol"), Q = require("../lib/koin-network/qualification-protocol");
const { ProviderQualificationSet } = require("../lib/koin-network/provider-qualification-set");
const { providerReadiness } = require("../lib/koin-network/provider-readiness"), { networkOverview } = require("../lib/koin-network/network-overview");

function setup(t) {
  const f = fixture(t), tariffs = ["alpha", "beta"].map((model, i) => ({ ...f.tariff, model, modelHash: P.hash(model), version: i + 1,
    inputAtomsPerMillion: String((i + 1) * 1000000), outputAtomsPerMillion: String((i + 1) * 4000000) }));
  const encode = s => [...Buffer.from(s)], meter = new Meter(tariffs.map(tariff => ({ tariff, adapter: { ...tariff, render: JSON.stringify, encode,
    input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } })));
  const target = { ...f.target, policyHash: meter.policyHash }, policies = tariffs.map(t => ({ schema: 1, model: t.model, modelHash: t.modelHash,
    modelWeight: "1", coverageBps: 10000, reviewedEvidenceHash: P.hash("reviewed-" + t.model), maxLatencyMs: 4000, minPass: 1, renewBeforeMs: 60000, retryMs: 60000,
    cases: [{ id: "check", messages: [{ role: "user", content: "Reply OK" }], expected: ["OK"], maxOutput: 16 }] }));
  const options = { file: path.join(f.dir, "qualification.json"), policies, target, meter, clock: () => f.ledger.clock() };
  const worker = { address: f.provider, fingerprint: "a".repeat(16), proof: "signed", capabilities: { koinQualification: 1, koinMainnetPilotJobs: 1 }, models: tariffs.map(t => t.model) };
  const body = async (job, output = "OK") => ({ jobId: job.challenge.id, output,
    signature: Buffer.from(await f.worker.signHash(Q.resultHash(job, P.hash(output)))).toString("base64") });
  return { ...f, tariffs, policies, target, meter, options, worker, body, engine: new ProviderQualificationSet(options) };
}

test("qualification selects each model's tariff, serializes challenges and retains distinct model records across restart", async t => {
  const f = setup(t), first = f.engine.next(f.worker);
  assert.equal(first.challenge.model, "alpha"); assert.equal(f.engine.next(f.worker), null);
  f.engine.result(f.worker, await f.body(first));
  f.engine = new ProviderQualificationSet(f.options);
  const second = f.engine.next(f.worker); assert.equal(second.challenge.model, "beta"); assert.equal(second.challenge.quote.tariff.version, 2);
  const body = await f.body(second); assert.throws(() => f.engine.result(f.worker, { ...body, signature: "invalid" }), /signature/i);
  f.engine.result(f.worker, body); assert.equal(f.engine.result(f.worker, body).accepted, true);
  const records = f.engine.records(); assert.equal(records.length, 2); assert.equal(new Set(records.map(r => r.capacityId)).size, 2);
  assert.ok(records.every(r => r.capacityId.endsWith(f.worker.fingerprint)));
  f.engine = new ProviderQualificationSet(f.options); assert.equal(f.engine.records().length, 2); assert.equal(f.engine.next(f.worker), null);
  assert.equal(f.ledger.jobs().length, 0); assert.equal(f.ledger.purchases(f.owner).length, 0);
});

test("a failed model does not block another model's qualification, and a device cannot qualify through a second wallet", async t => {
  const f = setup(t), first = f.engine.next(f.worker);
  assert.equal(f.engine.next({ ...f.worker, address: f.owner }), null, "pending physical device identity is exclusive");
  f.engine.result(f.worker, await f.body(first, "Wrong"));
  assert.equal(f.engine.status(f.provider, "alpha").state, "failed");
  const second = f.engine.next(f.worker); assert.equal(second.challenge.model, "beta");
  f.engine.result(f.worker, await f.body(second));
  assert.equal(f.engine.status(f.provider, "beta").state, "qualified");
  assert.equal(f.engine.records().length, 1); assert.equal(f.engine.records()[0].model, "beta");
  assert.equal(f.engine.next({ ...f.worker, address: f.owner }), null, "qualified physical identity cannot earn under another wallet");
});

test("changed deployment policy never reuses old qualification or pending signatures and leaves saved evidence intact", async t => {
  const f = setup(t), first = f.engine.next(f.worker); f.engine.result(f.worker, await f.body(first));
  const pending = f.engine.next(f.worker), response = await f.body(pending), before = JSON.stringify(f.engine.records());
  const files = [...f.engine.engines.values()].map(e => e.file), bytes = files.map(file => fs.readFileSync(file, "utf8"));
  const changed = new ProviderQualificationSet({ ...f.options, target: { ...f.target, policyHash: P.hash("changed catalog") } });
  assert.equal(changed.records().length, 0); assert.equal(changed.status(f.provider, "beta"), null);
  assert.throws(() => changed.result(f.worker, response), /expired or changed/);
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), bytes, "loading and rejecting do not rewrite original records");
  assert.equal(JSON.stringify(f.engine.records()), before);
  assert.notEqual(changed.next(f.worker).challenge.id, pending.challenge.id);
});

test("new models are checked before a failed model retry even when its retry time has elapsed", async t => {
  const f = setup(t), first = f.engine.next(f.worker);
  f.engine.result(f.worker, await f.body(first, "Wrong"));
  f.time(60001);
  f.engine = new ProviderQualificationSet(f.options);
  const second = f.engine.next(f.worker);
  assert.equal(second.challenge.model, "beta", "first-time checks cannot be starved by the earlier failed model");
  f.engine.result(f.worker, await f.body(second));
  assert.equal(f.engine.next(f.worker).challenge.model, "alpha", "a failed model still retries after all new models were attempted");
});

test("after a later model fails the provider returns to qualified selected capacity without sending a chat", async t => {
  const f = setup(t), auth = "c".repeat(64), device = "device-c", worker = { ...f.worker, providerAuthorization: auth, providerDeviceId: device,
    capabilities: { ...f.worker.capabilities, koinModelOnDemand: 1 } };
  let presence = { ...f.tariffs[0], ready: true, at: f.ledger.clock() };
  const options = { ...f.options, providerDevices: { workerActive: () => true, verify: (sig, _action, digest, wallet) => P.signatureMatches(digest, sig, wallet) }, preparePresence: () => presence };
  let engine = new ProviderQualificationSet(options);
  const alpha = engine.next(worker); engine.result(worker, await f.body(alpha));
  assert.equal(engine.next(worker), null, "newly qualified capacity gets a short serving interval before another model check");
  f.time(30000); presence.at = f.ledger.clock();
  const betaPrepare = engine.next(worker); assert.equal(betaPrepare.type, "koin-provider-prepare"); assert.equal(betaPrepare.model, "beta");
  const other = { ...worker, providerAuthorization: "d".repeat(64), providerDeviceId: "other", fingerprint: "d".repeat(16) };
  assert.equal(engine.next(other), null, "second device cannot switch to another benchmark during preparation");
  presence = { ...f.tariffs[1], ready: true, at: f.ledger.clock() };
  const beta = engine.next(worker); engine.result(worker, await f.body(beta, "Wrong"));
  const restore = engine.next(worker); assert.equal(restore.type, "koin-provider-prepare"); assert.equal(restore.model, "alpha");
  assert.equal(engine.records().length, 1, "a load request does not qualify the failed model");
  engine = new ProviderQualificationSet(options); assert.deepEqual(engine.next(worker), restore, "restarts retain the restore deadline");
  assert.equal(engine.next({ ...worker, models: ["beta"] }), null, "excluded qualified model is never restored");
  presence = { ...f.tariffs[0], ready: true, at: f.ledger.clock() };
  assert.equal(engine.next(worker), null, "qualified capacity stays resident without buyer work");
});

test("readiness counts only the currently ready model, isolates failed renewal and bounds the network observation by matching qualification expiry", async t => {
  const f = setup(t);
  f.engine.result(f.worker, await f.body(f.engine.next(f.worker), "Wrong"));
  f.engine.result(f.worker, await f.body(f.engine.next(f.worker)));
  const now = f.ledger.clock(), worker = { ...f.worker, lastSeen: now }, beta = f.tariffs[1];
  const ledger = { busy: () => false, activeJobs: () => [], jobs: () => [] };
  const qualification = { ...f.engine.records()[0], expires: now + 3000 };
  const runtime = { clock: () => f.ledger.clock(), prepaid: true, lastServing: now, qualifier: f.engine,
    config: { models: f.tariffs.map(tariff => ({ tariff })), freePolicy: { eligibleModels: ["alpha"] } }, target: f.target,
    qualifications: () => [qualification], qualified: (_a, model) => model === "beta" && qualification.expires > f.ledger.clock(),
    scheduler: { workers: new Map([["worker", worker], ["duplicate", { ...worker, lastSeen: now - 1000 }]]),
      koinPrepaid: { ledger }, koinShadow: { ledger: { state: { presence: { [f.provider]: { ...beta, ready: true, at: now } } } } } } };
  const ready = providerReadiness(runtime, f.provider); assert.equal(ready.state, "online"); assert.deepEqual(ready.readyModels, ["beta"]);
  assert.equal(ready.models.find(m => m.model === "alpha").state, "qualification-failed"); assert.equal(ready.validUntil, now + 3000);
  const network = networkOverview(runtime); assert.equal(network.readyProviders, 1); assert.equal(network.models.length, 2);
  assert.equal(network.models.find(m => m.id === "alpha").providers, 0); assert.equal(network.models.find(m => m.id === "beta").providers, 1);
  assert.equal(network.models.find(m => m.id === "beta").inputAtomsPerMillion, beta.inputAtomsPerMillion);
  assert.equal(network.models.find(m => m.id === "alpha").freeEligible, true); assert.equal(network.models.find(m => m.id === "beta").freeEligible, false);
  assert.ok(!JSON.stringify(network).includes(f.provider));
  f.time(3001); assert.equal(providerReadiness(runtime, f.provider).state, "qualification-expired");
  assert.equal(networkOverview(runtime).readyProviders, 0);
});
