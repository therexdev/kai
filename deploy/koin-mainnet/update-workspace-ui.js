"use strict";
// Forward-only UI release on the installed workspace + diagnostics runtime.
const Web = require("./update-web-api"), Diagnostics = require("./update-inference-diagnostics");
const BASE = "a0c9d9ecb80ebaf5632b052643f7298947f80f96";
const REQUIRED = [
  "lib/credit-gateway.js", "public/platform/index.html", "public/platform/platform.js",
  "public/platform/chat-ui.js", "public/platform/chat-ui.css", "public/platform/markdown-it.min.js", "public/platform/markdown-it.LICENSE.txt",
  "scripts/probe-chat-workspace.js", "scripts/probe-credit-platform-dom.js", "tests/credit-platform.browser.cjs",
  "deploy/koin-mainnet/update-workspace-ui.js", "deploy/koin-mainnet/update-web-api.test.js", "docs/ACCOUNT_WORKSPACE.md", ".github/workflows/web-accounts-api.yml"
];
const ALLOWED = new Set(REQUIRED);
const PROBES = [...new Set(["scripts/probe-chat-workspace.js", ...Diagnostics.PROBES])];
const LOCKS = ["kai-workspace-ui-update.lock", ...Diagnostics.LOCKS];
const health = Diagnostics.health;
function update(options = {}) {
  return Web.update({ ...options, checkHealth: options.checkHealth || health,
    releasePolicy: { BASE, REQUIRED, ALLOWED, PROBES, LOCKS, PLAN_PREFIX: "kai-workspace-ui" } });
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root; no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, BASE, REQUIRED, ALLOWED, PROBES, LOCKS, UNIT: Web.UNIT, PATHS: Web.PATHS };
