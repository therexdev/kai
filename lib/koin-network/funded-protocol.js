"use strict";
// Domain-separated rehearsal work proofs. Never a payment or transaction signature.
const P = require("./job-protocol"), D = require("./session-delegation");
function fundedResultHash(target, job, output) {
  const t = D.target(target);
  if (typeof output !== "string" || !output.length || Buffer.byteLength(output) > 1048576) throw Error("Invalid result output");
  return Buffer.from(P.hash(JSON.stringify(["KAI-KOIN-FUNDED-RESULT-REHEARSAL-V1", t.chainId, t.credits,
    t.creditsHash, t.policyHash, t.domain, P.digest(job.session), P.digest(job.id),
    P.digest(job.attempt), P.digest(job.quote.hash), P.hash(output)])), "hex");
}
function validateJob(job, catalog, now = Date.now()) {
  if (!job || Object.keys(job).sort().join() !== "attempt,deadline,dispatchedAt,id,model,paymentsEnabled,prompt,quote,session,target,type" ||
      job.type !== "koin-funded-rehearsal-chat" || job.paymentsEnabled !== false) throw Error("Invalid funded rehearsal job");
  const target = D.target(job.target); P.digest(job.session);
  const { session, target: ignored, paymentsEnabled, ...common } = job;
  const validated = P.validateJob({ ...common, type: "koin-shadow-chat" }, catalog, now);
  if (validated.quote.domain !== target.domain || validated.quote.policyHash !== target.policyHash) throw Error("Job deployment mismatch");
  return { ...validated, type: job.type, session, target, paymentsEnabled: false };
}
module.exports = { fundedResultHash, validateJob };
