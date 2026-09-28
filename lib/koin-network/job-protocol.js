"use strict";
const crypto = require("crypto");
const { Signer, utils } = require("koilib");
const hash = (v) => crypto.createHash("sha256").update(v).digest("hex");
const digest = (v) => {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw Error("Invalid digest");
  return v;
};
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw Error("Invalid integer");
  return v;
};
const domain = (v) => {
  if (typeof v !== "string" || !/^shadow:[a-zA-Z0-9._-]{1,100}$/.test(v)) throw Error("Shadow domain required");
  return v;
};
function messages(value) {
  if (!Array.isArray(value) || !value.length || value.length > 256) throw Error("Invalid messages");
  const clean = value.map((m) => {
    if (!m || Object.keys(m).sort().join() !== "content,role" ||
        !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") throw Error("Literal messages required");
    return { role: m.role, content: m.content };
  });
  if (Buffer.byteLength(JSON.stringify(clean)) > 65536) throw Error("Prompt too large");
  return clean;
}
function authorizeHash(scope, session, job, quoteHash) {
  return Buffer.from(hash(JSON.stringify(["KAI-KOIN-SHADOW-REQUEST-V1", domain(scope),
    digest(session), digest(job), digest(quoteHash)])), "hex");
}
function resultHash(scope, job, attempt, quoteHash, output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 1048576) throw Error("Output too large");
  return Buffer.from(hash(JSON.stringify(["KAI-KOIN-SHADOW-RESULT-V1", domain(scope),
    digest(job), digest(attempt), digest(quoteHash), hash(output)])), "hex");
}
function signatureMatches(bytes, signature, expected) {
  if (typeof signature !== "string" || Buffer.from(signature, "base64").length !== 65 ||
      Buffer.from(signature, "base64").toString("base64") !== signature) throw Error("Invalid signature");
  if (Signer.recoverAddress(bytes, Buffer.from(signature, "base64")) !== expected) throw Error("Signature mismatch");
}
const tariffKeys = "contextTokens,inputAtomsPerMillion,maxLatencyMs,maxOutputTokens,model,modelHash,outputAtomsPerMillion,templateHash,tokenizerHash,version";
function validateQuote(q) {
  if (!q || Object.keys(q).sort().join() !== "at,domain,expires,hash,inputIdsHash,inputTokens,maxCharge,maxOutput,mode,policyHash,promptHash,requestHash,schema,tariff" ||
      q.schema !== 2 || q.mode !== "shadow" || !q.tariff || Object.keys(q.tariff).sort().join() !== tariffKeys) throw Error("Invalid shadow quote");
  const t = Object.fromEntries(Object.entries(q.tariff).sort(([a], [b]) => a.localeCompare(b)));
  domain(q.domain); [q.hash, q.policyHash, q.promptHash, q.inputIdsHash, q.requestHash, t.modelHash, t.tokenizerHash, t.templateHash].forEach(digest);
  if (typeof t.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(t.model)) throw Error("Invalid model");
  integer(t.version, 1); integer(t.contextTokens, 1, 2000000); integer(t.maxOutputTokens, 1, t.contextTokens);
  integer(t.maxLatencyMs, 1, 300000); integer(q.inputTokens, 1, t.contextTokens);
  integer(q.maxOutput, 1, t.maxOutputTokens); integer(q.at); integer(q.expires, q.at + 300000, q.at + 300000);
  if (q.inputTokens + q.maxOutput > t.contextTokens) throw Error("Context limit exceeded");
  for (const v of [t.inputAtomsPerMillion, t.outputAtomsPerMillion, q.maxCharge]) {
    if (typeof v !== "string" || !/^[1-9]\d{0,19}$/.test(v) || BigInt(v) > (1n << 64n) - 1n) throw Error("Invalid atom amount");
  }
  const max = (BigInt(q.inputTokens) * BigInt(t.inputAtomsPerMillion) + BigInt(q.maxOutput) * BigInt(t.outputAtomsPerMillion) + 999999n) / 1000000n;
  if (String(max) !== q.maxCharge) throw Error("Quote price mismatch");
  const canonical = { schema: 2, mode: "shadow", domain: q.domain, policyHash: q.policyHash, tariff: t,
    requestHash: q.requestHash, promptHash: q.promptHash, inputIdsHash: q.inputIdsHash, inputTokens: q.inputTokens, maxOutput: q.maxOutput,
    maxCharge: q.maxCharge, at: q.at, expires: q.expires };
  if (hash(JSON.stringify(canonical)) !== q.hash) throw Error("Quote commitment mismatch");
  return { ...canonical, hash: q.hash };
}
function validateJob(job, catalog, now = Date.now()) {
  if (!job || Object.keys(job).sort().join() !== "attempt,deadline,dispatchedAt,id,model,prompt,quote,type" || job.type !== "koin-shadow-chat") throw Error("Invalid shadow job");
  digest(job.id); digest(job.attempt);
  const q = validateQuote(job.quote), def = catalog?.aliases?.[job.model], pack = catalog?.packages?.[def?.package];
  if (!def || def.custom || def.dev || pack?.custom || pack?.sha256 !== q.tariff.modelHash || job.model !== q.tariff.model) throw Error("Shadow job requires an approved public model");
  if (typeof job.prompt !== "string" || Buffer.byteLength(job.prompt) > 131072 || hash(job.prompt) !== q.promptHash) throw Error("Prompt commitment mismatch");
  integer(job.dispatchedAt, q.at, q.expires - 1);
  integer(job.deadline, job.dispatchedAt + 1, job.dispatchedAt + q.tariff.maxLatencyMs);
  if (now < job.dispatchedAt - 60000 || now >= job.deadline) throw Error("Expired shadow job");
  return { ...job, quote: q };
}
module.exports = { hash, digest, integer, domain, messages, authorizeHash, resultHash, signatureMatches, validateQuote, validateJob };
