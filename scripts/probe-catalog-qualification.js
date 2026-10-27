"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { nextRuntime, reviewed, summary } = require("../deploy/koin-mainnet/catalog-qualification");
const { evidence } = require("../deploy/koin-mainnet/install-smart-qualification");
const { Meter } = require("../lib/koin-network/metering");
const { ProviderQualificationSet } = require("../lib/koin-network/provider-qualification-set");
const { fixture } = require("./helpers/koin-prepaid-fixture");
const P = require("../lib/koin-network/job-protocol"), Q = require("../lib/koin-network/qualification-protocol");
function runtime() {
  const s = evidence().review.scope;
  return { schema: 2, mode: s.mode, schedulerUrl: s.schedulerUrl, policyHash: s.policyHash, version: 1, accountMode: "public",
    deployment: { schema: 1, decimals: 8, rpc: ["https://api.koinosai.com", "https://api.koinos.io"], ...s.deployment,
      token: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", tokenHash: "0x1220eb38ea471cf855ff4d336e51bf47df8cfc8a0a9ae49193b0d7e103b890d464d6",
      admin: "1EZFE7yY9waCFR454BkKmxbehQLUvEDDpK", verifier: "1HdgLvVRbvrwnF547sbEbmSu5USTu7Gy1K",
      mining: "1G4L15H3TWKUzzg9i3CV5w97exuvQ6vNVz", operations: "1PVLC9iF1rZ1zxEQDLJiniXL973GPateK8" },
    roles: { settlement: "1P9pLR3fLqBUwT2tuShBdpBBQEaarcFRE1", lifecycle: "1NgDtrzJfPwdaWskKMfWVvjJQmW4dLdvYw", claims: "1NMaeSzHS9rZsAMK9FZTZt2vGMcSzr7pDr" },
    models: structuredClone(require("../deploy/koin-mainnet/settings.prepaid-usd.models.example.json").settings.models),
    maxRcPerTransaction: "100000000", maxRcPerDay: "500000000",
    purchaseQuoteBudget: { schema: 1, dailyQuoteAuthorizationUsdAtoms: "100000000", accountDailyQuoteAuthorizationUsdAtoms: "100000000" },
    freePolicy: { version: 1, accountConcurrent: 1, accountDaily: "750000", networkDaily: "30000000", originDaily: "2250000", eligibleModels: ["koinos-fast"] },
    qualificationPolicies: [structuredClone(evidence().policy)] };
}
test("catalog criteria enable all fifteen exact models without altering grants, prices, limits, deployment or existing Smart evidence", () => {
  const original = runtime(), bytes = Buffer.from(JSON.stringify(original)), changed = nextRuntime(bytes), current = JSON.parse(changed.bytes);
  assert.equal(changed.already, false); assert.equal(current.qualificationPolicies.length, 15); assert.equal(changed.review.eligibilityCreated, false);
  assert.deepEqual(current.qualificationPolicies.find(p => p.model === "koinos-smart"), original.qualificationPolicies[0]);
  const r = reviewed(); assert.equal(r.review.kind, "criteria-review-not-model-measurement");
  assert.ok(r.review.models.filter(m => m.model !== "koinos-smart").every(m => m.priorFullModelMeasurement === "not-established"));
  assert.ok(current.qualificationPolicies.every(p => p.minPass === 12 && p.cases.length === 12 && p.maxLatencyMs === 30000));
  const expected = structuredClone(current); expected.qualificationPolicies = original.qualificationPolicies; assert.deepEqual(expected, original);
  const repeated = nextRuntime(changed.bytes); assert.equal(repeated.already, true); assert.strictEqual(repeated.bytes, changed.bytes);
  assert.deepEqual(repeated.review.models, summary(current.qualificationPolicies));
  for (const change of [c => c.schedulerUrl = "https://other.example/scheduler", c => c.deployment.rewardsHash = "0x1220" + "f".repeat(64),
    c => c.qualificationPolicies[0].minPass = 11, c => c.qualificationPolicies[0].modelWeight = "999999",
    c => c.qualificationPolicies[0].reviewedEvidenceHash = "e".repeat(64), c => c.models.pop()]) {
    const c = runtime(); change(c); assert.throws(() => nextRuntime(Buffer.from(JSON.stringify(c))));
  }
});
test("every catalog model requires twelve fresh signed answers; policy installation alone never creates a qualification", async t => {
  const f = fixture(t), config = runtime(), policies = reviewed().policies, encode = s => [...Buffer.from(s)];
  const meter = new Meter(config.models.map(({ tariff }) => ({ tariff, adapter: { ...tariff, render: JSON.stringify, encode,
    input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } })));
  const target = { ...f.target, policyHash: meter.policyHash }, options = { file: path.join(f.dir, "all-model-qualification.json"), policies, target, meter, clock: () => f.ledger.clock() };
  let engine = new ProviderQualificationSet(options);
  assert.equal(engine.records().length, 0);
  for (const policy of policies) {
    const worker = { address: f.provider, fingerprint: "c".repeat(16), proof: "signed", capabilities: { koinQualification: 1 }, models: [policy.model] };
    for (let i = 0; i < 12; i++) {
      const job = engine.next(worker); assert.equal(job.challenge.model, policy.model);
      const row = policy.cases.find(c => JSON.stringify(c.messages) === job.challenge.prompt);
      const output = row.expected[0], signature = Buffer.from(await f.worker.signHash(Q.resultHash(job, P.hash(output)))).toString("base64");
      const body = { jobId: job.challenge.id, output, signature };
      if (i === 0) assert.throws(() => engine.result(worker, { ...body, output: output + " changed" }), /signature/i);
      engine.result(worker, body);
      if (i < 11) assert.equal(engine.records().some(q => q.model === policy.model), false);
      if (i === 5) engine = new ProviderQualificationSet(options);
    }
    const qualified = engine.records().find(q => q.model === policy.model);
    assert.equal(qualified.modelHash, policy.modelHash); assert.equal(qualified.expires, f.ledger.clock() + 86400000);
  }
  assert.equal(engine.records().length, 15); assert.equal(new Set(engine.records().map(q => q.capacityId)).size, 15);
  assert.equal(f.ledger.jobs().length, 0, "benchmarks do not create credit usage or grant new balances");
});
module.exports = { runtime };
