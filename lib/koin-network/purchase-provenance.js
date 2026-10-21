"use strict";
// Shared with the desktop. This commitment supplements, never replaces, the
// contract's normal signed PurchaseQuote verification. No RPC URLs are public.
const crypto = require("node:crypto"), { MARKET } = require("./purchase-market");
const KIND = "KAI-USD-QUOTE-PROVENANCE-V1", HEX = /^[0-9a-f]{64}$/;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value, depth = 0) {
  if (depth > 24) throw Error("Purchase evidence is too deeply nested");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.length <= 4096 && !/https?:\/\//i.test(value)) return value;
  if (Array.isArray(value) && value.length <= 8192) return value.map(v => canonical(v, depth + 1));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    if (keys.length > 128 || keys.some(k => /^(?:rpcUrls?|url|password|secret|apiKey|authorization)$/i.test(k))) throw Error("Purchase evidence contains private connection fields");
    return Object.fromEntries(keys.map(k => [k, canonical(value[k], depth + 1)]));
  }
  throw Error("Invalid or private purchase evidence");
}
function evidence(value) {
  const normalized = canonical(value), text = JSON.stringify(normalized);
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error("Purchase evidence exceeds archive bound");
  return { value: normalized, text, hash: digest("KAI-USD-PRICE-EVIDENCE-V1\0" + text) };
}
function exact(value, fields) {
  if (!value || Object.keys(value).sort().join() !== fields.split(",").sort().join()) throw Error("Exact purchase provenance required");
}
function summary(value) {
  exact(value, "schema,market,referenceKind,usdPerKoinAtoms,marketObservedAt,expiresAt,windowSeconds,anchorHash,pricingPolicyHash,referenceHash,maxPurchaseUsdAtoms,maxPurchaseKoinAtoms");
  exact(value.market, "chainId,protocol,poolId");
  if (value.schema !== 1 || value.market.chainId !== MARKET.chainId || value.market.protocol !== MARKET.protocol || value.market.poolId !== MARKET.poolId ||
      !["merchant-exchange-reference", "signed-parity"].includes(value.referenceKind) ||
      !/^0x[0-9a-f]{64}$/.test(value.anchorHash) || !HEX.test(value.pricingPolicyHash) || !HEX.test(value.referenceHash)) throw Error("Pinned purchase provenance required");
  for (const k of ["usdPerKoinAtoms", "maxPurchaseUsdAtoms", "maxPurchaseKoinAtoms"])
    if (typeof value[k] !== "string" || !/^[1-9]\d{0,19}$/.test(value[k]) || BigInt(value[k]) >= 1n << 64n) throw Error("Canonical purchase provenance amounts required");
  for (const k of ["marketObservedAt", "expiresAt", "windowSeconds"])
    if (!Number.isSafeInteger(value[k]) || value[k] < 1) throw Error("Purchase provenance time required");
  if (value.marketObservedAt >= value.expiresAt || value.windowSeconds > 86400) throw Error("Invalid purchase provenance window");
  return canonical(value);
}
function details(value) {
  exact(value, "schema,kind,nonce,evidenceHash,summary");
  if (value.schema !== 1 || value.kind !== KIND || !HEX.test(value.nonce) || !HEX.test(value.evidenceHash)) throw Error("Versioned purchase provenance required");
  return { schema: 1, kind: KIND, nonce: value.nonce, evidenceHash: value.evidenceHash, summary: summary(value.summary) };
}
function quoteId(value) {
  const d = details(value);
  return require("koilib").utils.encodeBase64url(Buffer.from(digest(JSON.stringify([KIND, d.nonce, d.evidenceHash, d.summary])), "hex"));
}
function verify(q, value, { expectedPricingPolicyHash } = {}) {
  const d = details(value), s = d.summary;
  if (q.id !== quoteId(d) || q.usd_per_koin !== s.usdPerKoinAtoms || BigInt(q.expires_at) > BigInt(s.expiresAt) ||
      BigInt(q.issued_at) < BigInt(s.marketObservedAt) || BigInt(q.amount) > BigInt(s.maxPurchaseKoinAtoms) ||
      BigInt(q.credits) > BigInt(s.maxPurchaseUsdAtoms) ||
      (expectedPricingPolicyHash !== undefined && expectedPricingPolicyHash !== s.pricingPolicyHash)) throw Error("Purchase price details do not match the signed quote");
  return d;
}
module.exports = { KIND, digest, canonical, evidence, summary, details, quoteId, verify };
