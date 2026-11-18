"use strict";
// Code-only, forward-only maintenance of the already activated SQLite runtime.
// Preserve production journals; snapshot them only after a verified clean stop.
// Never restore historical payment data or open a second journal writer.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const Prior = require("./update-reward-runtime"), Release = require("./update-reward-storage"),
  { validateUnit, runtimeTarget } = require("./update-wallet-access"), Storage = require("../../lib/koin-network/shadow-storage-activation");
const BASE = "9c0776e55c4512149e015695bc7f2e8e35b8f753", { UNIT, PATHS } = Prior;
const Backoff = require("./update-rpc-adaptive");
const REQUIRED = [
  "lib/credit-api-keys.js",
  "lib/credit-gateway.js",
  "lib/credit-account-web.js",
  "lib/koin-network/prepaid-ledger.js",
  "lib/koin-network/prepaid-router.js",
  "test-server.js",
  "public/account.html",
  "public/platform/index.html",
  "public/platform/platform.css",
  "public/platform/platform.js",
  "public/platform/docs.html",
  "scripts/helpers/credit-gateway-fixture.js",
  "scripts/probe-credit-gateway.js",
  "scripts/probe-credit-platform-dom.js",
  "scripts/probe-mainnet-deployment-rpc.js",
  "tests/credit-platform.browser.cjs",
  "docs/WEB_ACCOUNTS_API.md",
  "deploy/koin-mainnet/update-web-api.js",
  "deploy/koin-mainnet/update-web-api.test.js"
];
const ALLOWED = new Set([...REQUIRED, ".github/workflows/web-accounts-api.yml"]);
const PROBES = [...new Set([...Backoff.PROBES, "scripts/probe-credit-gateway.js", "scripts/probe-credit-platform-dom.js", "scripts/probe-credit-account-web.js", "scripts/probe-koin-free-credits.js", "scripts/probe-wallet-credit-router.js", "scripts/probe-koin-device-free-router.js", "scripts/probe-purchase-quotes-http.js", "scripts/probe-mainnet-deployment-rpc.js", "deploy/koin-mainnet/update-web-api.test.js"])];
const LOCKS = ["kai-web-api-update.lock", ...Backoff.LOCKS], PHASES = ["staged", "draining", "exited", "unit", "started", "ready"];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function command(exe, args, cwd, capture = false) { return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || ""; }
function real(file, directory = false) { const s = fs.lstatSync(file); if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (!directory && s.nlink !== 1)) throw Error("Real unlinked code-update path required"); return s; }
function syncDirectory(dir) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(file, bytes, mode = 0o600) {
  const temporary = file + "." + crypto.randomUUID() + ".tmp", fd = fs.openSync(temporary, "wx", mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); syncDirectory(path.dirname(file)); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function enableEnvironment(p, { allowChange = true, log = console.log } = {}) {
  const file = path.join(p.config, "account.env"), stat = real(file);
  if (stat.size > 1024 * 1024) throw Error("Oversized account environment");
  const before = fs.readFileSync(file), source = before.toString("utf8");
  if (!Buffer.from(source).equals(before)) throw Error("Account environment must be UTF-8");
  const entries = [...source.matchAll(/^[ \t]*KAI_WEB_API_ENABLED[ \t]*=.*$/gm)];
  if (entries.length > 1) throw Error("Duplicate web API environment settings require review");
  if (entries.length && !/^[ \t]*KAI_WEB_API_ENABLED[ \t]*=[ \t]*(?:[01]|"[01]"|'[01]')[ \t]*\r?$/.test(entries[0][0])) throw Error("Unexpected web API environment setting");
  if (entries.length && /^[ \t]*KAI_WEB_API_ENABLED[ \t]*=[ \t]*(?:1|"1"|'1')[ \t]*\r?$/.test(entries[0][0])) return;
  if (!allowChange) throw Error("Existing deployment plan requires its unchanged enabled environment");
  const after = entries.length ? source.slice(0, entries[0].index) + "KAI_WEB_API_ENABLED=1" + source.slice(entries[0].index + entries[0][0].length) : source + (source.endsWith("\n") ? "" : "\n") + "KAI_WEB_API_ENABLED=1\n";
  const backup = fs.mkdtempSync(path.join(p.work, "kai-web-api-env-")); fs.chmodSync(backup, 0o700);
  fs.writeFileSync(path.join(backup, "account.env"), before, { flag: "wx", mode: 0o600, flush: true });
  syncDirectory(backup); syncDirectory(p.work);
  const temporary = file + "." + crypto.randomUUID() + ".tmp", fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, after); fs.fchownSync(fd, stat.uid, stat.gid); fs.fchmodSync(fd, stat.mode & 0o777); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    const current = real(file);
    if (current.ino !== stat.ino || current.dev !== stat.dev || current.ctimeMs !== stat.ctimeMs || !fs.readFileSync(file).equals(before)) throw Error("Concurrent account configuration change preserved");
    fs.renameSync(temporary, file); syncDirectory(p.config);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  log("Enabled web accounts and API. Private environment backup: " + backup);
}
function snapshotState({ paths: p, run = command }) {
  const directory = fs.mkdtempSync(path.join(p.work, "kai-web-api-state-")); fs.chmodSync(directory, 0o700);
  const archive = path.join(directory, "state-before-update.tar");
  run("tar", ["-cpf", archive, "-C", p.state, "."]);
  real(archive); fs.chmodSync(archive, 0o600);
  const fd = fs.openSync(archive, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } syncDirectory(directory); syncDirectory(p.work);
  return archive;
}
function activationFingerprint(info) {
  if (info?.mode !== "sqlite-shadow" || !info.descriptor) throw Error("Existing verified SQLite activation required; no migration will be attempted");
  real(info.directory, true); real(path.join(info.directory, "shadow.sqlite")); real(info.directory + ".recovery-anchor.sqlite");
  const stamps = [info.paths.sourceFile, info.markerFile].map(file => {
    const s = real(file); if (s.size > 16384) throw Error("Oversized activation record");
    return [file, s.dev, s.ino, s.mode, s.uid, s.gid, s.size, s.mtimeMs, s.ctimeMs];
  });
  return hash(JSON.stringify([info.descriptor, stamps]));
}
async function health({ fetchImpl = fetch, ...options } = {}) {
  return Backoff.health({ ...options, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!url.endsWith("/health") || !response.ok) return response;
    const body = await response.text(); if (Buffer.byteLength(body) > 32768) throw Error("Oversized Web account API health response");
    if (JSON.parse(body).webApiVersion !== 1) throw Error("Web account API version 1 is not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
async function update({ repo = process.cwd(), paths: p = PATHS, run = command, log = console.log, drain = Prior.gracefulShutdown, checkHealth = health, enable = false, backupState = snapshotState,
  storage = Storage, prepareSource = Release.stageRelease, checkRelease = Release.verifyRelease,
  assertStorageIdle = info => {
    const { assertWriterLeaseCount } = require("../../lib/koin-network/storage-writer-lease");
    assertWriterLeaseCount(path.join(p.state, "provider-devices"), 0, "provider source");
    assertWriterLeaseCount(info.directory, 0, "reward shadow");
  } } = {}) {
  for (const dir of [p.work, p.releases, p.config, p.state]) real(dir, true);
  const held = [];
  try {
    for (const name of LOCKS) { const file = path.join(p.work, name); fs.mkdirSync(file, { mode: 0o700 }); held.push(file); }
    const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
    if (!/^[a-f0-9]{40}$/.test(target) || target === BASE || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Clean reviewed Web account API checkout required");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (REQUIRED.some(name => !changed.includes(name)) || changed.some(name => !ALLOWED.has(name))) throw Error("Only the exact reviewed Web account API release may be installed");
    const show = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key], undefined, true).trim();
    const checkUnit = () => { for (const [key, value] of Object.entries({ FragmentPath: p.unit, DropInPaths: "", Restart: "on-failure", RestartForceExitStatus: "", UnitFileState: "enabled" })) if (show(key) !== value) throw Error("Unexpected service " + key); };
    checkUnit(); const unitStat = real(p.unit); if (unitStat.size > 32768) throw Error("Oversized service unit");
    const baseDir = path.join(p.releases, BASE), targetDir = path.join(p.releases, target), current = show("WorkingDirectory");
    if (![baseDir, targetDir].includes(current)) throw Error("Unexpected active reward runtime release");
    const runtimeFile = path.join(p.config, "runtime.json"); if (real(runtimeFile).size > 1024 * 1024) throw Error("Oversized public configuration");
    const expected = runtimeTarget(runtimeFile), configuration = JSON.parse(fs.readFileSync(runtimeFile)), identity = storage.storageIdentity(configuration);
    if (configuration.accountMode !== "public" || configuration.deployment?.product !== "prepaid-usd-v1") throw Error("Existing public USD credit accounts required");
    const planFile = path.join(p.work, "kai-web-api-plan-" + target + ".json");
    if (enable) enableEnvironment(p, { allowChange: !fs.existsSync(planFile), log });
    const fingerprint = Release.configFingerprint(p.config);
    const inspect = () => storage.inspectStorage(p.state, { identity }), activationHash = activationFingerprint(inspect());
    const manifest = Release.treeManifest(repo, target, run), treeHash = hash(JSON.stringify(manifest));
    let plan;
    if (fs.existsSync(planFile)) {
      const stat = real(planFile);
      if (stat.size > 256 * 1024 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw Error("Unsafe Web API deployment plan ownership or size");
      plan = JSON.parse(fs.readFileSync(planFile));
      if (plan.schema !== 1 || plan.target !== target || plan.base !== BASE || plan.treeHash !== treeHash || plan.fingerprint !== fingerprint || plan.activationHash !== activationHash ||
          !equal(plan.paths, p) || !PHASES.includes(plan.phase) || plan.mode !== (unitStat.mode & 0o777)) throw Error("Web API deployment plan no longer matches reviewed inputs");
      checkRelease(targetDir, manifest);
    } else {
      if (current !== baseDir || show("ActiveState") !== "active") throw Error("First code update requires the active reviewed SQLite base release");
      if (fs.existsSync(targetDir)) throw Error("Existing target without a verified deployment plan requires review");
      const oldUnit = fs.readFileSync(p.unit), nextUnit = validateUnit(oldUnit, p, baseDir, targetDir);
      run(process.execPath, ["--test", "--test-concurrency=1", ...PROBES], repo);
      prepareSource({ repo, target, targetDir, paths: p, run, manifest }); checkRelease(targetDir, manifest);
      if (Release.configFingerprint(p.config) !== fingerprint || activationFingerprint(inspect()) !== activationHash || !fs.readFileSync(p.unit).equals(oldUnit)) throw Error("Configuration or storage activation changed during preparation");
      plan = { schema: 1, target, base: BASE, treeHash, fingerprint, activationHash, paths: p, phase: "staged", oldUnit: oldUnit.toString("base64"), nextUnit: nextUnit.toString("base64"), mode: unitStat.mode & 0o777, initial: null, exited: null, startedProcess: null };
      atomic(planFile, JSON.stringify(plan));
    }
    if (![plan.oldUnit, plan.nextUnit].every(value => typeof value === "string" && value.length <= 65536 && Buffer.from(value, "base64").toString("base64") === value)) throw Error("Invalid saved unit encoding");
    const oldUnit = Buffer.from(plan.oldUnit, "base64"), nextUnit = Buffer.from(plan.nextUnit, "base64");
    if (!validateUnit(oldUnit, p, baseDir, targetDir).equals(nextUnit)) throw Error("Saved unit replacement differs from reviewed service");
    const save = phase => { plan.phase = phase; atomic(planFile, JSON.stringify(plan)); };
    const unchanged = () => {
      checkUnit(); const stat = real(p.unit);
      if ((stat.mode & 0o777) !== plan.mode || Release.configFingerprint(p.config) !== fingerprint || activationFingerprint(inspect()) !== activationHash || ![oldUnit, nextUnit].some(bytes => fs.readFileSync(p.unit).equals(bytes))) throw Error("Concurrent configuration, activation or unit change preserved");
    };
    unchanged();
    // Module loading and pinned RPC verification use only public configuration.
    // They run before downtime and again on retry, without journal writers/keys.
    run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, "-e", "require(process.argv[1])", path.join(targetDir, "test-server.js")]);
    run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, path.join(targetDir, "deploy/koin-mainnet/check-rpc-recovery.js"), runtimeFile]);
    unchanged(); let state = Prior.processState(run);
    if (state.ActiveState === "active" && show("WorkingDirectory") === targetDir && fs.readFileSync(p.unit).equals(nextUnit)) {
      await checkHealth({ expected }); unchanged(); save("ready"); return { installed: true, unchanged: true, commit: target, planFile };
    }
    if (state.ActiveState === "active") {
      if (show("WorkingDirectory") !== baseDir || !fs.readFileSync(p.unit).equals(oldUnit) || !["staged", "draining"].includes(plan.phase)) throw Error("Unexpected writer resumed during code maintenance");
      plan.initial = state; save("draining");
      const exited = await drain({ run, assertUnchanged: unchanged, timeoutMs: 240000 });
      if (!Prior.sameCleanExit(Prior.processState(run), exited)) throw Error("Clean stopped process could not be verified");
      plan.exited = exited; save("exited"); state = exited;
    } else {
      const prior = plan.startedProcess || plan.initial;
      if (!Prior.cleanExit(state) || !prior || state.ExecMainPID !== prior.MainPID || state.NRestarts !== prior.NRestarts || (!plan.startedProcess && plan.exited && !Prior.sameCleanExit(state, plan.exited))) throw Error("Interrupted update has no verified clean stopped process");
      plan.exited = state;
    }
    const assertQuiescent = () => {
      unchanged(); if (!Prior.sameCleanExit(Prior.processState(run), plan.exited)) throw Error("Stopped service identity changed during code maintenance");
      assertStorageIdle(inspect());
    };
    assertQuiescent(); checkRelease(targetDir, manifest); assertQuiescent();
    if (!plan.snapshot) {
      plan.snapshot = backupState({ paths: p, run }); assertQuiescent(); save(plan.phase);
      log("Consistent stopped-service state snapshot: " + plan.snapshot);
    }
    if (typeof plan.snapshot !== "string" || path.dirname(path.dirname(plan.snapshot)) !== p.work || !path.basename(path.dirname(plan.snapshot)).startsWith("kai-web-api-state-")) throw Error("Unexpected state snapshot path");
    const snapshot = real(plan.snapshot);
    if (snapshot.uid !== process.getuid?.() || (snapshot.mode & 0o777) !== 0o600 || !snapshot.size) throw Error("Private completed state snapshot required");
    if (!fs.readFileSync(p.unit).equals(nextUnit)) atomic(p.unit, nextUnit, plan.mode); save("unit");
    assertQuiescent(); run("systemctl", ["daemon-reload"]); assertQuiescent();
    if (show("WorkingDirectory") !== targetDir) throw Error("New unit was not loaded");
    run("systemctl", ["start", UNIT]); plan.startedProcess = Prior.processState(run); save("started"); unchanged();
    await checkHealth({ expected }); unchanged(); save("ready");
    log("Verified web account API activated; existing SQLite storage retained: " + target);
    return { installed: true, unchanged: false, commit: target, planFile };
  } catch (error) {
    log("Web API code update stopped at a verified boundary. No old code, storage, payment journal or recovery anchor was restored. Preserve the deployment plan and resume this exact reviewed release after resolving the reported failure.");
    throw error;
  } finally { for (const file of held.reverse()) fs.rmdirSync(file); }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if ((args.length && (args.length !== 1 || args[0] !== "--enable")) || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root; optional --enable activates the web API");
  process.umask(0o077); update({ enable: args[0] === "--enable" }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, activationFingerprint, enableEnvironment, snapshotState, BASE, REQUIRED, ALLOWED, PROBES, LOCKS, UNIT, PATHS };
