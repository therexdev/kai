"use strict";
// Use the existing forward-only code updater, its clean drain, consistent state
// snapshot, writer leases and resumable deployment plan. No ledger migration.
const Web = require("./update-web-api");
const BASE = "438b1359d39576bf27325810022058424bbd6e3f";
const REQUIRED = [
  "lib/credit-gateway.js", "lib/koin-network/free-credits.js", "lib/koin-network/model-catalog.js",
  "lib/koin-network/network-overview.js", "lib/koin-network/prepaid-ledger.js", "lib/koin-network/prepaid-router.js",
  "lib/koin-network/test-runtime.js", "lib/scheduler.js", "test-server.js",
  "lib/koin-network/managed-models.json", "lib/koin-network/managed-protocol.js", "lib/koin-network/managed-provider.js",
  "lib/koin-network/managed-public-status.js", "scripts/probe-managed-http.js", "scripts/probe-managed-inference.js",
  "deploy/koin-mainnet/check-akashml.js", "deploy/koin-mainnet/update-managed-inference.js", "deploy/koin-mainnet/AKASHML.md"
];
const ALLOWED = new Set([...REQUIRED, ".github/workflows/managed-inference.yml"]);
const PROBES = ["scripts/probe-managed-inference.js", "scripts/probe-managed-http.js", "scripts/probe-koin-prepaid.js",
  "scripts/probe-koin-free-credits.js", "scripts/probe-koin-model-catalog.js", "scripts/probe-credit-gateway.js",
  "scripts/probe-koin-public-stream.js", "scripts/probe-koin-credit-stream.js", "deploy/koin-mainnet/update-web-api.test.js"];
const LOCKS = ["kai-managed-inference-update.lock", ...Web.LOCKS];
async function health({ fetchImpl = fetch, ...options } = {}) {
  return Web.health({ ...options, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!url.endsWith("/health") || !response.ok) return response;
    const body = await response.text();
    if (Buffer.byteLength(body) > 32768 || JSON.parse(body).managedInferenceVersion !== 1) throw Error("Managed network inference code is not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
function update(options = {}) {
  return Web.update({ ...options, checkHealth: options.checkHealth || health,
    releasePolicy: { BASE, REQUIRED, ALLOWED, PROBES, LOCKS, PLAN_PREFIX: "kai-managed-inference" } });
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root; no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, BASE, REQUIRED, ALLOWED, PROBES, LOCKS, UNIT: Web.UNIT, PATHS: Web.PATHS };
