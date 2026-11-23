"use strict";
// Forward-only rollout on the existing Android-account installation.
// Reuse its drain, stopped-state snapshot, writer checks and recovery plan.
const Web = require("./update-web-api");
const BASE = "1622f662dbea16c6cbd874f3be07e5be8983bb58";
const BASES = [BASE];
const REQUIRED = [
  "lib/accounts.js", "lib/credit-account-web.js", "lib/credit-gateway.js", "lib/credit-vault.js", "lib/workspace-sso.js", "lib/credit-wallet-links.js", "lib/credit-api-keys.js", "lib/koin-network/prepaid-router.js", "test-server.js",
  "public/platform/account-routes.js", "public/platform/index.html", "public/platform/login.js", "public/platform/platform.css", "public/platform/platform.js",
  "scripts/probe-accounts.js", "scripts/probe-workspace-links.js", "scripts/probe-credit-wallet-links.js", "scripts/probe-credit-vault.js", "scripts/probe-account-dashboard.js", "scripts/probe-credit-platform-dom.js", "public/platform/account-settings.js", "tests/credit-platform.browser.cjs",
  "scripts/probe-koin-public-stream.js", "deploy/koin-mainnet/update-workspace.js", "deploy/koin-mainnet/update-web-api.test.js", "docs/ACCOUNT_WORKSPACE.md"
];
const ALLOWED = new Set([...REQUIRED, ".github/workflows/web-accounts-api.yml", "docs/ACCOUNT_DASHBOARD.md"]);
const PROBES = ["scripts/probe-accounts.js", "scripts/probe-workspace-links.js", "scripts/probe-credit-wallet-links.js", "scripts/probe-account-dashboard.js",
  "scripts/probe-credit-account-web.js", "scripts/probe-credit-platform-dom.js", "scripts/probe-credit-gateway.js",
  "scripts/probe-wallet-credit-router.js", "scripts/probe-koin-device-free-router.js", "scripts/probe-credit-vault.js", "deploy/koin-mainnet/update-web-api.test.js"];
const LOCKS = ["kai-workspace-update.lock", ...require("./update-android-account").LOCKS];
async function health({ fetchImpl = fetch, ...options } = {}) {
  return Web.health({ ...options, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!url.endsWith("/health") || !response.ok) return response;
    const body = await response.text();
    if (Buffer.byteLength(body) > 32768) throw Error("Oversized workspace health response");
    const value = JSON.parse(body);
    if (value.workspaceUiVersion !== 1 || value.workspaceSsoVersion !== 1 || value.deviceLinkRecoveryVersion !== 2 || value.creditWalletLinksVersion !== 1 || value.nativeAccountVersion !== 1)
      throw Error("Workspace and account-link recovery are not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
async function update(options = {}) {
  const paths = options.paths || Web.PATHS;
  const run = options.run || ((exe, args, cwd) => require("node:child_process").execFileSync(exe, args, { cwd, encoding: "utf8" }));
  const active = run("systemctl", ["show", Web.UNIT, "--value", "--property=WorkingDirectory"]).trim();
  const installed = BASES.find(sha => active === require("node:path").join(paths.releases, sha));
  // A partially completed rollout uses its saved target; the underlying updater
  // still verifies the exact recorded base, source, unit and state fingerprint.
  let base = installed;
  if (!base) {
    const target = run("git", ["rev-parse", "HEAD"], options.repo || process.cwd(), true).trim();
    if (active !== require("node:path").join(paths.releases, target)) throw Error("Unexpected installed workspace base: " + active + ". Expected Android account release " + BASE + "; preserve the current service and review its revision before updating.");
    const file = require("node:path").join(paths.work, "kai-workspace-plan-" + target + ".json"), fs = require("node:fs"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw Error("Unsafe workspace recovery plan");
    const plan = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!BASES.includes(plan.base)) throw Error("Unrecognized workspace recovery base");
    base = plan.base;
  }
  return Web.update({ ...options, checkHealth: options.checkHealth || health,
    releasePolicy: { BASE: base, REQUIRED, ALLOWED, PROBES, LOCKS, PLAN_PREFIX: "kai-workspace" } });
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root; no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, BASE, BASES, REQUIRED, ALLOWED, PROBES, LOCKS, UNIT: Web.UNIT, PATHS: Web.PATHS };
