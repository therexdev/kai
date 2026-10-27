"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { configuration } = require("../../lib/koin-network/test-config");
const Models = require("../../lib/koin-network/model-configuration");
const { policy: validatePolicy } = require("../../lib/koin-network/provider-qualification");
const Readiness = require("../../lib/koin-network/runtime-readiness");
const Previous = require("./catalog-qualification");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const REVIEW_FILE = path.join(__dirname, "qualification/model-readiness-2026-10-27.review.json");
function reviewed() {
  const bytes = fs.readFileSync(REVIEW_FILE), review = JSON.parse(bytes), reviewHash = hash(bytes), previous = Previous.reviewed();
  if (review.schema !== 2 || review.kind !== "runtime-readiness-policy-review" || !same(review.scope, previous.review.scope) ||
      review.previousCatalogReviewHash !== previous.reviewHash || review.previousPoliciesSha256 !== hash(JSON.stringify(previous.policies)) ||
      review.readinessImplementationSha256 !== hash(fs.readFileSync(path.join(__dirname, "../../lib/koin-network/runtime-readiness.js"))) ||
      !same(review.criteria, { kind: Readiness.KIND, version: 1, minPass: 2, total: 2, maxOutput: 256, maxLatencyMs: 30000,
        renewBeforeMs: 3600000, retryMs: 300000, qualificationLifetimeMs: 86400000 }) ||
      !same(review.models, previous.review.models.map(({ model, package: modelPackage, modelHash, nominalParametersBillions }) =>
        ({ model, package: modelPackage, modelHash, nominalParametersBillions })))) throw Error("Runtime-readiness review differs");
  const measuredModels = ["koinos-fast", "gemma3-4b", "llama31-8b", "mistral-7b"];
  if (!Array.isArray(review.measurements) || !same(review.measurements.map(m => m.model), measuredModels)) throw Error("Exact measured readiness observations required");
  for (const measurement of review.measurements) {
    if (measurement.file !== `model-readiness-2026-10-27.${measurement.model}.observation.json`) throw Error("Unexpected readiness observation path");
    const observationBytes = fs.readFileSync(path.join(path.dirname(REVIEW_FILE), measurement.file)), observation = JSON.parse(observationBytes);
    const catalogModel = previous.review.models.find(m => m.model === measurement.model);
    if (measurement.sha256 !== hash(observationBytes) || measurement.modelHash !== catalogModel.modelHash || observation.model !== measurement.model ||
        observation.modelHash !== catalogModel.modelHash || observation.kind !== "local-runtime-readiness-measurement" || observation.fullModelSha256Verified !== true ||
        observation.networkEligibilityCreated !== false || observation.productionCredentialsUsed !== false || observation.passed !== 10 || observation.total !== 10 ||
        measurement.passed !== 10 || measurement.total !== 10 || !same(observation.cases, Readiness.CASES) || observation.results?.length !== 10)
      throw Error("Readiness observation differs");
    const seen = new Set();
    for (const result of observation.results) {
      const generated = Readiness.challenge(result.id, result.nonce), identity = result.round + ":" + result.id;
      if (!Number.isInteger(result.round) || result.round < 1 || result.round > 5 || seen.has(identity) ||
          !same(result.messages, generated.messages) || result.outputHash !== hash(result.output) || !Readiness.answer(result.output, result.nonce) ||
          result.maxOutput !== 256 || result.stop !== true || !["eos", "word"].includes(result.stopType) || result.truncated !== false ||
          result.completedNaturally !== true || result.passed !== true || result.tokenizerMatch !== true || result.inputIdsHash !== result.nativeInputIdsHash ||
          !Number.isSafeInteger(result.elapsedMs) || result.elapsedMs <= 0 || result.elapsedMs > 30000) throw Error("Measured runtime-readiness result differs");
      seen.add(identity);
    }
  }
  const policies = previous.policies.map(old => ({ schema: 2, kind: Readiness.KIND, model: old.model, modelHash: old.modelHash,
    modelWeight: old.modelWeight, coverageBps: old.coverageBps, reviewedEvidenceHash: reviewHash,
    maxLatencyMs: old.maxLatencyMs, minPass: 2, renewBeforeMs: old.renewBeforeMs, retryMs: old.retryMs,
    cases: structuredClone(Readiness.CASES) }));
  return { review, reviewHash, policies };
}
function summary(policies) { return Previous.summary(policies); }
function nextRuntime(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const original = JSON.parse(bytes), c = configuration(original), { review, reviewHash, policies } = reviewed(), scope = review.scope;
  if (c.schema !== 2 || c.mode !== scope.mode || c.schedulerUrl !== scope.schedulerUrl || c.policyHash !== scope.policyHash || c.accountMode !== "public" ||
      Object.entries(scope.deployment).some(([key, value]) => c.deployment[key] !== value)) throw Error("Runtime is not the reviewed prepaid model deployment");
  const tariffs = Models.tariffs(c);
  if (tariffs.length !== policies.length) throw Error("The exact reviewed model catalog is required");
  for (const p of policies) validatePolicy(p, tariffs.find(t => t.model === p.model));
  if (c.qualificationPolicy !== undefined || !Array.isArray(c.qualificationPolicies)) throw Error("Exact catalog qualification policies required");
  const publicReview = { schema: 2, kind: Readiness.KIND, reviewHash, models: summary(policies), eligibilityCreated: false };
  if (same(c.qualificationPolicies, policies)) return { bytes, already: true, review: publicReview };
  if (!same(c.qualificationPolicies, Previous.reviewed().policies)) throw Error("Existing catalog qualification policies differ; no policy was replaced");
  original.qualificationPolicies = policies; configuration(original);
  return { bytes: Buffer.from(JSON.stringify(original, null, 2) + "\n"), already: false, review: publicReview };
}
module.exports = { reviewed, summary, nextRuntime };
