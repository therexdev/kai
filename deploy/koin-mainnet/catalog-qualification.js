"use strict";
// Explicit criteria reuse, not invented model measurements or qualifications.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { configuration } = require("../../lib/koin-network/test-config");
const Models = require("../../lib/koin-network/model-configuration");
const { policy: validatePolicy } = require("../../lib/koin-network/provider-qualification");
const { modelWeight } = require("../../lib/koin-network/policy");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function reviewed() {
  const bytes = fs.readFileSync(path.join(__dirname, "qualification/catalog-2026-10-27.review.json"));
  const review = JSON.parse(bytes), reviewHash = hash(bytes);
  const cases = require("./qualification/fast-candidate-v1.json").cases;
  const smart = require("./qualification/smart-2026-10-24.policy.json");
  const catalogBytes = fs.readFileSync(path.join(__dirname, "model-rates.proposal.json"));
  const indexBytes = fs.readFileSync(path.join(__dirname, "../../lib/koin-network/tokenizers/candidates/index.json"));
  const catalog = JSON.parse(catalogBytes), index = JSON.parse(indexBytes);
  if (review.schema !== 1 || review.kind !== "criteria-review-not-model-measurement" || review.baselineCasesSha256 !== hash(JSON.stringify(cases)) ||
      review.catalogSha256 !== hash(catalogBytes) || review.tokenizerIndexSha256 !== hash(indexBytes) || review.existingSmartPolicySha256 !== hash(JSON.stringify(smart)) ||
      !same(review.criteria, { minPass: 12, total: 12, maxLatencyMs: 30000, coverageBps: 10000, renewBeforeMs: 3600000, retryMs: 300000,
        qualificationLifetimeMs: 86400000, modelWeightRule: "round(sqrt(nominalParametersBillions / 4) * 10000)" }) ||
      review.models.length !== 15 || catalog.models.length !== 15 || index.models.length !== 15) throw Error("Catalog qualification review differs");
  const seen = new Set(), policies = review.models.map(m => {
    const c = catalog.models.find(c => c.model === m.model), indexed = index.models.find(c => c.model === m.model);
    if (!c || !indexed || seen.has(m.model) || c.modelHash !== m.modelHash || indexed.modelHash !== m.modelHash ||
        c.package !== m.package || indexed.package !== m.package || indexed.nativeVocabularyVerified !== true || indexed.candidateCasePromptsVerified !== 12)
      throw Error("Reviewed catalog package differs");
    seen.add(m.model);
    const policy = m.model === "koinos-smart" ? structuredClone(smart) : { schema: 1, model: m.model, modelHash: m.modelHash,
      modelWeight: String(modelWeight(m.nominalParametersBillions)), coverageBps: 10000, reviewedEvidenceHash: reviewHash,
      maxLatencyMs: 30000, minPass: 12, renewBeforeMs: 3600000, retryMs: 300000, cases: structuredClone(cases) };
    if (policy.modelWeight !== String(modelWeight(m.nominalParametersBillions))) throw Error("Reviewed model weight differs");
    return policy;
  }).sort((a, b) => a.model.localeCompare(b.model));
  return { review, reviewHash, policies };
}
function summary(policies) {
  return policies.map(p => ({ model: p.model, modelHash: p.modelHash, policyHash: hash(JSON.stringify(p)), minPass: p.minPass,
    total: p.cases.length, maxLatencyMs: p.maxLatencyMs })).sort((a, b) => a.model.localeCompare(b.model));
}
function nextRuntime(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const original = JSON.parse(bytes), c = configuration(original), { review, reviewHash, policies } = reviewed(), scope = review.scope;
  if (c.schema !== 2 || c.mode !== scope.mode || c.schedulerUrl !== scope.schedulerUrl || c.policyHash !== scope.policyHash || c.accountMode !== "public" ||
      Object.entries(scope.deployment).some(([key, value]) => c.deployment[key] !== value)) throw Error("Runtime is not the reviewed prepaid model deployment");
  const tariffs = Models.tariffs(c);
  if (tariffs.length !== policies.length) throw Error("The exact reviewed model catalog is required");
  for (const p of policies) validatePolicy(p, tariffs.find(t => t.model === p.model));
  if (c.qualificationPolicy !== undefined) throw Error("Unexpected single-model qualification policy");
  for (const current of c.qualificationPolicies || []) {
    if (!same(current, policies.find(p => p.model === current.model))) throw Error("Existing model qualification policy differs; no policy was replaced");
  }
  const publicReview = { schema: 1, reviewHash, models: summary(policies), eligibilityCreated: false };
  if (same(c.qualificationPolicies, policies)) return { bytes, already: true, review: publicReview };
  // Start with the original parsed runtime; all fields except this one remain
  // untouched, including free grants, tariffs, sponsor ceilings and private URLs.
  original.qualificationPolicies = policies; configuration(original);
  return { bytes: Buffer.from(JSON.stringify(original, null, 2) + "\n"), already: false, review: publicReview };
}
module.exports = { reviewed, summary, nextRuntime };
