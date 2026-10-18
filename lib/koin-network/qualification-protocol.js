"use strict";
const P = require("./job-protocol"), D = require("./session-delegation");
function validate(job, catalog, pinned, now = Date.now()) {
  if (!job || Object.keys(job).sort().join() !== "challenge,policyHash,target,type" || job.type !== "koin-provider-qualification") throw Error("Exact qualification challenge required");
  const target = D.target(job.target);
  if (JSON.stringify(target) !== JSON.stringify(D.target(pinned))) throw Error("Qualification target changed");
  P.digest(job.policyHash); const challenge = P.validateJob(job.challenge, catalog, now);
  if (challenge.quote.domain !== target.domain || challenge.quote.policyHash !== target.policyHash) throw Error("Qualification model policy changed");
  return { ...job, challenge, target };
}
function resultHash(job, outputHash) {
  return Buffer.from(P.hash(JSON.stringify(["KAI-PROVIDER-QUALIFICATION-V1", D.target(job.target), P.digest(job.policyHash),
    P.digest(job.challenge.id), P.digest(job.challenge.attempt), P.digest(job.challenge.quote.hash), P.digest(outputHash)])), "hex");
}
module.exports = { validate, resultHash };
