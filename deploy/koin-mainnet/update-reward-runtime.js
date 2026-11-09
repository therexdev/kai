"use strict";
// Code-only reward runtime progress update. Configuration and every account,
// payment, reward and quote journal remain in place, including during rollback.
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { configDigest } = require("./update-prepaid-web");
const { validateUnit, runtimeTarget, health: walletHealth, UNIT, PATHS } = require("./update-wallet-access");
const BASE = "45277dd1a63d54d773e472b891520ce4a12ffe67";
const REQUIRED = ["test-server.js", "lib/koin-network/test-runtime.js",
  "lib/koin-network/operator-progress.js", "scripts/probe-koin-operator-progress.js", "scripts/probe-koin-reward-checkpoints.js",
  "lib/koin-network/reward-claims.js", "lib/koin-network/reward-cycle.js",
  "lib/koin-network/verified-manifest-cache.js", "scripts/probe-koin-verified-manifest-cache.js",
  "deploy/koin-mainnet/update-reward-runtime.js", "deploy/koin-mainnet/update-reward-runtime.test.js",
  "deploy/koin-mainnet/REWARD_RUNTIME.md"];
const ALLOWED = new Set(REQUIRED), PRIOR_RELEASES = [BASE];
const PROBES = ["scripts/probe-koin-reward-checkpoints.js", "scripts/probe-koin-operator-progress.js", "scripts/probe-koin-verified-manifest-cache.js",
  "scripts/probe-koin-rpc-read-groups.js", "scripts/probe-koin-rpc-recovery.js",
  "scripts/probe-koin-reward-progress.js", "scripts/probe-koin-reward-cycle.js",
  "scripts/probe-koin-automatic-claims.js", "scripts/probe-koin-claim-capacity.js",
  "scripts/probe-koin-reward-observer.js", "scripts/probe-koin-reward-summary.js",
  "scripts/probe-koin-shadow.js", "scripts/probe-koin-epoch-completeness.js",
  "deploy/koin-mainnet/update-reward-runtime.test.js"];
const LOCKS = ["kai-reward-runtime-update.lock", ...require("./update-rpc-read-groups").LOCKS];
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
    if (value.rewardRuntimeVersion !== 1 || value.rpcReadGroupVersion !== 1 || value.rpcTransportVersion !== 1 || value.claimSponsorshipVersion !== 1 || value.rewardSummaryVersion !== 1 || value.freeAllowanceRefreshVersion !== 1 || !Object.hasOwn(value, "lastRewardSuccess"))
      throw Error("Reward runtime progress and reward monitoring are not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
const PROCESS_PROPERTIES = ["ActiveState", "MainPID", "ExecMainPID", "ExecMainCode", "ExecMainStatus", "Result", "NRestarts"];
function processState(run = command) {
  const text = run("systemctl", ["show", UNIT, "--property=" + PROCESS_PROPERTIES.join(",")], undefined, true);
  const state = Object.fromEntries(text.trim().split("\n").map(line => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
  for (const key of PROCESS_PROPERTIES) if (!Object.hasOwn(state, key)) throw Error("Incomplete service process identity");
  for (const key of ["MainPID", "ExecMainPID", "ExecMainCode", "ExecMainStatus", "NRestarts"])
    if (!/^\d+$/.test(state[key])) throw Error("Invalid service process identity");
  return state;
}
function cleanExit(state) {
  return state.ActiveState === "inactive" && state.MainPID === "0" &&
    state.ExecMainCode === "1" && state.ExecMainStatus === "0" && state.Result === "success";
}
function sameCleanExit(state, expected) {
  return cleanExit(state) && cleanExit(expected) && state.ExecMainPID === expected.ExecMainPID && state.NRestarts === expected.NRestarts;
}
// Bootstrap without the old database-heavy operator/status endpoint. Send only
// SIGTERM to the checked main process; never create a StopUnit job with a forced
// SIGKILL deadline. The application owns draining its current financial pass.
async function gracefulShutdown({ run = command, assertUnchanged = () => {}, clock = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 35000 } = {}) {
  assertUnchanged(); const before = processState(run);
  if (before.ActiveState !== "active" || before.MainPID === "0" || before.ExecMainPID !== before.MainPID)
    throw Error("Expected one active prepaid main process; service unchanged");
  assertUnchanged(); const checked = processState(run);
  if (JSON.stringify(checked) !== JSON.stringify(before)) throw Error("Service process changed before SIGTERM; service unchanged");
  assertUnchanged();
  run("systemctl", ["kill", "--kill-whom=main", "--signal=SIGTERM", UNIT]);
  const deadline = clock() + timeoutMs;
  while (true) {
    assertUnchanged(); const current = processState(run);
    if (current.NRestarts !== before.NRestarts || current.ExecMainPID !== before.MainPID ||
        (current.MainPID !== "0" && current.MainPID !== before.MainPID))
      throw Error("Prepaid process restarted or changed during drain; code unchanged");
    if (cleanExit(current)) return current;
    if (current.MainPID === "0" || ["failed", "inactive", "activating"].includes(current.ActiveState))
      throw Error("Prepaid process did not exit cleanly; code unchanged");
    if (clock() >= deadline) throw Error("Prepaid process drain timed out; no forced signal or code change was made");
    await wait(Math.min(250, deadline - clock()));
  }
}
async function progress({ paths: p = PATHS, fetchImpl = fetch, log = console.log } = {}) {
  const secret = fs.readFileSync(path.join(p.config, "operator-secret"), "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("Invalid operator credential");
  let value;
  try {
    const response = await fetchImpl("http://127.0.0.1:3109/operator/progress", {
      headers: { "x-operator-secret": secret }, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error();
    const body = await response.text(); if (Buffer.byteLength(body) > 32768) throw Error();
    value = JSON.parse(body);
  } catch { throw Error("Lightweight reward progress could not be verified"); }
  const stamp = v => v === null || (Number.isSafeInteger(v) && v >= 0);
  const stage = v => v === null || (typeof v === "string" && /^[a-z_]{1,64}$/.test(v));
  const epoch = value?.currentEpoch;
  if (value?.rewardRuntimeVersion !== 1 || typeof value.busy !== "boolean" || typeof value.stopped !== "boolean" ||
      !Number.isSafeInteger(value.observedAt) || !stage(value.processingStage) ||
      ["processingStartedAt", "lastServing", "lastRewardSuccess", "lastSettlementSuccess"].some(key => !stamp(value[key])) ||
      !epoch || typeof epoch.epoch !== "string" || !/^\d{1,12}$/.test(epoch.epoch) ||
      typeof epoch.budgetPresent !== "boolean" || typeof epoch.dayPresent !== "boolean" ||
      !stamp(epoch.openedAt) || !stamp(epoch.lastIntervalEnd) || !Number.isSafeInteger(epoch.intervalCount) || epoch.intervalCount < 0 ||
      !Array.isArray(value.errors)) throw Error("Invalid lightweight reward progress response");
  const output = { observation: "Reward progress after code activation" };
  for (const key of ["observedAt", "busy", "stopped", "processingStage", "processingStartedAt", "lastServing", "lastRewardSuccess", "lastSettlementSuccess"])
    output[key] = value[key];
  output.currentEpoch = Object.fromEntries(["epoch", "budgetPresent", "dayPresent", "openedAt", "intervalCount", "lastIntervalEnd"].map(key => [key, epoch[key]]));
  const { rpcDiagnostics } = require("../../lib/koin-network/rpc-provider");
  const { safeError } = require("../../lib/koin-network/rpc-transport");
  output.recentErrors = value.errors.slice(-5).map(error => ({
    at: stamp(error?.at) ? error.at : null, stage: stage(error?.stage) ? error.stage : null,
    message: safeError(error?.message || "Unknown processing error").replaceAll(secret, "[redacted]").replace(/[A-Za-z0-9_+/=-]{40,}/g, "[redacted]"),
    rpc: rpcDiagnostics({ rpcDiagnostics: error?.rpc }),
  }));
  log(JSON.stringify(output)); return output;
}
async function update({ repo = process.cwd(), paths: p = PATHS, run = command, checkHealth = health, drain = gracefulShutdown, drainOptions = {}, reportProgress = progress, log = console.log } = {}) {
  for (const dir of [p.work, p.releases, p.config, p.state]) real(dir, true);
  const locks = [];
  try {
    for (const name of LOCKS) { const lock = path.join(p.work, name); fs.mkdirSync(lock, { mode: 0o700 }); locks.push(lock); }
    const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
    if (!/^[a-f0-9]{40}$/.test(target) || target === BASE || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Use the clean reviewed reward-runtime checkout");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (REQUIRED.some(name => !changed.includes(name)) || changed.some(name => !ALLOWED.has(name))) throw Error("Only the reviewed reward-runtime update can be installed");
    const show = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key], undefined, true).trim();
    const current = show("WorkingDirectory"), targetDir = path.join(p.releases, target);
    if (![...PRIOR_RELEASES.map(commit => path.join(p.releases, commit)), targetDir].includes(current) || show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected prepaid service version or overrides; service unchanged");
    if (show("ActiveState") !== "active") throw Error("Prepaid service is not active; start the existing release and verify health before updating. Service unchanged");
    real(p.unit, false); real(current, true);
    const oldUnit = fs.readFileSync(p.unit), nextUnit = validateUnit(oldUnit, p, current, targetDir);
    const expected = runtimeTarget(path.join(p.config, "runtime.json")), digest = configDigest(p.config);
    const ready = { expected, paths: p, summary: true };
    if (current === targetDir) {
      await checkHealth(ready); await reportProgress({ paths: p, log }); log("Reward runtime progress is already installed and service health verified: " + target);
      return { installed: true, unchanged: true, commit: target };
    }
    if (fs.existsSync(targetDir)) throw Error("Target release already exists; preserve it for review");
    // These isolated regressions never open live databases or submit a payment.
    run(process.execPath, ["--test", "--test-concurrency=1", ...PROBES], repo);
    const mode = fs.statSync(p.unit).mode & 0o777;
    const backup = fs.mkdtempSync(path.join(p.work, "kai-reward-runtime-code-")); fs.chmodSync(backup, 0o700);
    fs.writeFileSync(path.join(backup, "previous.service"), oldUnit, { mode: 0o600 });
    const archive = path.join(backup, "source.tar"); run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
    const unchanged = bytes => { real(p.unit, false); return fs.readFileSync(p.unit).equals(bytes) && configDigest(p.config) === digest; };
    const preserveUnused = () => {
      if (fs.existsSync(targetDir) && unchanged(oldUnit) && show("WorkingDirectory") === current) {
        fs.renameSync(targetDir, path.join(backup, "unused-release")); syncDirectory(p.releases);
      }
    };
    const stage = fs.mkdtempSync(path.join(p.releases, ".reward-runtime-" + target + "-")); fs.chmodSync(stage, 0o755);
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
    const writeUnit = (bytes, previous, exited) => {
      const verifyExited = () => { if (!sameCleanExit(processState(run), exited)) throw Error("Exited process identity changed before code replacement"); };
      verifyExited();
      if (!unchanged(previous)) throw Error("Concurrent service configuration change preserved");
      const temporary = fs.mkdtempSync(path.join(path.dirname(p.unit), ".kai-reward-runtime-unit-"));
      try {
        const file = path.join(temporary, "service"), fd = fs.openSync(file, "wx", mode);
        try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (!unchanged(previous)) throw Error("Concurrent service configuration change preserved");
        verifyExited();
        if (!unchanged(previous)) throw Error("Concurrent service configuration change preserved");
        fs.renameSync(file, p.unit); syncDirectory(path.dirname(p.unit));
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    };
    let attemptedDrain = false;
    const guard = bytes => () => { if (!unchanged(bytes)) throw Error("Concurrent service or configuration change preserved"); };
    const drainCurrent = async bytes => {
      const assertUnchanged = guard(bytes); assertUnchanged();
      const exited = await drain({ ...drainOptions, run, assertUnchanged });
      assertUnchanged(); if (!sameCleanExit(processState(run), exited)) throw Error("Clean main-process identity could not be confirmed");
      return exited;
    };
    try {
      log("Requesting a graceful main-process drain; an unsuccessful drain aborts this code update.");
      attemptedDrain = true; const exited = await drainCurrent(oldUnit);
      writeUnit(nextUnit, oldUnit, exited);
      run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
      if (!unchanged(nextUnit) || show("WorkingDirectory") !== targetDir) throw Error("Updated service identity or configuration changed");
      await checkHealth(ready); await reportProgress({ paths: p, log });
      if (!unchanged(nextUnit)) throw Error("Configuration changed during readiness check");
    } catch (error) {
      try {
        if (unchanged(nextUnit)) {
          const state = processState(run);
          const exited = cleanExit(state) ? state : await drainCurrent(nextUnit);
          writeUnit(oldUnit, nextUnit, exited); run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
          await checkHealth({ ...ready, summary: false });
          log("Previous code restored. Current accounts, credits, quotes and payment records were retained.");
        } else if (attemptedDrain && unchanged(oldUnit)) {
          const state = processState(run);
          if (["inactive", "failed"].includes(state.ActiveState) && state.MainPID === "0") {
            // Start only the unchanged original service after an unsuccessful
            // application-owned drain. Never terminate a surviving process.
            run("systemctl", ["reset-failed", UNIT]); run("systemctl", ["start", UNIT]);
            await checkHealth({ ...ready, summary: false });
            log("Unchanged previous code restarted after unsuccessful activation; current journals were retained.");
          } else if (state.ActiveState === "active") {
            await checkHealth({ ...ready, summary: false });
            log("Unchanged previous code remains running; the update was not installed.");
          } else log("Unchanged service is transitioning; no extra signal or restart was sent.");
        } else if (attemptedDrain) log("Concurrent changes preserved; service recovery needs attention. Previous unit: " + path.join(backup, "previous.service"));
      } catch { log("Automatic code recovery could not finish. Previous unit: " + path.join(backup, "previous.service")); }
      try { preserveUnused(); } catch { log("Prepared source retained at " + targetDir); }
      throw error;
    }
    log("Reward runtime update installed and lightweight progress verified: " + target);
    log("Code activation is not reward recovery. Confirm advancing reward timestamps, the current epoch and payout progress.");
    return { installed: true, unchanged: false, commit: target, backup };
  } finally { for (const lock of locks.reverse()) fs.rmdirSync(lock); }
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root, with no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, progress, processState, cleanExit, sameCleanExit, gracefulShutdown, BASE, PRIOR_RELEASES, ALLOWED, REQUIRED, PROBES, LOCKS, UNIT, PATHS };
