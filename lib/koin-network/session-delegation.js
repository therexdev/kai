"use strict";
// This signature authorizes only funded-accounting rehearsal. It must never be
// accepted as an on-chain transaction, live payment, or legacy spend grant.
const P = require("./job-protocol"), { utils } = require("koilib");
const DAY = 86400000;
function identity(v) {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v)) throw Error("Invalid account identity");
  return v;
}
function amount(v) {
  if (typeof v !== "string" || !/^[1-9]\d{0,19}$/.test(v) || BigInt(v) > (1n << 64n) - 1n) throw Error("Invalid spending limit");
  return v;
}
function target(value) {
  if (!value || Object.keys(value).sort().join() !== "chainId,credits,creditsHash,domain,policyHash") throw Error("Pinned deployment required");
  const { chainId, credits, creditsHash, domain, policyHash } = value;
  if (typeof chainId !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(chainId) ||
      !/^1220[a-f0-9]{64}$/.test(Buffer.from(chainId, "base64url").toString("hex")) ||
      utils.encodeBase64url(Buffer.from(chainId, "base64url")) !== chainId ||
      typeof credits !== "string" || !utils.isChecksumAddress(credits) ||
      typeof creditsHash !== "string" || !/^0x1220[a-f0-9]{64}$/.test(creditsHash)) throw Error("Invalid deployment pins");
  return { chainId, credits, creditsHash, domain: P.domain(domain), policyHash: P.digest(policyHash) };
}
function terms(value) {
  if (!value || Object.keys(value).sort().join() !== "accountId,amount,expires,grantId,issuedAt,maxJobs,maxOutput,mode,model,nonce,owner,perJob,schema,session,target,version" ||
      value.schema !== 1 || value.mode !== "funded-rehearsal") throw Error("Invalid session delegation");
  const v = value;
  if (typeof v.owner !== "string" || !utils.isChecksumAddress(v.owner) || typeof v.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(v.model)) throw Error("Invalid owner or model");
  amount(v.amount); amount(v.perJob);
  if (BigInt(v.perJob) > BigInt(v.amount)) throw Error("Per-request limit exceeds session budget");
  P.integer(v.issuedAt); P.integer(v.expires, v.issuedAt + 1, v.issuedAt + DAY);
  return { schema: 1, mode: "funded-rehearsal", target: target(v.target), session: P.digest(v.session), owner: v.owner,
    accountId: identity(v.accountId), grantId: identity(v.grantId), model: v.model, version: P.integer(v.version, 1),
    maxOutput: P.integer(v.maxOutput, 1, 2000000), amount: v.amount, perJob: v.perJob, maxJobs: P.integer(v.maxJobs, 1, 10000),
    issuedAt: v.issuedAt, expires: v.expires, nonce: P.digest(v.nonce) };
}
const hash = value => Buffer.from(P.hash(JSON.stringify(["KAI-KOIN-FUNDED-SESSION-DELEGATION-REHEARSAL-V1", terms(value)])), "hex");
const id = value => hash(value).toString("hex");
function verify(value, signature) { const t = terms(value); P.signatureMatches(hash(t), signature, t.owner); return t; }
function tariff(value, policy) {
  const t = terms(value);
  if (!Array.isArray(policy) || !policy.length || policy.length > 64) throw Error("Pinned tariff policy required");
  const list = policy.map(item => Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))));
  list.sort((a, b) => `${a.model}:${a.version}` < `${b.model}:${b.version}` ? -1 : 1);
  if (P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", ...list])) !== t.target.policyHash) throw Error("Displayed tariff differs from the pinned policy");
  const selected = list.filter(item => item.model === t.model && item.version === t.version);
  if (selected.length !== 1) throw Error("Model tariff missing or duplicated");
  const rate = selected[0]; amount(rate.inputAtomsPerMillion); amount(rate.outputAtomsPerMillion);
  P.integer(t.maxOutput, 1, rate.maxOutputTokens);
  return rate;
}
module.exports = { identity, amount, target, terms, hash, id, verify, tariff };
