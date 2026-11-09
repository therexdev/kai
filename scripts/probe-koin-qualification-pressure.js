"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { fixture } = require("./helpers/koin-prepaid-fixture");
const { Meter } = require("../lib/koin-network/metering");
const { ProviderQualificationSet } = require("../lib/koin-network/provider-qualification-set");
const P = require("../lib/koin-network/job-protocol");
const { DAY } = require("../lib/koin-network/policy");

function setup(t, count = 16, recordsPerModel = 32) {
  const f = fixture(t), names = Array.from({ length: count }, (_, i) => "model-" + i);
  const tariffs = names.map(model => ({ ...f.tariff, model, modelHash: P.hash(model) }));
  const encode = value => [...Buffer.from(value)];
  const meter = new Meter(tariffs.map(tariff => ({ tariff, adapter: { ...tariff,
    render: JSON.stringify, encode, input: m => encode(JSON.stringify(m)).length, output: value => encode(value).length } })));
  const policies = tariffs.map(tariff => ({ schema: 1, model: tariff.model, modelHash: tariff.modelHash,
    modelWeight: "1", coverageBps: 10000, reviewedEvidenceHash: P.hash("review-" + tariff.model),
    maxLatencyMs: 5000, minPass: 1, renewBeforeMs: 3600000, retryMs: 300000,
    cases: [{ id: "answer", messages: [{ role: "user", content: "Reply exactly OK." }], expected: ["OK"], maxOutput: 16 }] }));
  const worker = { address: f.provider, fingerprint: "a".repeat(16), proof: "signed",
    providerAuthorization: "b".repeat(64), providerDeviceId: "fixture-device", models: names,
    capabilities: { koinQualification: 1, koinModelOnDemand: 1, preferredModel: names[0] } };
  let active = true, reviewed = [], reviewedCalls = 0;
  const set = new ProviderQualificationSet({ file: path.join(f.dir, "qualification.json"), policies, meter,
    target: { ...f.target, policyHash: meter.policyHash }, clock: () => f.ledger.clock(),
    reviewed: () => { reviewedCalls++; return reviewed; }, providerDevices: { workerActive: () => active },
    preparePresence: () => ({ ...tariffs[0], ready: true, at: f.ledger.clock() }) });
  const add = (engine, key, overrides = {}) => {
    const qualification = { address: worker.address, providerAuthorization: worker.providerAuthorization,
      providerDeviceId: worker.providerDeviceId, capacityId: P.hash(engine.policy.model + ":" + key),
      model: engine.policy.model, modelHash: engine.policy.modelHash, benchmarkHash: P.hash("benchmark-" + key),
      modelWeight: "1", coverageBps: 10000, expires: f.ledger.clock() + DAY, ...overrides };
    engine.state.records[key] = { policyHash: engine.policyHash, qualification,
      evidence: { target: structuredClone(engine.target), fingerprint: key === "current" ? worker.fingerprint : P.hash(key).slice(0, 16) } };
    return engine.state.records[key];
  };
  for (const engine of set.engines.values()) {
    add(engine, "current");
    for (let i = 1; i < recordsPerModel; i++) add(engine, "other-" + i, { address: f.owner,
      providerAuthorization: P.hash("authority-" + i), providerDeviceId: "other-device-" + i });
  }
  return { ...f, set, worker, names, add,
    get reviewedCalls() { return reviewedCalls; }, set reviewed(value) { reviewed = value; },
    set active(value) { active = value; } };
}

test("sixteen qualified models validate each record set once per inspection, with no persistent eligibility cache", t => {
  const f = setup(t), calls = new Map();
  for (const engine of f.set.engines.values()) {
    const records = engine.records.bind(engine);
    engine.records = () => { calls.set(engine, (calls.get(engine) || 0) + 1); return records(); };
  }
  const before = JSON.stringify([...f.set.engines.values()].map(e => e.state));
  assert.equal(f.set.qualifiedEngines(f.worker).length, 16);
  assert.equal(f.reviewedCalls, 1);
  assert.deepEqual([...calls.values()], Array(16).fill(1), "global qualification records are not rehashed for every candidate");
  assert.equal(f.set.qualifiedEngines(f.worker).length, 16);
  assert.equal(f.reviewedCalls, 2);
  assert.deepEqual([...calls.values()], Array(16).fill(2), "the next inspection reads fresh evidence");
  calls.clear();
  assert.equal(f.set.next(f.worker), null);
  assert.ok([...calls.values()].reduce((sum, n) => sum + n, 0) <= 4 * 16 * 16,
    "a full model poll remains quadratic instead of repeatedly scanning all models inside every candidate");
  assert.equal(JSON.stringify([...f.set.engines.values()].map(e => e.state)), before,
    "inspection and the already-qualified poll preserve all qualification evidence");
});

test("fresh cross-model and external fingerprint owners prevent serving, including unselected models", t => {
  const f = setup(t, 3, 1), engines = [...f.set.engines.values()];
  f.worker.models = [engines[0].policy.model];
  assert.equal(f.set.qualifiedEngines(f.worker).length, 1);
  const foreign = f.add(engines[2], "foreign", { address: f.owner });
  foreign.evidence.fingerprint = f.worker.fingerprint;
  assert.equal(f.set.qualifiedEngines(f.worker).length, 0, "unselected models still enforce cross-wallet device ownership");
  delete engines[2].state.records.foreign;
  assert.equal(f.set.qualifiedEngines(f.worker).length, 1);
  f.reviewed = [{ address: f.owner, fingerprint: f.worker.fingerprint }];
  assert.equal(f.set.qualifiedEngines(f.worker).length, 0);
  f.reviewed = [{ address: f.owner, capacityId: "legacy-device-" + f.worker.fingerprint }];
  assert.equal(f.set.qualifiedEngines(f.worker).length, 0, "legacy capacity suffixes retain the same ownership rule");
  f.reviewed = [];
  assert.equal(f.set.qualifiedEngines(f.worker).length, 1, "external reviewed evidence is not cached between calls");
});

test("device, authority, failed-run, target and expiry checks remain current on every inspection", t => {
  const f = setup(t, 2, 1), engines = [...f.set.engines.values()];
  for (const changed of [{ address: f.owner }, { providerAuthorization: "c".repeat(64) },
    { providerDeviceId: "another-device" }, { fingerprint: "d".repeat(16) }, { proof: "unsigned" }]) {
    assert.equal(f.set.qualifiedEngines({ ...f.worker, ...changed }).length, 0);
  }
  f.active = false; assert.equal(f.set.qualifiedEngines(f.worker).length, 0); f.active = true;
  engines[0].state.runs[f.worker.address] = { state: "failed", policyHash: engines[0].policyHash,
    targetHash: engines[0].targetHash, providerDeviceId: f.worker.providerDeviceId, results: [], retryAt: 0 };
  assert.deepEqual(f.set.qualifiedEngines(f.worker), [engines[1]]);
  engines[0].state.runs[f.worker.address].providerDeviceId = "another-device";
  assert.equal(f.set.qualifiedEngines(f.worker).length, 2, "a different device's failed run does not erase this device's valid record");
  const savedTarget = engines[0].state.records.current.evidence.target;
  engines[0].state.records.current.evidence.target = { ...savedTarget, policyHash: P.hash("changed") };
  assert.deepEqual(f.set.qualifiedEngines(f.worker), [engines[1]]);
  engines[0].state.records.current.evidence.target = savedTarget;
  const foreign = f.add(engines[1], "foreign", { address: f.owner, expires: f.ledger.clock() + 10 });
  foreign.evidence.fingerprint = f.worker.fingerprint;
  assert.equal(f.set.qualifiedEngines(f.worker).length, 0);
  f.time(10);
  assert.equal(f.set.qualifiedEngines(f.worker).length, 2, "expired foreign records stop reserving the fingerprint immediately");
  f.time(DAY - 10);
  assert.equal(f.set.qualifiedEngines(f.worker).length, 0, "own evidence expires at its exact deadline");
});
