"use strict";
// Diagnostics-only release, pinned to the account API release confirmed active
// by the operator. Reuse the existing drain, snapshot and financial-state guards.
const Web = require("./update-web-api"), Android = require("./update-android-account"), Managed = require("./update-managed-inference");
const BASE = "1622f662dbea16c6cbd874f3be07e5be8983bb58";
const REQUIRED = ["lib/koin-network/inference-diagnostics.js", "lib/koin-network/managed-provider.js", "lib/koin-network/prepaid-ledger.js", "lib/koin-network/prepaid-router.js", "lib/credit-gateway.js", "test-server.js", "scripts/helpers/credit-gateway-fixture.js", "scripts/probe-inference-diagnostics.js", "deploy/koin-mainnet/update-inference-diagnostics.js", "deploy/koin-mainnet/update-web-api.test.js", "docs/INFERENCE_DIAGNOSTICS.md"];
const ALLOWED = new Set([...REQUIRED, ".github/workflows/inference-diagnostics.yml"]);
const PROBES = [...new Set(["scripts/probe-inference-diagnostics.js", ...Managed.PROBES, ...Android.PROBES])];
const LOCKS = [...new Set(["kai-inference-diagnostics-update.lock", ...Managed.LOCKS, ...Android.LOCKS])];
async function health({ fetchImpl = fetch, ...options } = {}) {
  return Android.health({ ...options, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!url.endsWith("/health") || !response.ok) return response;
    const body = await response.text();
    if (body.length > 32768 || JSON.parse(body).inferenceDiagnosticsVersion !== 1) throw Error("Inference error diagnostics are not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
function update(options = {}) {
  return Web.update({ ...options, checkHealth: options.checkHealth || health, releasePolicy: { BASE, REQUIRED, ALLOWED, PROBES, LOCKS, PLAN_PREFIX: "kai-inference-diagnostics" } });
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root; no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, BASE, REQUIRED, ALLOWED, PROBES, LOCKS, UNIT: Web.UNIT, PATHS: Web.PATHS };
