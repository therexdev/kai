"use strict";

// Offline operator evidence only. This cannot install a tariff or qualify a node.
const { Meter, integer, digest, hash, price } = require("./metering");
const { uint } = require("./policy");
const ceil = (n, d) => (n + d - 1n) / d;

function calibrate({ tariff, samples, minimumSamples = 20, providerCostCoverageBps = 10000,
  workCapBps = 8000, rewardRevenueBps = 6000 }, adapter) {
  const meter = new Meter([{ tariff, adapter }]);
  const t = meter.entry(tariff.model, tariff.version).tariff;
  integer(minimumSamples, 1, 100000); integer(providerCostCoverageBps, 10000, 100000);
  integer(workCapBps, 1, 10000); integer(rewardRevenueBps, 1, 10000);
  if (!Array.isArray(samples) || !samples.length || samples.length > 100000) throw Error("Invalid samples");
  const seen = new Set(), latency = [], rows = [];
  let cost = 0n, charges = 0n, inputCount = 0n, outputCount = 0n, failures = 0;
  for (const s of samples) {
    digest(s.id);
    if (seen.has(s.id)) throw Error("Duplicate measurement");
    seen.add(s.id);
    for (const k of ["modelHash", "tokenizerHash", "templateHash"]) {
      if (s[k] !== t[k]) throw Error("Measurement pin mismatch");
    }
    integer(s.elapsedMs, 1, 3600000);
    if (typeof s.accepted !== "boolean") throw Error("Acceptance verdict required");
    const c = uint(s.costAtoms);
    if (!c) throw Error("Measured cost must be positive");
    cost += c;
    let charge = "0", inputTokens = 0, outputTokens = 0;
    if (s.accepted) {
      const q = meter.quote("shadow:calibration", t.model, t.version, s.messages, s.maxOutput, 0);
      const usage = meter.measure(q, s.output);
      ({ inputTokens, outputTokens } = usage);
      if (s.elapsedMs > t.maxLatencyMs) throw Error("Accepted measurement exceeds tariff deadline");
      charge = usage.amount;
      inputCount += BigInt(inputTokens); outputCount += BigInt(outputTokens);
      charges += BigInt(charge); latency.push(s.elapsedMs);
    } else failures++;
    // Never export prompts, output or hardware identifiers in the report.
    rows.push({ id: s.id, accepted: s.accepted, elapsedMs: s.elapsedMs, costAtoms: c.toString(), inputTokens, outputTokens, chargeAtoms: charge });
  }
  latency.sort((a, b) => a - b);
  const targetCost = ceil(cost * BigInt(providerCostCoverageBps), 10000n);
  // Revenue replenishment and the per-job work cap are separate constraints.
  // Neither assumes availability subsidies or a guaranteed provider payout.
  const requiredRevenue = ceil(targetCost * 10000n, BigInt(Math.min(workCapBps, rewardRevenueBps)));
  const scaleBps = charges ? (ceil(requiredRevenue * 10000n, charges) > 10000n ? ceil(requiredRevenue * 10000n, charges) : 10000n) : null;
  let candidate = null;
  if (scaleBps !== null) {
    candidate = { ...t, inputAtomsPerMillion: uint(ceil(uint(t.inputAtomsPerMillion) * scaleBps, 10000n)).toString(),
      outputAtomsPerMillion: uint(ceil(uint(t.outputAtomsPerMillion) * scaleBps, 10000n)).toString() };
    // Validate aggregate coverage using actual per-job integer rounding.
    const candidateRevenue = rows.reduce((sum, r) => sum + (r.accepted ? BigInt(price(candidate, r.inputTokens, r.outputTokens)) : 0n), 0n);
    if (candidateRevenue < requiredRevenue) throw Error("Candidate tariff fails coverage");
  }
  return { schema: 1, mode: "shadow", paymentsEnabled: false, policyHash: meter.policyHash,
    evidenceHash: hash(JSON.stringify(rows)), sampleCount: rows.length, acceptedCount: latency.length, failedCount: failures,
    sufficientSampleCount: latency.length >= minimumSamples, productionApproved: false,
    p95AcceptedLatencyMs: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null,
    inputTokens: inputCount.toString(), outputTokens: outputCount.toString(), measuredCostAtoms: cost.toString(),
    proposedRevenueAtoms: charges.toString(), requiredRevenueAtoms: requiredRevenue.toString(),
    providerCostCoverageBps, workCapBps, rewardRevenueBps, candidateTariff: candidate,
    caveat: "Operator-supplied costs and verdicts are not independently verified. Work rewards are pool-limited; this is not a payout guarantee or launch approval." };
}
module.exports = { calibrate };
