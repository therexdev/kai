"use strict";
// Provider proofs bind the explicitly approved network mode and deployment.
const { protocol } = require("./payment-network");
const P = require("./job-protocol"), D = require("./session-delegation");
function fundedResultHash(target, job, output) {
  const t = D.target(target);
  if (typeof output !== "string" || !output.length || Buffer.byteLength(output) > 1048576) throw Error("Invalid result output");
  return Buffer.from(P.hash(JSON.stringify([`KAI-KOIN-FUNDED-RESULT-${protocol(t).signingTag}-V1`, t.chainId, t.credits,
    t.creditsHash, t.policyHash, t.domain, P.digest(job.session), P.digest(job.id),
    P.digest(job.attempt), P.digest(job.quote.hash), P.hash(output)])), "hex");
}
function fundedChunkHash(target, job, output, sequence) {
  P.integer(sequence, 1, 4096);
  return Buffer.from(P.hash(JSON.stringify(["KAI-METERED-CHUNK-V1", sequence,
    fundedResultHash(target, job, output).toString("hex")])), "hex");
}
function validateJob(job, catalog, now = Date.now()) {
  const streaming = job?.stream === true;
  if (job && Object.hasOwn(job, "stream")) {
    if (!streaming) throw Error("Invalid metered stream flag");
    const { stream, ...rest } = job; job = rest;
  }
  if (!job || Object.keys(job).sort().join() !== "attempt,deadline,dispatchedAt,id,model,paymentsEnabled,prompt,quote,session,target,type" ||
      job.type !== protocol(job.target).jobType || job.paymentsEnabled !== protocol(job.target).paymentsEnabled) throw Error("Invalid funded rehearsal job");
  const target = D.target(job.target); P.digest(job.session);
  const { session, target: ignored, paymentsEnabled, ...common } = job;
  const validated = P.validateJob({ ...common, type: "koin-shadow-chat" }, catalog, now);
  if (validated.quote.domain !== target.domain || validated.quote.policyHash !== target.policyHash) throw Error("Job deployment mismatch");
  return { ...validated, type: job.type, session, target, paymentsEnabled: protocol(target).paymentsEnabled, ...(streaming ? { stream: true } : {}) };
}
module.exports = { fundedResultHash, fundedChunkHash, validateJob };
