"use strict";
// Code-only credit-stream keep-alive update. Configuration and every account,
// payment, reward and quote journal remain in place, including during rollback.
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { configDigest } = require("./update-prepaid-web");
const { validateUnit, runtimeTarget, health: walletHealth, UNIT, PATHS } = require("./update-wallet-access");
const BASE = "45277dd1a63d54d773e472b891520ce4a12ffe67";
const { waitForBoundary } = require("./update-rpc-read-groups");
const REQUIRED = ["lib/koin-network/credit-stream.js", "lib/koin-network/prepaid-router.js", "test-server.js",
  "scripts/probe-koin-credit-stream.js", "deploy/koin-mainnet/update-credit-stream.js",
  "deploy/koin-mainnet/update-credit-stream.test.js", "deploy/koin-mainnet/CREDIT_STREAM.md"];
const ALLOWED = new Set([...REQUIRED, ".github/workflows/credit-stream.yml"]);
const PRIOR_RELEASES = [BASE, "7fcc44bf6554986c91e488e76da8b791e23456c4"];
const PROBES = ["scripts/probe-koin-credit-stream.js", "scripts/probe-koin-metered-stream.js",
  "scripts/probe-koin-public-stream.js", "scripts/probe-koin-prepaid.js", "scripts/probe-koin-rpc-read-groups.js",
  "deploy/koin-mainnet/update-credit-stream.test.js"];
const LOCKS = ["kai-credit-stream-update.lock", ...require("./update-rpc-read-groups").LOCKS];
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
async function health({ summary = true, fetchImpl = fetch, ...options } = {}) {
  return walletHealth({ ...options, capabilities: true, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!summary || !url.endsWith("/health") || !response.ok) return response;
    const body = await response.text();
    if (Buffer.byteLength(body) > 32768) throw Error("Reward health response is too large");
    const value = JSON.parse(body);
    if (value.streamKeepaliveVersion !== 1 || value.rpcReadGroupVersion !== 1 || value.rpcTransportVersion !== 1 || value.claimSponsorshipVersion !== 1 || value.rewardSummaryVersion !== 1 || value.freeAllowanceRefreshVersion !== 1 || !Object.hasOwn(value, "lastRewardSuccess"))
      throw Error("Credit stream keep-alives and existing reward monitoring are not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
async function update({ repo = process.cwd(), paths: p = PATHS, run = command, checkHealth = health, beforeStop = waitForBoundary, log = console.log } = {}) {
  for (const dir of [p.work, p.releases, p.config, p.state]) real(dir, true);
  const locks = [];
  try {
    for (const name of LOCKS) { const lock = path.join(p.work, name); fs.mkdirSync(lock, { mode: 0o700 }); locks.push(lock); }
    const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
    if (!/^[a-f0-9]{40}$/.test(target) || target === BASE || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Use the clean reviewed credit-stream checkout");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (REQUIRED.some(name => !changed.includes(name)) || changed.some(name => !ALLOWED.has(name))) throw Error("Only the reviewed credit-stream update can be installed");
    const show = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key], undefined, true).trim();
    const current = show("WorkingDirectory"), targetDir = path.join(p.releases, target);
    if (![...PRIOR_RELEASES.map(commit => path.join(p.releases, commit)), targetDir].includes(current) || show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected prepaid service version or overrides; service unchanged");
    if (show("ActiveState") !== "active") throw Error("Prepaid service is not active; start the existing release and verify health before updating. Service unchanged");
    real(p.unit, false); real(current, true);
    const oldUnit = fs.readFileSync(p.unit), nextUnit = validateUnit(oldUnit, p, current, targetDir);
    const expected = runtimeTarget(path.join(p.config, "runtime.json")), digest = configDigest(p.config);
    const ready = { expected, paths: p, summary: true };
    if (current === targetDir) {
      await checkHealth(ready); log("Credit stream keep-alives is already installed and service health verified: " + target);
      return { installed: true, unchanged: true, commit: target };
    }
    if (fs.existsSync(targetDir)) throw Error("Target release already exists; preserve it for review");
    // These isolated regressions never open live databases or submit a payment.
    run(process.execPath, ["--test", ...PROBES], repo);
    const mode = fs.statSync(p.unit).mode & 0o777;
    const backup = fs.mkdtempSync(path.join(p.work, "kai-credit-stream-code-")); fs.chmodSync(backup, 0o700);
    fs.writeFileSync(path.join(backup, "previous.service"), oldUnit, { mode: 0o600 });
    const archive = path.join(backup, "source.tar"); run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
    const unchanged = bytes => { real(p.unit, false); return fs.readFileSync(p.unit).equals(bytes) && configDigest(p.config) === digest; };
    const preserveUnused = () => {
      if (fs.existsSync(targetDir) && unchanged(oldUnit) && show("WorkingDirectory") === current && show("ActiveState") === "active") {
        fs.renameSync(targetDir, path.join(backup, "unused-release")); syncDirectory(p.releases);
      }
    };
    const stage = fs.mkdtempSync(path.join(p.releases, ".credit-stream-" + target + "-")); fs.chmodSync(stage, 0o755);
    try {
      const mask = process.umask(0o022);
      try { run("tar", ["-xf", archive, "-C", stage]); run("npm", ["ci", "--omit=dev", "--ignore-scripts"], stage); }
      finally { process.umask(mask); }
      run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, "-e", "require(process.argv[1])", path.join(stage, "test-server.js")]);
      // Check the new transport against the existing pinned contracts before stopping production.
      // This loads deployment settings only, never signer keys or live journals.
      run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath,
        path.join(stage, "deploy/koin-mainnet/check-rpc-recovery.js"), path.join(p.config, "runtime.json")]);
      if (!unchanged(oldUnit)) throw Error("Configuration changed during preparation; service unchanged");
      fs.renameSync(stage, targetDir); syncDirectory(p.releases);
    } catch (error) { try { preserveUnused(); } catch {} throw error; }
    finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
    const writeUnit = (bytes, previous) => {
      if (!unchanged(previous)) throw Error("Concurrent service configuration change preserved");
      const temporary = fs.mkdtempSync(path.join(path.dirname(p.unit), ".kai-credit-stream-unit-"));
      try {
        const file = path.join(temporary, "service"), fd = fs.openSync(file, "wx", mode);
        try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (!unchanged(previous)) throw Error("Concurrent service configuration change preserved");
        fs.renameSync(file, p.unit); syncDirectory(path.dirname(p.unit));
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    };
    let attemptedStop = false;
    try {
      log("Waiting for the current reward pass to finish before shutdown (up to three minutes).");
      await beforeStop({ paths: p });
      if (!unchanged(oldUnit)) throw Error("Configuration changed before shutdown; service unchanged");
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
          await checkHealth({ ...ready, summary: false });
          log("Previous code restored. Current accounts, credits, quotes and payment records were retained.");
        } else if (attemptedStop && unchanged(oldUnit) &&
            ["inactive", "failed"].includes(show("ActiveState")) && show("MainPID") === "0") {
          // A shutdown deadline can leave systemd in failed rather than
          // inactive even though the process is gone. Abort the upgrade, but
          // restart the unchanged old code against its current durable journals.
          run("systemctl", ["reset-failed", UNIT]); run("systemctl", ["start", UNIT]);
          await checkHealth({ ...ready, summary: false });
          log("Previous code restarted after unsuccessful shutdown; service health verified. Update was not installed and current payment records were retained.");
        } else if (attemptedStop) log("Concurrent changes or incomplete shutdown preserved; service recovery needs attention. Previous unit: " + path.join(backup, "previous.service"));
      } catch { log("Automatic code recovery could not finish. Previous unit: " + path.join(backup, "previous.service")); }
      try { preserveUnused(); } catch { log("Prepared source retained at " + targetDir); }
      throw error;
    }
    log("Credit stream keep-alives installed; service health verified on loopback and HTTPS: " + target);
    log("Keep-alive capability verified. Use Core 0.7.26 or newer to opt in; existing workflows need no reimport.");
    return { installed: true, unchanged: false, commit: target, backup };
  } finally { for (const lock of locks.reverse()) fs.rmdirSync(lock); }
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root, with no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, waitForBoundary, BASE, PRIOR_RELEASES, ALLOWED, REQUIRED, PROBES, LOCKS, UNIT, PATHS };
