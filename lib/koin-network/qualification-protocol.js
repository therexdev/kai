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
function validatePreparation(job, catalog, pinned, now = Date.now()) {
  if (!job || Object.keys(job).sort().join() !== "expiresAt,issuedAt,model,modelHash,policyHash,target,type" || job.type !== "koin-provider-prepare") throw Error("Exact provider preparation required");
  const target = D.target(job.target);
  if (JSON.stringify(target) !== JSON.stringify(D.target(pinned))) throw Error("Preparation target changed");
  P.digest(job.policyHash); P.digest(job.modelHash); P.integer(now); P.integer(job.issuedAt);
  P.integer(job.expiresAt, job.issuedAt + 1, job.issuedAt + 120000);
  if (now < job.issuedAt - 60000 || now >= job.expiresAt) throw Error("Expired provider preparation");
  const def = catalog?.aliases?.[job.model], pack = catalog?.packages?.[def?.package];
  if (typeof job.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(job.model) || job.model.startsWith("dev-") ||
      !def || def.custom || def.dev || pack?.custom || pack?.dev || pack?.sha256 !== job.modelHash) throw Error("Preparation requires an approved public model");
  return { ...job, target };
}
module.exports = { validate, resultHash, validatePreparation };
