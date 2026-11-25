"use strict";
const Web = require("./update-web-api"), Prior = require("./update-inference-diagnostics");
const BASE = "75dc78be85b0f72112fb21432140149ae935d002";
const REQUIRED = ["lib/koin-network/purchase-limits.js", "lib/koin-network/purchase-price.js", "lib/koin-network/purchase-quote-journal.js", "lib/koin-network/v4-price-validation.js", "test-server.js", "scripts/probe-koin-merchant-reference.js", "scripts/probe-koin-purchase-journal.js", "deploy/koin-mainnet/update-purchase-limit.js", "deploy/koin-mainnet/PURCHASE_LIMIT.md", "V4_PURCHASE_PRICING.md"];
const ALLOWED = new Set([...REQUIRED, "scripts/probe-koin-purchase-preflight.js", "deploy/koin-mainnet/update-purchase-limit.test.js", ".github/workflows/purchase-limit.yml"]);
const PROBES = [...new Set([...Prior.PROBES, "scripts/probe-koin-purchase-price.js", "scripts/probe-koin-merchant-reference.js", "scripts/probe-koin-v4-price-validation.js", "scripts/probe-koin-v4-history-reader.js", "scripts/probe-koin-v4-purchase-oracle.js", "scripts/probe-koin-purchase-journal.js", "scripts/probe-purchase-quotes-http.js", "scripts/probe-koin-purchase-preflight.js", "deploy/koin-mainnet/update-purchase-limit.test.js"])];
const LOCKS = ["kai-purchase-limit-update.lock", ...Prior.LOCKS];
async function health({ fetchImpl = fetch, ...options } = {}) {
  return Prior.health({ ...options, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!url.endsWith("/health") || !response.ok) return response;
    const body = await response.text();
    if (Buffer.byteLength(body) > 32768) throw Error("Oversized purchase-limit health response");
    const h = JSON.parse(body);
    if (h.creditPurchaseLimitVersion !== 1 || h.maxCreditPurchaseUsd !== "1000") throw Error("The $1,000 credit purchase limit is not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
function update(options = {}) {
  return Web.update({ ...options, checkHealth: options.checkHealth || health,
    releasePolicy: { BASE, REQUIRED, ALLOWED, PROBES, LOCKS, PLAN_PREFIX: "kai-purchase-limit" } });
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root; no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, BASE, REQUIRED, ALLOWED, PROBES, LOCKS };
