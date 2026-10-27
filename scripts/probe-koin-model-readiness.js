"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { fixture } = require("./helpers/koin-prepaid-fixture");
const { Meter } = require("../lib/koin-network/metering");
const P = require("../lib/koin-network/job-protocol"), Q = require("../lib/koin-network/qualification-protocol");
const R = require("../lib/koin-network/runtime-readiness"), Evidence = require("../lib/koin-network/qualification-evidence");
const { ProviderQualification, policy } = require("../lib/koin-network/provider-qualification");
const { ProviderQualificationSet } = require("../lib/koin-network/provider-qualification-set");
const Migration = require("../deploy/koin-mainnet/model-readiness"), Previous = require("../deploy/koin-mainnet/catalog-qualification");
const { runtime: catalogRuntime } = require("./probe-catalog-qualification");
function setup(t) {
  const f = fixture(t), tariff = { ...f.tariff, maxOutputTokens: 256 }, encode = s => [...Buffer.from(s)];
  const meter = new Meter([{ tariff, adapter: { ...tariff, render: JSON.stringify, encode, input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } }]);
  const target = { ...f.target, policyHash: meter.policyHash };
  const config = { schema: 2, kind: R.KIND, model: tariff.model, modelHash: tariff.modelHash, modelWeight: "1", coverageBps: 10000,
    reviewedEvidenceHash: P.hash("reviewed readiness fixture"), maxLatencyMs: 4000, minPass: 2, renewBeforeMs: 60000, retryMs: 60000, cases: structuredClone(R.CASES) };
  const worker = { address: f.provider, fingerprint: "a".repeat(16), proof: "signed", providerAuthorization: P.hash("authorized fixture device"), providerDeviceId: "fixture-device",
    capabilities: { koinQualification: 1, koinRuntimeReadiness: 1, koinModelOnDemand: 1 }, models: [tariff.model] };
  let active = true, ready = true;
  const providerDevices = { workerActive: w => active && w.providerAuthorization === worker.providerAuthorization && w.providerDeviceId === worker.providerDeviceId,
    verify: (signature, action, digest, address) => { assert.equal(action, "qualification"); P.signatureMatches(digest, signature, address); } };
  const options = { file: path.join(f.dir, "readiness.json"), policy: config, target, meter, clock: () => f.ledger.clock(), providerDevices,
    preparePresence: () => ({ ready, at: f.ledger.clock(), model: tariff.model, modelHash: tariff.modelHash }) };
  const body = async (job, output) => ({ jobId: job.challenge.id, output, signature: Buffer.from(await f.worker.signHash(Q.resultHash(job, P.hash(output)))).toString("base64") });
  const expected = engine => engine.state.runs[f.provider].pendingReadiness.nonce;
  return { ...f, tariff, meter, target, config, options, worker, body, expected, setActive: v => active = v, setReady: v => ready = v, engine: new ProviderQualification(options) };
}
test("readiness accepts only the complete fresh label and explicit presentation wrappers, never arbitrary content", () => {
  const label = "KAI-A1B2C3D4E5F60718";
  for (const output of [label, "\n" + label + "\n", '"' + label + '"', "`" + label + "`", "Label: " + label,
    "The label is: " + label, "```text\n" + label + "\n```", "<think>Recall the supplied label.</think>\n" + label]) assert.equal(R.answer(output, label), true, output);
  for (const output of ["", "OK", label + "-extra", "prefix " + label, label + " ignored", "<think>" + label, "<think>" + label + "</think>",
    "<think><think>nested</think>" + label, "```text\n" + label + "\n``` extra", label.toLowerCase(), "KAI-A1B2C3D4E5F60719", "x".repeat(16385)]) assert.equal(R.answer(output, label), false, output.slice(0, 100));
  assert.notEqual(R.challenge("echo-label").nonce, R.challenge("echo-label").nonce);
  assert.throws(() => R.challenge("unknown", label)); assert.throws(() => R.challenge("echo-label", "arbitrary"));
});
test("two fresh signed readiness answers survive restart, bind evidence and expire without granting quality or credits", async t => {
  const f = setup(t), first = f.engine.next(f.worker), nonce = f.expected(f.engine);
  assert.equal(first.challenge.quote.maxOutput, 256); assert.equal(f.engine.records().length, 0);
  assert.equal(f.engine.status(f.provider).kind, R.KIND); assert.equal(f.engine.status(f.provider).required, 2);
  f.engine = new ProviderQualification(f.options); assert.equal(f.expected(f.engine), nonce); assert.equal(f.engine.next(f.worker), null);
  const firstBody = await f.body(first, nonce); f.engine.result(f.worker, firstBody); f.engine.result(f.worker, firstBody);
  assert.equal(f.engine.status(f.provider).completed, 1); assert.equal(f.engine.records().length, 0);
  const second = f.engine.next(f.worker), secondNonce = f.expected(f.engine); assert.notEqual(secondNonce, nonce);
  assert.throws(() => f.engine.result(f.worker, { ...firstBody, jobId: second.challenge.id }), /signature/i);
  f.engine.result(f.worker, await f.body(second, '"' + secondNonce + '"'));
  const [record] = f.engine.records(); assert.equal(record.expires, f.ledger.clock() + 86400000);
  assert.equal(record.modelWeight, "1"); assert.equal(record.coverageBps, 10000);
  const archive = JSON.parse(fs.readFileSync(path.join(f.dir, "qualification-evidence", record.benchmarkHash + ".json")));
  const result = archive.evidence.results[0], expected = { target: f.target, policyHash: f.engine.policyHash, address: f.provider };
  assert.deepEqual(Evidence.verifyResult(result, expected), { state: "signature-verified", qualityReplayed: false, readinessReplayed: true });
  for (const change of [r => r.readiness.nonce = "KAI-0000000000000000", r => r.readiness.output += "x", r => r.readiness.quote.requestHash = P.hash("changed"), r => r.passed = false]) {
    const changed = structuredClone(result); change(changed); assert.throws(() => Evidence.verifyResult(changed, expected));
  }
  assert.equal(f.ledger.jobs().length, 0); assert.equal(f.ledger.purchases(f.owner).length, 0);
  const Runtime = require("../lib/koin-network/test-runtime").TestRuntime, runtime = { config: { qualificationPolicies: [f.config] }, qualifier: f.engine,
    providerDevices: f.options.providerDevices, scheduler: { workers: new Map([["device", f.worker]]) }, qualifications: () => f.engine.records(), clock: () => f.ledger.clock() };
  assert.equal(Runtime.prototype.qualified.call(runtime, f.provider, f.config.model, f.config.modelHash, f.ledger.clock(), f.worker), true);
  assert.equal(Runtime.prototype.qualified.call(runtime, f.provider, f.config.model, f.config.modelHash, f.ledger.clock(), { ...f.worker, capabilities: { ...f.worker.capabilities, koinRuntimeReadiness: 0 } }), false);
  f.time(86400000 - 60000); const renewal = f.engine.next(f.worker); assert.ok(renewal); assert.notEqual(f.expected(f.engine), nonce);
  assert.throws(() => f.engine.result(f.worker, firstBody), /expired or changed/);
  f.time(60001); assert.equal(f.engine.records().length, 0);
});
test("readiness refuses unsigned or legacy capability claims, revoked devices, missing preparation and invalid policies", async t => {
  const f = setup(t);
  for (const delta of [{ proof: "unsigned" }, { providerAuthorization: undefined }, { providerDeviceId: undefined },
    { capabilities: { koinQualification: 1, koinModelOnDemand: 1 } }, { capabilities: { koinQualification: 1, koinRuntimeReadiness: 1 } }])
    assert.equal(f.engine.next({ ...f.worker, ...delta }), null);
  f.setActive(false); assert.equal(f.engine.next(f.worker), null); f.setActive(true);
  assert.equal(new ProviderQualification({ ...f.options, preparePresence: undefined }).next(f.worker), null);
  f.setReady(false); const preparation = f.engine.next(f.worker); assert.equal(preparation.type, "koin-provider-prepare"); assert.equal(f.engine.records().length, 0);
  f.setReady(true); const job = f.engine.next(f.worker); assert.equal(job.type, "koin-provider-qualification");
  f.setActive(false); assert.throws(() => f.engine.result(f.worker, { jobId: job.challenge.id, output: f.expected(f.engine), signature: "invalid" }), /signed-device/);
  for (const delta of [{ kind: "quality" }, { schema: 1 }, { minPass: 1 }, { maxLatencyMs: 5001 }, { cases: [] },
    { cases: [{ id: "echo-label", maxOutput: 32 }, R.CASES[1]] }, { extra: true }]) assert.throws(() => policy({ ...f.config, ...delta }, f.tariff));
});
test("wrong, stale and late readiness responses fail without overwriting identity or creating eligibility", async t => {
  const f = setup(t), first = f.engine.next(f.worker), current = f.expected(f.engine);
  const forged = await f.body(first, current); forged.output = current + "changed"; assert.throws(() => f.engine.result(f.worker, forged), /signature/i);
  assert.throws(() => f.engine.result({ ...f.worker, providerDeviceId: "another-device" }, forged), /signed-device/);
  f.engine.result(f.worker, await f.body(first, "KAI-0000000000000000"));
  const second = f.engine.next(f.worker); f.time(4001);
  const late = await f.body(second, f.expected(f.engine)); assert.throws(() => f.engine.result(f.worker, late), /expired or changed/);
  f.engine.next(f.worker); assert.equal(f.engine.records().length, 0);
  assert.deepEqual(f.engine.status(f.provider).failure, { code: "response_and_deadline", wrongAnswers: 1, deadlines: 1, unknown: 0 });
  f.engine = new ProviderQualification(f.options); assert.equal(f.engine.next(f.worker), null);
  f.time(60000); assert.ok(f.engine.next(f.worker)); assert.notEqual(f.expected(f.engine), current);
});
test("versioned readiness journals retain legacy failed quality runs byte-for-byte and never promote them", async t => {
  const f = setup(t), oldPolicy = { ...f.config, schema: 1, cases: ["first", "second"].map(id => ({ id, maxOutput: 32, messages: [{ role: "user", content: "Reply exactly OK" }], expected: ["OK"] })) };
  delete oldPolicy.kind;
  const options = { ...f.options, policies: [oldPolicy] }; delete options.policy;
  const old = new ProviderQualificationSet(options), first = old.next(f.worker); old.result(f.worker, await f.body(first, "Wrong"));
  const file = path.join(options.file + ".models", P.hash(f.config.model) + ".json"), before = fs.readFileSync(file);
  const current = new ProviderQualificationSet({ ...options, policies: [f.config] }); assert.equal(current.readinessVersion, 1); assert.equal(old.readinessVersion, 0);
  assert.equal(current.status(f.provider, f.config.model), null); assert.equal(current.records().length, 0); current.next(f.worker);
  assert.deepEqual(fs.readFileSync(file), before); assert.ok(fs.existsSync(path.join(options.file + ".models", "runtime-readiness-v1", P.hash(JSON.stringify(f.config)), P.hash(f.config.model) + ".json")));
});
test("legacy manually reviewed evidence cannot bypass fresh readiness or defer its challenges", t => {
  const f = setup(t), legacy = { address: f.provider, model: f.config.model, modelHash: f.config.modelHash,
    fingerprint: f.worker.fingerprint, capacityId: "legacy-" + f.worker.fingerprint, benchmarkHash: P.hash("legacy-quality"), expires: f.ledger.clock() + 86400000 };
  const engine = new ProviderQualification({ ...f.options, reviewed: () => [legacy] }); assert.ok(engine.next(f.worker));
  const Runtime = require("../lib/koin-network/test-runtime").TestRuntime;
  const runtime = { config: { qualificationPolicies: [f.config] }, qualifier: { records: () => [] }, reviewedQualifications: () => [legacy] };
  assert.deepEqual(Runtime.prototype.qualifications.call(runtime), []);
  runtime.config.qualificationPolicies = [{ schema: 1, model: f.config.model }]; assert.deepEqual(Runtime.prototype.qualifications.call(runtime), [legacy]);
});
test("readiness activation synchronously retires future legacy accrual while retaining all historical money evidence", t => {
  const f = setup(t), { KoinShadow } = require("../lib/koin-network/shadow"), Runtime = require("../lib/koin-network/test-runtime").TestRuntime;
  f.time(60000 - f.ledger.clock() % 60000); const start = f.ledger.clock(), shadow = new KoinShadow(path.join(f.dir, "shadow"), { clock: () => f.ledger.clock() });
  const budget = shadow.open("10000000000"), q = { address: f.provider, capacityId: "old-capacity", model: f.config.model, modelHash: f.config.modelHash,
    modelWeight: "1", coverageBps: 10000, benchmarkHash: P.hash("legacy-quality"), expires: start + 86400000 };
  shadow.qualify(q); const approvedAt = shadow.state.qualifications[q.capacityId].approvedAt;
  const samples = Array.from({ length: 9 }, (_, i) => ({ at: start + i * 30000, ready: true, model: q.model, modelHash: q.modelHash, session: "a".repeat(32) }));
  shadow.state.presence[q.address] = { ...samples.at(-1), samples };
  const historic = { intervals: [{ start: start - 120000, end: start - 60000, slots: [{ ...q, approvedAt }] }], work: [{ id: "already-verified-work" }], sealed: true };
  shadow.state.days[budget.epoch - 1] = structuredClone(historic); shadow.save();
  const preserved = JSON.stringify(shadow.state.days[budget.epoch - 1]), originalBudget = JSON.stringify(shadow.state.budgets);
  f.time(60000); const cutoff = f.ledger.clock();
  const runtime = { config: { qualificationPolicies: [f.config] }, scheduler: { koinShadow: { ledger: shadow } }, qualifications: () => [], client: { verify: () => { throw Error("RPC unavailable"); } } };
  Runtime.prototype.retireLegacyReadinessCapacity.call(runtime);
  assert.equal(shadow.state.qualifications[q.capacityId].expires, cutoff); assert.equal(shadow.state.qualifications[q.capacityId].approvedAt, approvedAt);
  assert.equal(JSON.stringify(shadow.state.days[budget.epoch - 1]), preserved); assert.equal(JSON.stringify(shadow.state.budgets), originalBudget);
  assert.equal(shadow.retireUnmatchedQualifications([q.model], []), false, "restart cannot move the cutoff forward");
  f.time(180001); shadow.tick();
  const intervals = shadow.state.days[budget.epoch].intervals; assert.ok(intervals.some(i => i.end <= cutoff && i.slots.length === 1));
  assert.ok(intervals.some(i => i.end > cutoff)); assert.ok(intervals.filter(i => i.end > cutoff).every(i => i.slots.length === 0));
  assert.equal(JSON.stringify(shadow.state.days[budget.epoch - 1]), preserved);
  const fresh = { ...q, benchmarkHash: P.hash("fresh-readiness"), expires: f.ledger.clock() + 86400000 }; shadow.qualify(fresh);
  assert.equal(shadow.retireUnmatchedQualifications([q.model], [fresh]), false, "fresh matching namespace evidence survives restart");
});
test("reviewed runtime migration changes only the exact known catalog policies and is idempotent", () => {
  const runtime = catalogRuntime(), oldPolicies = Previous.reviewed().policies;
  runtime.qualificationPolicies = oldPolicies; const bytes = Buffer.from(JSON.stringify(runtime)), changed = Migration.nextRuntime(bytes), current = JSON.parse(changed.bytes);
  assert.equal(changed.already, false); assert.equal(changed.review.eligibilityCreated, false); assert.equal(current.qualificationPolicies.length, 15);
  assert.ok(current.qualificationPolicies.every(p => p.schema === 2 && p.kind === R.KIND && p.minPass === 2));
  const expected = structuredClone(current); expected.qualificationPolicies = oldPolicies; assert.deepEqual(expected, runtime);
  for (const p of current.qualificationPolicies) { const old = oldPolicies.find(x => x.model === p.model); for (const key of ["modelWeight", "coverageBps", "modelHash", "maxLatencyMs", "renewBeforeMs", "retryMs"]) assert.equal(p[key], old[key]); }
  assert.strictEqual(Migration.nextRuntime(changed.bytes).bytes, changed.bytes);
  for (const change of [r => r.qualificationPolicies.pop(), r => r.qualificationPolicies[0].minPass = 11, r => r.qualificationPolicies[0].modelWeight = "99", r => r.policyHash = P.hash("other"), r => r.models.pop()]) {
    const altered = structuredClone(runtime); change(altered); assert.throws(() => Migration.nextRuntime(Buffer.from(JSON.stringify(altered))));
  }
});
