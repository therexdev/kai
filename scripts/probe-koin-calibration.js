"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { calibrate } = require("../lib/koin-network/calibration");
const { hash } = require("../lib/koin-network/metering");
const tariff = { model: "fixture", version: 1, modelHash: hash("model"), tokenizerHash: hash("tokenizer"), templateHash: hash("template"),
  inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 32, contextTokens: 4096, maxLatencyMs: 1000 };
const adapter = { ...tariff, input: () => 10, output: () => 10 };
const sample = (n = 0) => ({ id: hash(String(n)), ...tariff, accepted: true, elapsedMs: 100, costAtoms: "12",
  messages: [{ role: "user", content: "PRIVATE PROMPT" }], output: "PRIVATE OUTPUT", maxOutput: 32 });
test("calibration recounts usage, preserves 60/25/15 funding and never approves production", () => {
  const report = calibrate({ tariff, samples: Array.from({ length: 20 }, (_, n) => ({ ...sample(n), inputTokens: 999999 })) }, adapter);
  assert.equal(report.inputTokens, "200"); assert.equal(report.proposedRevenueAtoms, "400");
  assert.equal(report.requiredRevenueAtoms, "400"); assert.equal(report.candidateTariff.inputAtomsPerMillion, "1000000");
  assert.equal(report.sufficientSampleCount, true); assert.equal(report.productionApproved, false);
  assert.equal(report.paymentsEnabled, false); assert.equal(JSON.stringify(report).includes("PRIVATE"), false);
});
test("failed compute has costs but no billable revenue; coverage includes failures", () => {
  const report = calibrate({ tariff, samples: [sample(), { ...sample(1), accepted: false }] }, adapter);
  assert.equal(report.failedCount, 1); assert.equal(report.proposedRevenueAtoms, "20");
  assert.equal(report.requiredRevenueAtoms, "40"); assert.equal(report.candidateTariff.outputAtomsPerMillion, "2000000");
  assert.equal(report.sufficientSampleCount, false);
  const failed = calibrate({ tariff, samples: [{ ...sample(), accepted: false }] }, adapter);
  assert.equal(failed.candidateTariff, null); assert.equal(failed.p95AcceptedLatencyMs, null);
});
test("bad pins, duplicate measurements, invalid costs and missed deadlines fail closed", () => {
  for (const samples of [[sample(), sample()], [{ ...sample(), modelHash: hash("other") }],
    [{ ...sample(), costAtoms: "-1" }], [{ ...sample(), costAtoms: "0" }],
    [{ ...sample(), elapsedMs: 1001 }], [{ ...sample(), maxOutput: 2 }]]) {
    assert.throws(() => calibrate({ tariff, samples }, adapter));
  }
  assert.throws(() => calibrate({ tariff, samples: [sample()], rewardRevenueBps: 0 }, adapter));
});
test("provider cap can be the binding constraint and cost arithmetic stays exact", () => {
  const report = calibrate({ tariff, samples: [sample()], workCapBps: 3000 }, adapter);
  assert.equal(report.requiredRevenueAtoms, "40");
  const big = calibrate({ tariff, samples: [{ ...sample(), accepted: false, costAtoms: "9007199254740993" }] }, adapter);
  assert.equal(big.measuredCostAtoms, "9007199254740993");
  assert.equal(big.requiredRevenueAtoms, "15011998757901655");
  assert.throws(() => calibrate({ tariff, samples: [{ ...sample(), costAtoms: "9007199254740993" }] }, adapter), /uint64/);
});
