"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { fixture } = require("./helpers/koin-prepaid-fixture");
const P = require("../lib/koin-network/job-protocol"), Q = require("../lib/koin-network/qualification-protocol");
const { ProviderQualification } = require("../lib/koin-network/provider-qualification");
function setup(t) {
  const f = fixture(t), policy = { schema: 1, model: "fixture", modelHash: f.tariff.modelHash, modelWeight: "1", coverageBps: 10000,
    reviewedEvidenceHash: P.hash("preparation fixture"), maxLatencyMs: 4000, minPass: 2, renewBeforeMs: 60000, retryMs: 60000,
    cases: ["first", "second"].map(id => ({ id, messages: [{ role: "user", content: "Reply exactly OK." }], expected: ["OK"], maxOutput: 16 })) };
  let presence = null, active = true;
  const worker = { address: f.provider, fingerprint: "a".repeat(16), proof: "signed", providerAuthorization: "b".repeat(64), providerDeviceId: "device-fixture",
    capabilities: { koinQualification: 1, koinModelOnDemand: 1 }, models: ["fixture"] };
  const options = { file: path.join(f.dir, "qualification.json"), policy, target: f.target, meter: f.meter, clock: () => f.ledger.clock(),
    preparePresence: () => presence, providerDevices: { workerActive: () => active,
      verify: (signature, _action, digest, address) => P.signatureMatches(digest, signature, address) } };
  const body = async job => ({ jobId: job.challenge.id, output: "OK", signature: Buffer.from(await f.worker.signHash(Q.resultHash(job, P.hash("OK")))).toString("base64") });
  return { ...f, policy, worker, options, body, engine: new ProviderQualification(options),
    set presence(p) { presence = p; }, set active(value) { active = value; } };
}
test("cold model preparation survives restart and starts the answer deadline only after fresh pinned device readiness", async t => {
  const f = setup(t), prepare = f.engine.next(f.worker);
  assert.equal(prepare.type, "koin-provider-prepare"); assert.equal(prepare.expiresAt - prepare.issuedAt, 120000);
  assert.equal(f.engine.records().length, 0); assert.equal(f.engine.state.runs[f.provider].pending, null);
  f.time(40001); f.engine = new ProviderQualification(f.options);
  assert.deepEqual(f.engine.next(f.worker), prepare, "server restart does not extend the preparation deadline");
  f.presence = { ready: true, at: f.ledger.clock(), model: f.policy.model, modelHash: f.policy.modelHash };
  const first = f.engine.next(f.worker);
  assert.equal(first.type, "koin-provider-qualification"); assert.equal(first.challenge.dispatchedAt, f.ledger.clock());
  assert.equal(first.challenge.deadline - first.challenge.dispatchedAt, 4000, "answer timeout is unchanged by a slow load");
  f.engine.result(f.worker, await f.body(first)); assert.equal(f.engine.records().length, 0);
  const second = f.engine.next(f.worker); f.engine.result(f.worker, await f.body(second)); assert.equal(f.engine.records().length, 1);
});
test("wrong, stale, future or unready presence never begins an answer; preparation expiry creates no eligibility", t => {
  const f = setup(t), prepare = f.engine.next(f.worker);
  for (const patch of [{ ready: false }, { at: f.ledger.clock() - 1 }, { at: f.ledger.clock() + 1 }, { model: "other" }, { modelHash: P.hash("other") }]) {
    f.presence = { ready: true, at: f.ledger.clock(), model: f.policy.model, modelHash: f.policy.modelHash, ...patch };
    assert.deepEqual(f.engine.next(f.worker), prepare);
  }
  f.time(120000); f.presence = { ready: true, at: f.ledger.clock(), model: f.policy.model, modelHash: f.policy.modelHash };
  assert.equal(f.engine.next(f.worker), null); assert.equal(f.engine.status(f.provider).state, "failed"); assert.equal(f.engine.records().length, 0);
  assert.equal(f.engine.next(f.worker), null); f.engine = new ProviderQualification(f.options); assert.equal(f.engine.next(f.worker), null);
});
test("revocation stops preparation and legacy clients still use their existing challenge protocol", t => {
  const f = setup(t); f.engine.next(f.worker); f.active = false; assert.equal(f.engine.next(f.worker), null);
  assert.equal(f.engine.records().length, 0);
  const legacy = setup(t); delete legacy.worker.providerAuthorization; delete legacy.worker.providerDeviceId; delete legacy.worker.capabilities.koinModelOnDemand;
  assert.equal(legacy.engine.next(legacy.worker).type, "koin-provider-qualification");
});
test("another authorized device cannot cancel or bypass a live cold preparation for this wallet", t => {
  const f = setup(t), first = f.engine.next(f.worker), other = { ...f.worker, providerAuthorization: "c".repeat(64), providerDeviceId: "another-device", fingerprint: "d".repeat(16) };
  assert.equal(f.engine.next(other), null);
  assert.deepEqual(f.engine.next(f.worker), first);
  assert.equal(f.engine.status(f.provider).state, "testing");
  const sameFingerprint = { ...other, fingerprint: f.worker.fingerprint };
  assert.equal(f.engine.next(sameFingerprint), null);
  assert.deepEqual(f.engine.next(f.worker), first);
});
