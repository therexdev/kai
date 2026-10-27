"use strict";
const P = require("./job-protocol"), Q = require("./qualification-protocol"), D = require("./session-delegation");
// These are all fields used by qualification-protocol.resultHash. Retaining
// them permits signature re-verification without retaining customer prompts.
// It does not prove the correctness of the answer represented by outputHash.
function signedMaterial(job) {
  return { schema: 1, target: D.target(job.target), policyHash: P.digest(job.policyHash), jobId: P.digest(job.challenge.id),
    attempt: P.digest(job.challenge.attempt), quoteHash: P.digest(job.challenge.quote.hash) };
}
function verifyResult(result, expected) {
  if (!result || typeof result !== "object") throw Error("Qualification result required");
  if (!Object.hasOwn(result, "signedMaterial")) return { state: "unavailable", reason: result.reason === "deadline" ? "no-signed-answer" : "legacy-result-no-signed-material", qualityReplayed: false };
  const m = result.signedMaterial;
  if (!m || Object.keys(m).sort().join() !== "attempt,jobId,policyHash,quoteHash,schema,target" || m.schema !== 1) throw Error("Exact qualification signature material required");
  const target = D.target(m.target), wanted = D.target(expected?.target);
  if (JSON.stringify(target) !== JSON.stringify(wanted) || P.digest(m.policyHash) !== P.digest(expected?.policyHash) ||
      P.digest(m.jobId) !== P.digest(result.id)) throw Error("Qualification evidence pins changed");
  const job = { target, policyHash: m.policyHash, challenge: { id: m.jobId, attempt: P.digest(m.attempt), quote: { hash: P.digest(m.quoteHash) } } };
  if (typeof result.signature === "string" && result.signature.startsWith("pd1.")) {
    const devices = require("./provider-device-protocol"), proof = devices.decodeAction(result.signature);
    devices.verifyAction(result.signature, "qualification", Q.resultHash(job, P.digest(result.outputHash)), { target, wallet: expected.address,
      schedulerUrl: expected.schedulerUrl ?? proof.authorization.schedulerUrl, now: expected.now ?? Date.now(), historical: true, completedAt: result.at });
  } else P.signatureMatches(Q.resultHash(job, P.digest(result.outputHash)), result.signature, expected.address);
  return { state: "signature-verified", qualityReplayed: false };
}
module.exports = { signedMaterial, verifyResult };
