"use strict";
// Forward-only offline storage deployment. A failure leaves verified code/state
// in place for an exact retry; it never restores JSON or an older payment writer.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const Prior = require("./update-reward-runtime"), { validateUnit, runtimeTarget } = require("./update-wallet-access"), Storage = require("../../lib/koin-network/shadow-storage-activation");
const BASE = "bd14857abffe9a9794bdbe33d89a170ad3c46c40", { UNIT, PATHS } = Prior;
// Exact review set relative to the observed production runtime.
const REQUIRED = [
  "deploy/koin-mainnet/DURABLE-REWARD-STORAGE.md",
  "deploy/koin-mainnet/REWARD_STORAGE_ACTIVATION.md",
  "deploy/koin-mainnet/activate-reward-storage.js",
  "deploy/koin-mainnet/diagnose-reward-storage.js",
  "deploy/koin-mainnet/update-reward-runtime.js",
  "deploy/koin-mainnet/update-reward-runtime.test.js",
  "deploy/koin-mainnet/update-reward-storage.js",
  "deploy/koin-mainnet/update-reward-storage.test.js",
  "lib/koin-network/availability-runtime.js",
  "lib/koin-network/earning-health.js",
  "lib/koin-network/operator-progress.js",
  "lib/koin-network/presence-coordinator.js",
  "lib/koin-network/provider-devices.js",
  "lib/koin-network/provider-presence-outbox.js",
  "lib/koin-network/provider-readiness.js",
  "lib/koin-network/reward-summary.js",
  "lib/koin-network/shadow-router.js",
  "lib/koin-network/shadow-storage-activation.js",
  "lib/koin-network/shadow-store.js",
  "lib/koin-network/shadow-worker-engine.js",
  "lib/koin-network/shadow-worker-ledger.js",
  "lib/koin-network/shadow-worker-protocol.js",
  "lib/koin-network/shadow-worker-thread.js",
  "lib/koin-network/shadow-worker.js",
  "lib/koin-network/shadow.js",
  "lib/koin-network/storage-writer-lease.js",
  "lib/koin-network/test-runtime.js",
  "lib/scheduler.js",
  "scripts/helpers/koin-storage-worker-fault.js",
  "scripts/probe-koin-active-runtime.js",
  "scripts/probe-koin-on-demand-readiness.js",
  "scripts/probe-koin-operator-progress.js",
  "scripts/probe-koin-presence-coordinator.js",
  "scripts/probe-koin-presence-outbox.js",
  "scripts/probe-koin-presence-store.js",
  "scripts/probe-koin-reward-storage-diagnostic.js",
  "scripts/probe-koin-runtime-startup.js",
  "scripts/probe-koin-runtime-storage.js",
  "scripts/probe-koin-shadow-activation.js",
  "scripts/probe-koin-shadow-store-recovery.js",
  "scripts/probe-koin-shadow-store.js",
  "scripts/probe-koin-shadow-summary-cache.js",
  "scripts/probe-koin-shadow-worker.js",
  "scripts/probe-koin-storage-worker-integration.js",
  "test-server.js"
];
const ALLOWED = new Set(REQUIRED), PROBES = [...Prior.PROBES,
  "deploy/koin-mainnet/update-reward-storage.test.js",
  "scripts/probe-koin-reward-storage-diagnostic.js",
  "scripts/probe-koin-presence-outbox.js",
  "scripts/probe-koin-shadow-store.js",
  "scripts/probe-koin-shadow-store-recovery.js",
  "scripts/probe-koin-presence-store.js",
  "scripts/probe-koin-runtime-storage.js",
  "scripts/probe-koin-shadow-activation.js",
  "scripts/probe-koin-shadow-worker.js",
  "scripts/probe-koin-presence-coordinator.js",
  "scripts/probe-koin-active-runtime.js",
  "scripts/probe-koin-storage-worker-integration.js"];
const LOCKS = ["kai-reward-storage-update.lock", "kai-reward-storage-activation.lock", ...Prior.LOCKS];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function command(exe, args, cwd, capture = false) { return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || ""; }
function real(file, directory = false) { const s = fs.lstatSync(file); if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw Error("Real storage deployment path required"); return s; }
function syncDirectory(dir) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(file, bytes, mode = 0o600) {
  const temporary = file + "." + crypto.randomUUID() + ".tmp", fd = fs.openSync(temporary, "wx", mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); syncDirectory(path.dirname(file)); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function configFingerprint(directory) {
  const entries = []; let count = 0;
  function visit(file, relative, depth) {
    if (++count > 10000 || depth > 12) throw Error("Configuration metadata exceeds bounded inspection");
    const s = fs.lstatSync(file); if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw Error("Unsupported configuration path");
    entries.push([relative, s.dev, s.ino, s.mode, s.uid, s.gid, s.size, s.mtimeMs, s.ctimeMs]);
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name), depth + 1);
  }
  visit(directory, "", 0);
  const publicFile = path.join(directory, "runtime.json"); if (real(publicFile).size > 1024 * 1024) throw Error("Oversized public configuration");
  // No secret file contents are read, hashed, printed or passed to a subprocess.
  return hash(JSON.stringify(entries) + "\n" + hash(fs.readFileSync(publicFile)));
}
function treeManifest(repo, commit, run) {
  const rows = run("git", ["ls-tree", "-rz", "--full-tree", commit], repo, true).split("\0").filter(Boolean).map(row => {
    const m = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!m || !m[3] || path.isAbsolute(m[3]) || m[3].split("/").some(p => !p || p === "." || p === "..") || m[3].startsWith("node_modules/")) throw Error("Unsupported release source entry");
    return { name: m[3], mode: m[1], blob: m[2] };
  });
  if (!rows.length || rows.length > 20000 || new Set(rows.map(row => row.name)).size !== rows.length) throw Error("Bounded exact source manifest required"); return rows;
}
function verifyRelease(directory, manifest) {
  real(directory, true); const expected = new Set(manifest.map(row => row.name));
  for (const row of manifest) {
    const file = path.join(directory, row.name), stat = real(file);
    if (stat.size > 32 * 1024 * 1024 || stat.nlink !== 1 || (stat.mode & 0o777) !== (row.mode === "100755" ? 0o755 : 0o644)) throw Error("Staged release mode, link count or size differs");
    const bytes = fs.readFileSync(file), blob = crypto.createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
    if (blob !== row.blob) throw Error("Staged release differs from reviewed source");
  }
  function visit(dir, prefix = "") {
    for (const name of fs.readdirSync(dir)) { const relative = prefix + name; if (!prefix && name === "node_modules") { real(path.join(dir, name), true); continue; }
      const file = path.join(dir, name), stat = fs.lstatSync(file); if (stat.isSymbolicLink()) throw Error("Linked staged release path");
      if (stat.isDirectory()) visit(file, relative + "/"); else if (!stat.isFile() || !expected.has(relative)) throw Error("Unexpected staged release file");
    }
  }
  visit(directory);
}
function stageRelease({ repo, target, targetDir, paths: p, run, manifest }) {
  const stage = fs.mkdtempSync(path.join(p.releases, ".reward-storage-")), archive = path.join(p.work, "kai-reward-storage-" + target + ".tar");
  fs.chmodSync(stage, 0o755);
  try {
    run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
    const mask = process.umask(0o022); try { run("tar", ["-xf", archive, "-C", stage]); run("npm", ["ci", "--omit=dev", "--ignore-scripts"], stage); } finally { process.umask(mask); }
    verifyRelease(stage, manifest); fs.renameSync(stage, targetDir); syncDirectory(p.releases);
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); if (fs.existsSync(archive)) fs.unlinkSync(archive); }
}
function ownCandidate(paths, { expectedOwner } = {}) {
  const owner = real(paths.sourceFile), files = [];
  if (expectedOwner && (owner.uid !== expectedOwner.uid || owner.gid !== expectedOwner.gid)) throw Error("Legacy shadow owner differs from the service account");
  const allowed = new Set(["shadow.sqlite", "shadow.sqlite-wal", "shadow.sqlite-shm", "legacy-koin-shadow.json"]);
  for (const name of fs.readdirSync(paths.directory)) { if (!allowed.has(name)) throw Error("Unexpected new shadow file; ownership unchanged"); files.push(path.join(paths.directory, name)); }
  for (const suffix of ["", "-wal", "-shm"]) { const file = paths.directory + ".recovery-anchor.sqlite" + suffix; if (fs.existsSync(file)) files.push(file); }
  if (!files.includes(path.join(paths.directory, "shadow.sqlite")) || !files.includes(paths.legacyBackup) || !files.includes(paths.directory + ".recovery-anchor.sqlite")) throw Error("Complete verified shadow candidate required");
  for (const file of files) if (real(file).nlink !== 1) throw Error("Hard-linked new storage file requires review");
  real(paths.directory, true);
  for (const file of files) { fs.chownSync(file, owner.uid, owner.gid); const fd = fs.openSync(file, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  fs.chownSync(paths.directory, owner.uid, owner.gid); syncDirectory(paths.directory); syncDirectory(path.dirname(paths.directory));
}
async function health({ expected, fetchImpl = fetch, clock = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 90000,
  checkWallet = require("./update-wallet-access").health } = {}) {
  const until = clock() + timeoutMs; let last;
  do {
    try {
      await checkWallet({ expected, capabilities: true, fetchImpl, clock, wait, timeoutMs: 0 });
      for (const origin of ["http://127.0.0.1:3109", "https://credits.koinosai.com"]) {
        const read = async suffix => { const response = await fetchImpl(origin + suffix, { redirect: "error", signal: AbortSignal.timeout(10000) }); const bytes = await response.text(); if (!response.ok || Buffer.byteLength(bytes) > 32768) throw Error("Storage runtime readiness HTTP failed"); return JSON.parse(bytes); };
        const h = await read("/health"), earnings = await read("/health/earnings");
        const now = clock(), epoch = earnings.currentEpoch;
        if (h.chainId !== expected.chainId || h.rewardRuntimeVersion !== 4 || h.rewardStorage?.schema !== 1 || h.rewardStorage?.mode !== "sqlite-shadow" || h.rewardStorage?.ready !== true ||
            earnings.schema !== 1 || earnings.ready !== true || !Array.isArray(earnings.reasons) || earnings.reasons.length || !Number.isSafeInteger(earnings.observedAt) || earnings.observedAt > now || now - earnings.observedAt > 90000 ||
            !Number.isSafeInteger(earnings.lastAvailabilitySuccess) || now - earnings.lastAvailabilitySuccess > 90000 || earnings.lastAvailabilitySuccess > now ||
            epoch?.epoch !== String(Math.floor(now / 86400000)) || epoch.budgetPresent !== true || epoch.dayPresent !== true || !Number.isSafeInteger(epoch.intervalCount) || epoch.intervalCount < 0 ||
            !Number.isSafeInteger(epoch.openedAt) || epoch.openedAt > now || !(epoch.lastIntervalEnd === null || (Number.isSafeInteger(epoch.lastIntervalEnd) && epoch.lastIntervalEnd <= now))) throw Error("SQLite worker and fresh earnings readiness not established");
      }
      return;
    } catch (error) { last = error; if (clock() >= until) break; await wait(Math.min(2000, until - clock())); }
  } while (clock() <= until);
  throw last || Error("Storage runtime readiness failed");
}
async function update({ repo = process.cwd(), paths: p = PATHS, run = command, log = console.log, drain = Prior.gracefulShutdown, checkHealth = health,
  storage = Storage, prepareSource = stageRelease, checkRelease = verifyRelease, chownCandidate = ownCandidate,
  assertSourceIdle = directory => require("../../lib/koin-network/storage-writer-lease").assertWriterLeaseCount(directory, 0, "Offline provider source") } = {}) {
  for (const dir of [p.work, p.releases, p.config, p.state]) real(dir, true);
  const held = [];
  try {
    for (const name of LOCKS) { const file = path.join(p.work, name); fs.mkdirSync(file, { mode: 0o700 }); held.push(file); }
    const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
    if (!/^[a-f0-9]{40}$/.test(target) || target === BASE || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Clean reviewed storage checkout required");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (REQUIRED.some(name => !changed.includes(name)) || changed.some(name => !ALLOWED.has(name))) throw Error("Only the exact reviewed storage release may be installed");
    const show = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key], undefined, true).trim();
    const checkUnit = () => { for (const [key, value] of Object.entries({ FragmentPath: p.unit, DropInPaths: "", Restart: "on-failure", RestartForceExitStatus: "", UnitFileState: "enabled" })) if (show(key) !== value) throw Error("Unexpected service " + key); };
    checkUnit(); real(p.unit); const baseDir = path.join(p.releases, BASE), targetDir = path.join(p.releases, target), current = show("WorkingDirectory");
    if (![baseDir, targetDir].includes(current)) throw Error("Unexpected active storage release");
    const runtimeFile = path.join(p.config, "runtime.json");
    if (real(runtimeFile).size > 1024 * 1024) throw Error("Oversized public configuration");
    const expected = runtimeTarget(runtimeFile), identity = storage.storageIdentity(JSON.parse(fs.readFileSync(runtimeFile))), fingerprint = configFingerprint(p.config);
    const ownerNumber = flag => { const value = run("id", [flag, "kai-koin-prepaid"], undefined, true).trim(); if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 4294967294) throw Error("Service uid/gid could not be verified"); return Number(value); };
    const expectedOwner = { uid: ownerNumber("-u"), gid: ownerNumber("-g") }, sourceStat = real(storage.storagePaths(p.state).sourceFile);
    if (sourceStat.uid !== expectedOwner.uid || sourceStat.gid !== expectedOwner.gid) throw Error("Legacy shadow owner differs from the service account; unchanged service requires review");
    const manifest = treeManifest(repo, target, run), treeHash = hash(JSON.stringify(manifest)), planFile = path.join(p.work, "kai-reward-storage-plan-" + target + ".json");
    let plan;
    if (fs.existsSync(planFile)) {
      const planStat = real(planFile);
      if (planStat.size > 256 * 1024 || planStat.nlink !== 1 || planStat.uid !== process.getuid?.() || (planStat.mode & 0o777) !== 0o600) throw Error("Unsafe storage deployment plan ownership or size"); plan = JSON.parse(fs.readFileSync(planFile));
      if (plan.schema !== 1 || plan.target !== target || plan.base !== BASE || plan.treeHash !== treeHash || plan.fingerprint !== fingerprint || !equal(plan.paths, p) || !["staged", "draining", "exited", "prepared", "activated", "unit", "started", "ready"].includes(plan.phase)) throw Error("Storage deployment plan no longer matches reviewed inputs");
      checkRelease(targetDir, manifest);
    } else {
      if (current !== baseDir || show("ActiveState") !== "active") throw Error("First storage activation requires the active reviewed base release");
      if (fs.existsSync(targetDir)) throw Error("Existing target without a verified deployment plan requires review");
      const oldUnit = fs.readFileSync(p.unit), nextUnit = validateUnit(oldUnit, p, baseDir, targetDir);
      run(process.execPath, ["--test", "--test-concurrency=1", ...PROBES], repo);
      prepareSource({ repo, target, targetDir, paths: p, run, manifest }); checkRelease(targetDir, manifest);
      if (configFingerprint(p.config) !== fingerprint || !fs.readFileSync(p.unit).equals(oldUnit)) throw Error("Configuration changed during release preparation");
      plan = { schema: 1, target, base: BASE, treeHash, fingerprint, paths: p, phase: "staged", oldUnit: oldUnit.toString("base64"), nextUnit: nextUnit.toString("base64"), mode: real(p.unit).mode & 0o777, initial: null, exited: null, startedProcess: null };
      atomic(planFile, JSON.stringify(plan));
    }
    const oldUnit = Buffer.from(plan.oldUnit, "base64"), nextUnit = Buffer.from(plan.nextUnit, "base64");
    if (!validateUnit(oldUnit, p, baseDir, targetDir).equals(nextUnit)) throw Error("Saved unit replacement differs from reviewed service");
    const save = phase => { plan.phase = phase; atomic(planFile, JSON.stringify(plan)); };
    const unchanged = () => { checkUnit(); if (configFingerprint(p.config) !== fingerprint || ![oldUnit, nextUnit].some(bytes => fs.readFileSync(p.unit).equals(bytes))) throw Error("Concurrent configuration or unit change preserved"); };
    unchanged();
    // Module load and pinned, read-only RPC checks run before the first drain,
    // and again on exact retry. They never read keys or open production journals.
    run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, "-e", "require(process.argv[1])", path.join(targetDir, "test-server.js")]);
    run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, path.join(targetDir, "deploy/koin-mainnet/check-rpc-recovery.js"), runtimeFile]);
    unchanged(); let state = Prior.processState(run);
    if (state.ActiveState === "active" && show("WorkingDirectory") === targetDir && fs.readFileSync(p.unit).equals(nextUnit)) {
      if (storage.inspectStorage(p.state, { identity }).mode !== "sqlite-shadow") throw Error("Running target lacks verified SQLite activation");
      await checkHealth({ expected }); unchanged(); save("ready"); return { installed: true, unchanged: true, commit: target, planFile };
    }
    if (state.ActiveState === "active") {
      if (show("WorkingDirectory") !== baseDir || !fs.readFileSync(p.unit).equals(oldUnit) || !["staged", "draining"].includes(plan.phase)) throw Error("Unexpected writer resumed during storage maintenance");
      plan.initial = state; save("draining");
      const exited = await drain({ run, assertUnchanged: unchanged, timeoutMs: 240000 });
      if (!Prior.sameCleanExit(Prior.processState(run), exited)) throw Error("Clean stopped process could not be verified"); plan.exited = exited; save("exited"); state = exited;
    } else {
      const prior = plan.startedProcess || plan.initial;
      if (!Prior.cleanExit(state) || !prior || state.ExecMainPID !== prior.MainPID || state.NRestarts !== prior.NRestarts || (!plan.startedProcess && plan.exited && !Prior.sameCleanExit(state, plan.exited))) throw Error("Interrupted install has no verified clean stopped process");
      plan.exited = state;
    }
    const assertQuiescent = () => { unchanged(); if (!Prior.sameCleanExit(Prior.processState(run), plan.exited)) throw Error("Stopped service identity changed during offline activation"); assertSourceIdle(path.join(p.state, "provider-devices")); };
    assertQuiescent(); const paths = storage.storagePaths(p.state);
    if (!fs.existsSync(paths.markerFile)) { storage.prepareStorage({ stateDir: p.state, identity, assertQuiescent }); save("prepared"); chownCandidate(paths, { expectedOwner }); assertQuiescent(); }
    storage.activateStorage({ stateDir: p.state, identity, assertQuiescent }); save("activated");
    // Offline validation opens SQLite as the installer and may recreate WAL/SHM
    // files. Reapply ownership after the final verified open while quiescent.
    assertQuiescent(); chownCandidate(paths, { expectedOwner }); assertQuiescent();
    assertQuiescent(); checkRelease(targetDir, manifest);
    if (!fs.readFileSync(p.unit).equals(nextUnit)) { atomic(p.unit, nextUnit, plan.mode); } save("unit");
    assertQuiescent(); run("systemctl", ["daemon-reload"]); assertQuiescent();
    if (show("WorkingDirectory") !== targetDir) throw Error("New unit was not loaded");
    run("systemctl", ["start", UNIT]); plan.startedProcess = Prior.processState(run); save("started"); unchanged();
    await checkHealth({ expected }); unchanged(); save("ready");
    log("Verified SQLite reward storage activated; forward-only runtime retained: " + target);
    return { installed: true, unchanged: false, commit: target, planFile };
  } catch (error) {
    log("Storage update stopped at a verified boundary. No old code, JSON, payment journal or recovery anchor was restored. Preserve the deployment plan and resume this exact reviewed release after resolving the reported failure.");
    throw error;
  } finally { for (const file of held.reverse()) fs.rmdirSync(file); }
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root, with no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, configFingerprint, treeManifest, verifyRelease, stageRelease, ownCandidate, BASE, REQUIRED, ALLOWED, PROBES, LOCKS, UNIT, PATHS };
