"use strict";
// Reuse the verified forward-only updater: same journals, clean stop, snapshot,
// writer leases and recovery plan. Only the release's source boundary changes.
const Web = require("./update-web-api");
const BASE = "697ff9721e55c76487f21eae484c60f2f653fb5e";
const REQUIRED = [
  "lib/credit-account-web.js", "lib/credit-gateway.js", "test-server.js",
  "public/platform/index.html", "public/platform/platform.js", "public/platform/platform.css",
  "public/platform/account-routes.js", "public/platform/account-settings.js", "public/platform/login.html", "public/platform/login.js",
  "scripts/probe-account-dashboard.js", "scripts/probe-credit-gateway.js", "scripts/probe-credit-platform-dom.js", "tests/credit-platform.browser.cjs",
  "deploy/koin-mainnet/update-web-api.js", "deploy/koin-mainnet/update-web-api.test.js", "deploy/koin-mainnet/update-account-ui.js", "docs/ACCOUNT_DASHBOARD.md"
];
const ALLOWED = new Set([...REQUIRED, ".github/workflows/web-accounts-api.yml"]);
const PROBES = ["scripts/probe-accounts.js", "scripts/probe-credit-account-web.js", "scripts/probe-account-dashboard.js", "scripts/probe-credit-gateway.js", "scripts/probe-credit-platform-dom.js", "deploy/koin-mainnet/update-web-api.test.js"];
const LOCKS = ["kai-account-ui-update.lock", ...Web.LOCKS];
async function health({ fetchImpl = fetch, ...options } = {}) {
  return Web.health({ ...options, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!url.endsWith("/health") || !response.ok) return response;
    const body = await response.text();
    if (Buffer.byteLength(body) > 32768 || JSON.parse(body).accountUiVersion !== 1) throw Error("Unified account dashboard is not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
function update(options = {}) {
  return Web.update({ ...options, checkHealth: options.checkHealth || health, releasePolicy: { BASE, REQUIRED, ALLOWED, PROBES, LOCKS, PLAN_PREFIX: "kai-account-ui" } });
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root; no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, BASE, REQUIRED, ALLOWED, PROBES, LOCKS, UNIT: Web.UNIT, PATHS: Web.PATHS };
