"use strict";
// Code-only, forward-only maintenance of the already activated SQLite runtime.
// Never migrate, copy, restore, or open a writer on production reward journals.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const Prior = require("./update-reward-runtime"), Release = require("./update-reward-storage"),
  { validateUnit, runtimeTarget } = require("./update-wallet-access"), Storage = require("../../lib/koin-network/shadow-storage-activation");
const BASE = "f25c7d8ddb1aee29ea3a26082d9864b766a67f3b", { UNIT, PATHS } = Prior;
const Backoff = require("./update-rpc-backoff");
const REQUIRED = ["lib/koin-network/credit-stream.js", "lib/koin-network/prepaid-router.js", "test-server.js",
  "scripts/probe-koin-credit-stream.js", "deploy/koin-mainnet/update-credit-stream.js",
  "deploy/koin-mainnet/update-credit-stream.test.js", "deploy/koin-mainnet/CREDIT_STREAM.md"];
const ALLOWED = new Set([...REQUIRED, ".github/workflows/credit-stream.yml"]);
const PROBES = [...new Set([...Backoff.PROBES, "scripts/probe-koin-credit-stream.js", "scripts/probe-koin-metered-stream.js",
  "scripts/probe-koin-public-stream.js", "scripts/probe-koin-prepaid.js", "deploy/koin-mainnet/update-credit-stream.test.js"])];
const LOCKS = ["kai-credit-stream-update.lock", ...Backoff.LOCKS], PHASES = ["staged", "draining", "exited", "unit", "started", "ready"];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function command(exe, args, cwd, capture = false) { return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || ""; }
function real(file, directory = false) { const s = fs.lstatSync(file); if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (!directory && s.nlink !== 1)) throw Error("Real unlinked code-update path required"); return s; }
function syncDirectory(dir) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(file, bytes, mode = 0o600) {
  const temporary = file + "." + crypto.randomUUID() + ".tmp", fd = fs.openSync(temporary, "wx", mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); syncDirectory(path.dirname(file)); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
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
    const body = await response.text(); if (Buffer.byteLength(body) > 32768) throw Error("Oversized Credit stream keep-alive health response");
    if (JSON.parse(body).streamKeepaliveVersion !== 1) throw Error("Credit stream keep-alive version 1 is not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
async function update({ repo = process.cwd(), paths: p = PATHS, run = command, log = console.log, drain = Prior.gracefulShutdown, checkHealth = health,
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
    if (!/^[a-f0-9]{40}$/.test(target) || target === BASE || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Clean reviewed Credit stream keep-alive checkout required");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (REQUIRED.some(name => !changed.includes(name)) || changed.some(name => !ALLOWED.has(name))) throw Error("Only the exact reviewed Credit stream keep-alive release may be installed");
    const show = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key], undefined, true).trim();
    const checkUnit = () => { for (const [key, value] of Object.entries({ FragmentPath: p.unit, DropInPaths: "", Restart: "on-failure", RestartForceExitStatus: "", UnitFileState: "enabled" })) if (show(key) !== value) throw Error("Unexpected service " + key); };
    checkUnit(); const unitStat = real(p.unit); if (unitStat.size > 32768) throw Error("Oversized service unit");
    const baseDir = path.join(p.releases, BASE), targetDir = path.join(p.releases, target), current = show("WorkingDirectory");
    if (![baseDir, targetDir].includes(current)) throw Error("Unexpected active reward runtime release");
    const runtimeFile = path.join(p.config, "runtime.json"); if (real(runtimeFile).size > 1024 * 1024) throw Error("Oversized public configuration");
    const expected = runtimeTarget(runtimeFile), identity = storage.storageIdentity(JSON.parse(fs.readFileSync(runtimeFile))), fingerprint = Release.configFingerprint(p.config);
    const inspect = () => storage.inspectStorage(p.state, { identity }), activationHash = activationFingerprint(inspect());
    const manifest = Release.treeManifest(repo, target, run), treeHash = hash(JSON.stringify(manifest)), planFile = path.join(p.work, "kai-credit-stream-plan-" + target + ".json");
    let plan;
    if (fs.existsSync(planFile)) {
      const stat = real(planFile);
      if (stat.size > 256 * 1024 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw Error("Unsafe Credit stream deployment plan ownership or size");
      plan = JSON.parse(fs.readFileSync(planFile));
      if (plan.schema !== 1 || plan.target !== target || plan.base !== BASE || plan.treeHash !== treeHash || plan.fingerprint !== fingerprint || plan.activationHash !== activationHash ||
          !equal(plan.paths, p) || !PHASES.includes(plan.phase) || plan.mode !== (unitStat.mode & 0o777)) throw Error("Credit stream deployment plan no longer matches reviewed inputs");
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
    if (!fs.readFileSync(p.unit).equals(nextUnit)) atomic(p.unit, nextUnit, plan.mode); save("unit");
    assertQuiescent(); run("systemctl", ["daemon-reload"]); assertQuiescent();
    if (show("WorkingDirectory") !== targetDir) throw Error("New unit was not loaded");
    run("systemctl", ["start", UNIT]); plan.startedProcess = Prior.processState(run); save("started"); unchanged();
    await checkHealth({ expected }); unchanged(); save("ready");
    log("Verified credit stream keep-alives activated; existing SQLite storage retained: " + target);
    return { installed: true, unchanged: false, commit: target, planFile };
  } catch (error) {
    log("Credit stream code update stopped at a verified boundary. No old code, storage, payment journal or recovery anchor was restored. Preserve the deployment plan and resume this exact reviewed release after resolving the reported failure.");
    throw error;
  } finally { for (const file of held.reverse()) fs.rmdirSync(file); }
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root, with no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, activationFingerprint, BASE, REQUIRED, ALLOWED, PROBES, LOCKS, UNIT, PATHS };
