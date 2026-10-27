"use strict";
// Code-only removal of daily quote allowances. Configuration and every account,
// payment, reward and quote journal remain in place, including during rollback.
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { configDigest } = require("./update-prepaid-web");
const { validateUnit, runtimeTarget, health: walletHealth, UNIT, PATHS } = require("./update-wallet-access");
const BASE = "a8edc3bd6d21c40cebe175f7ead36844900b2b7c";
const ALLOWED = new Set([
  "lib/koin-network/purchase-quote-journal.js", "lib/koin-network/test-config.js", "lib/koin-network/test-runtime.js", "test-server.js",
  "deploy/koin-test/setup.js", "scripts/probe-koin-purchase-journal.js", "scripts/probe-koin-multi-model-deployment.js",
  "deploy/koin-mainnet/update-purchase-quotes.js", "deploy/koin-mainnet/update-purchase-quotes.test.js",
  "scripts/probe-purchase-quotes-http.js", "deploy/koin-mainnet/PURCHASE_QUOTES_UPDATE.md", "deploy/koin-mainnet/PREPAID.md",
  "deploy/koin-mainnet/ACTIVATION_REVIEW.md", "deploy/koin-mainnet/settings.prepaid-usd.models.example.json", "V4_PURCHASE_PRICING.md", ".github/workflows/koin-pilot.yml",
]);
const REQUIRED = ["lib/koin-network/purchase-quote-journal.js", "test-server.js", "scripts/probe-koin-purchase-journal.js", "deploy/koin-mainnet/update-purchase-quotes.js"];
const PROBES = ["scripts/probe-koin-purchase-journal.js", "scripts/probe-purchase-quotes-http.js", "scripts/probe-koin-multi-model-deployment.js", "scripts/probe-koin-purchase-fairness.js", "scripts/probe-koin-prepaid.js", "scripts/probe-wallet-credit-router.js", "deploy/koin-mainnet/update-purchase-quotes.test.js"];
function command(exe, args, cwd, capture = false) {
  return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || "";
}
function real(file, directory) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw Error("Expected a real prepaid service " + (directory ? "directory" : "file"));
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function health({ unlimited = true, fetchImpl = fetch, ...options } = {}) {
  return walletHealth({ ...options, capabilities: true, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!unlimited || !url.endsWith("/health") || !response.ok) return response;
    const body = await response.text();
    if (Buffer.byteLength(body) > 32768 || JSON.parse(body).purchaseQuotesUnlimited !== true) throw Error("Unlimited purchase quotes are not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
async function update({ repo = process.cwd(), paths: p = PATHS, run = command, checkHealth = health, log = console.log } = {}) {
  for (const dir of [p.work, p.releases, p.config, p.state]) real(dir, true);
  const lock = path.join(p.work, "kai-purchase-quotes-update.lock"); fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
    if (!/^[a-f0-9]{40}$/.test(target) || target === BASE || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Use the clean reviewed purchase-quote checkout");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (REQUIRED.some(name => !changed.includes(name)) || changed.some(name => !ALLOWED.has(name))) throw Error("Only the reviewed purchase-quote update can be installed");
    const show = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key], undefined, true).trim();
    const current = show("WorkingDirectory"), targetDir = path.join(p.releases, target), oldDir = path.join(p.releases, BASE);
    if (![oldDir, targetDir].includes(current) || show("ActiveState") !== "active" || show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected prepaid service version or overrides; service unchanged");
    real(p.unit, false); real(current, true);
    const oldUnit = fs.readFileSync(p.unit), nextUnit = validateUnit(oldUnit, p, current, targetDir);
    const expected = runtimeTarget(path.join(p.config, "runtime.json")), digest = configDigest(p.config);
    const ready = { expected, paths: p, unlimited: true };
    if (current === targetDir) {
      await checkHealth(ready); log("Unlimited purchase quotes are already installed and verified: " + target);
      return { installed: true, unchanged: true, commit: target };
    }
    if (fs.existsSync(targetDir)) throw Error("Target release already exists; preserve it for review");
    // These isolated regressions never open live databases or submit a payment.
    run(process.execPath, ["--test", ...PROBES], repo);
    const mode = fs.statSync(p.unit).mode & 0o777;
    const backup = fs.mkdtempSync(path.join(p.work, "kai-purchase-quotes-code-")); fs.chmodSync(backup, 0o700);
    fs.writeFileSync(path.join(backup, "previous.service"), oldUnit, { mode: 0o600 });
    const archive = path.join(backup, "source.tar"); run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
    const unchanged = bytes => { real(p.unit, false); return fs.readFileSync(p.unit).equals(bytes) && configDigest(p.config) === digest; };
    const preserveUnused = () => {
      if (fs.existsSync(targetDir) && unchanged(oldUnit) && show("WorkingDirectory") === current && show("ActiveState") === "active") {
        fs.renameSync(targetDir, path.join(backup, "unused-release")); syncDirectory(p.releases);
      }
    };
    const stage = fs.mkdtempSync(path.join(p.releases, ".quotes-" + target + "-")); fs.chmodSync(stage, 0o755);
    try {
      const mask = process.umask(0o022);
      try { run("tar", ["-xf", archive, "-C", stage]); run("npm", ["ci", "--omit=dev", "--ignore-scripts"], stage); }
      finally { process.umask(mask); }
      run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, "-e", "require(process.argv[1])", path.join(stage, "test-server.js")]);
      if (!unchanged(oldUnit)) throw Error("Configuration changed during preparation; service unchanged");
      fs.renameSync(stage, targetDir); syncDirectory(p.releases);
    } catch (error) { try { preserveUnused(); } catch {} throw error; }
    finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
    const writeUnit = (bytes, previous) => {
      if (!unchanged(previous)) throw Error("Concurrent service configuration change preserved");
      const temporary = fs.mkdtempSync(path.join(path.dirname(p.unit), ".kai-quotes-unit-"));
      try {
        const file = path.join(temporary, "service"), fd = fs.openSync(file, "wx", mode);
        try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (!unchanged(previous)) throw Error("Concurrent service configuration change preserved");
        fs.renameSync(file, p.unit); syncDirectory(path.dirname(p.unit));
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    };
    let attemptedStop = false;
    try {
      attemptedStop = true; run("systemctl", ["stop", UNIT]);
      if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Prepaid service did not stop cleanly");
      writeUnit(nextUnit, oldUnit);
      run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
      if (!unchanged(nextUnit) || show("WorkingDirectory") !== targetDir) throw Error("Updated service identity or configuration changed");
      await checkHealth(ready);
      if (!unchanged(nextUnit)) throw Error("Configuration changed during readiness check");
    } catch (error) {
      try {
        // Inspect the unit itself: an interrupted directory fsync may occur
        // after rename, before the write call returns to its caller.
        if (unchanged(nextUnit)) {
          run("systemctl", ["stop", UNIT]);
          if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Updated service did not stop cleanly");
          writeUnit(oldUnit, nextUnit); run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
          await checkHealth({ ...ready, unlimited: false });
          log("Previous code restored. Current accounts, credits, quotes and payment records were retained.");
        } else if (attemptedStop && unchanged(oldUnit) && show("ActiveState") === "inactive") {
          run("systemctl", ["start", UNIT]);
        } else if (attemptedStop) log("Concurrent changes or incomplete shutdown preserved; service recovery needs attention. Previous unit: " + path.join(backup, "previous.service"));
      } catch { log("Automatic code recovery could not finish. Previous unit: " + path.join(backup, "previous.service")); }
      try { preserveUnused(); } catch { log("Prepared source retained at " + targetDir); }
      throw error;
    }
    log("Unlimited purchase quotes installed and verified on loopback and HTTPS: " + target);
    log("Daily account and service quote limits are removed. Accounts, credits, keys, runtime configuration and transaction records were preserved.");
    return { installed: true, unchanged: false, commit: target, backup };
  } finally { fs.rmdirSync(lock); }
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root, with no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, BASE, ALLOWED, REQUIRED, PROBES, UNIT, PATHS };
