"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const U = require("./update-reward-storage");
const blob = bytes => crypto.createHash("sha1").update("blob " + Buffer.byteLength(bytes) + "\0").update(bytes).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reward-storage-update-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), state: path.join(root, "state"), unit: path.join(root, U.UNIT) };
  for (const file of [p.releases, p.config, p.state]) fs.mkdirSync(file);
  const baseDir = path.join(p.releases, U.BASE), target = "a".repeat(40), targetDir = path.join(p.releases, target); fs.mkdirSync(baseDir);
  const config = { mode: "mainnet-pilot", accountMode: "public", schedulerUrl: "https://credits.koinosai.com/scheduler", policyHash: "f".repeat(64), deployment: { product: "prepaid-usd-v1", chainId: "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", credits: "18QmSHrMszxmYPaDB1jxzY35vYDcG6aomN", creditsHash: "0x1220" + "b".repeat(64) } };
  const runtimeFile = path.join(p.config, "runtime.json"), secretFile = path.join(p.config, "runtime-keys.json"); fs.writeFileSync(runtimeFile, JSON.stringify(config)); fs.writeFileSync(secretFile, "never-read-secret");
  const journals = ["cycle.sqlite", "claims.sqlite", "wallet-nonces.sqlite"].map(name => path.join(p.state, name)); for (const file of journals) fs.writeFileSync(file, "existing payment bytes");
  const oldUnit = Buffer.from(`[Service]\nUser=kai-koin-prepaid\nGroup=kai-koin-prepaid\nWorkingDirectory=${baseDir}\nExecStart=${process.execPath} ${baseDir}/test-server.js\nEnvironment=KAI_KOIN_TEST_CONFIG_DIR=${p.config}\nEnvironment=KAI_KOIN_TEST_STATE_DIR=${p.state}\nEnvironment=KAI_KOIN_TEST_PORT=3109\nEnvironmentFile=${p.config}/account.env\nReadWritePaths=${p.state}\nReadOnlyPaths=${p.config}\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nUMask=0077\nRestart=on-failure\n`); fs.writeFileSync(p.unit, oldUnit);
  const calls = [], logs = [], paths = { sourceFile: path.join(p.state, "shadow.json"), markerFile: path.join(p.state, "active.json"), directory: path.join(p.state, "candidate"), legacyBackup: path.join(p.state, "candidate", "legacy.json") }; fs.writeFileSync(paths.sourceFile, "legacy JSON bytes");
  let active = "active", pid = "42", execPid = "42", loaded = baseDir, dirty = "", changed = U.REQUIRED.join("\n"), restart = "on-failure", status = "0", result = "success", hook = () => {}, failHealth = false;
  const state = () => ({ ActiveState: active, MainPID: pid, ExecMainPID: execPid, ExecMainCode: "1", ExecMainStatus: status, Result: result, NRestarts: "0" });
  const run = (exe, args) => {
    calls.push([exe, ...args]); hook(exe, args);
    if (exe === "id") return String(args[0] === "-u" ? process.getuid() : process.getgid());
    if (exe === "git") { if (args[0] === "rev-parse") return target; if (args[0] === "status") return dirty; if (args[0] === "diff") return changed; if (args[0] === "ls-tree") return "100644 blob " + blob("source") + "\ttest-server.js\0"; }
    if (exe === "systemctl") {
      if (args[0] === "show") { const values = { ...state(), WorkingDirectory: loaded, FragmentPath: p.unit, DropInPaths: "", Restart: restart, RestartForceExitStatus: "", UnitFileState: "enabled" }, key = args.at(-1).split("=")[1]; return key.includes(",") ? key.split(",").map(k => k + "=" + values[k]).join("\n") : values[key]; }
      if (args[0] === "daemon-reload") loaded = fs.readFileSync(p.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)[1];
      if (args[0] === "start") { active = "active"; pid = execPid = String(Number(execPid) + 1); }
    }
    return "";
  };
  const storage = { storageIdentity: () => ({ fixture: true }), storagePaths: () => paths,
    prepareStorage(o) { calls.push(["prepare"]); o.assertQuiescent(); if (!fs.existsSync(paths.directory)) fs.mkdirSync(paths.directory); fs.writeFileSync(paths.legacyBackup, "legacy JSON bytes"); },
    activateStorage(o) { calls.push(["activate"]); o.assertQuiescent(); fs.writeFileSync(paths.sourceFile, "unsupported sentinel"); fs.writeFileSync(paths.markerFile, "active marker"); },
    inspectStorage() { return { mode: fs.existsSync(paths.markerFile) ? "sqlite-shadow" : "legacy" }; } };
  const options = { paths: p, run, storage, log: message => logs.push(message),
    prepareSource({ targetDir }) { calls.push(["stage"]); fs.mkdirSync(targetDir); fs.writeFileSync(path.join(targetDir, "test-server.js"), "source", { mode: 0o644 }); },
    async drain(o) { calls.push(["drain", o.timeoutMs]); o.assertUnchanged(); active = "inactive"; pid = "0"; return state(); },
    chownCandidate() { calls.push(["ownership", fs.existsSync(paths.markerFile)]); }, assertSourceIdle() { calls.push(["source-idle"]); },
    async checkHealth() { calls.push(["health"]); if (failHealth) throw Error("new health unavailable"); } };
  return { p, target, targetDir, baseDir, oldUnit, calls, logs, storage, options, paths, runtimeFile, secretFile, journals,
    get active() { return active; }, set active(v) { active = v; if (v === "inactive") pid = "0"; }, set hook(v) { hook = v; }, set dirty(v) { dirty = v; }, set changed(v) { changed = v; }, set restart(v) { restart = v; }, set failHealth(v) { failHealth = v; }, set status(v) { status = v; }, set result(v) { result = v; },
    assertPreserved() { for (const file of journals) assert.equal(fs.readFileSync(file, "utf8"), "existing payment bytes"); assert.equal(fs.readFileSync(secretFile, "utf8"), "never-read-secret"); } };
}
test("source checks, dependencies and pinned RPC checks precede a 240-second clean drain; activation precedes code start", async t => {
  const f = fixture(t); const result = await U.update(f.options); assert.equal(result.installed, true);
  const index = name => f.calls.findIndex(row => row[0] === name);
  assert.ok(index("stage") < index("drain")); assert.ok(f.calls.findIndex(row => row.some(v => String(v).endsWith("check-rpc-recovery.js"))) < index("drain"));
  assert.deepEqual(f.calls[index("drain")], ["drain", 240000]); assert.ok(index("prepare") < index("ownership")); assert.ok(index("ownership") < index("activate"));
  assert.ok(index("activate") < f.calls.findIndex(row => row[0] === "systemctl" && row[1] === "start"));
  assert.deepEqual(f.calls.filter(row => row[0] === "ownership"), [["ownership", false], ["ownership", true]]);
  assert.equal((await U.update(f.options)).unchanged, true); assert.equal(f.calls.filter(row => row[0] === "drain").length, 1); f.assertPreserved();
});
test("dirty, unreviewed, overridden and locked deployments cannot stop production", async t => {
  for (const kind of ["dirty", "extra", "missing", "restart", "lock", "probe"]) {
    const f = fixture(t); if (kind === "dirty") f.dirty = " M anything"; if (kind === "extra") f.changed = U.REQUIRED.join("\n") + "\nsecret.js"; if (kind === "missing") f.changed = U.REQUIRED.slice(1).join("\n");
    if (kind === "restart") f.restart = "always"; if (kind === "lock") fs.mkdirSync(path.join(f.p.work, U.LOCKS.at(-1)));
    if (kind === "probe") f.hook = (exe, args) => { if (exe === process.execPath && args[0] === "--test") throw Error("probe failure"); };
    await assert.rejects(U.update(f.options)); assert.equal(f.calls.some(row => row[0] === "drain"), false); assert.deepEqual(fs.readFileSync(f.p.unit), f.oldUnit); f.assertPreserved();
  }
});
test("failed preflight leaves the old writer active and a verified staged plan supports exact retry", async t => {
  const f = fixture(t); f.hook = (exe, args) => { if (exe === "runuser" && args.some(v => String(v).endsWith("check-rpc-recovery.js"))) throw Error("RPC unavailable"); };
  await assert.rejects(U.update(f.options), /RPC unavailable/); assert.equal(f.active, "active"); assert.equal(f.calls.some(row => row[0] === "drain"), false);
  f.hook = () => {}; assert.equal((await U.update(f.options)).installed, true); assert.equal(f.calls.filter(row => row[0] === "stage").length, 1);
});
test("activation failure after sentinel never restarts old code and exact retry resumes forward", async t => {
  const f = fixture(t), activate = f.storage.activateStorage; let once = true;
  f.storage.activateStorage = o => { activate(o); if (once) { once = false; throw Error("interrupted after sentinel"); } };
  await assert.rejects(U.update(f.options), /after sentinel/); assert.equal(f.active, "inactive"); assert.deepEqual(fs.readFileSync(f.p.unit), f.oldUnit);
  assert.equal(f.calls.some(row => row[0] === "systemctl" && row[1] === "start"), false); assert.equal(fs.readFileSync(f.paths.sourceFile, "utf8"), "unsupported sentinel");
  assert.equal((await U.update(f.options)).installed, true); assert.equal(f.calls.filter(row => row[0] === "drain").length, 1); f.assertPreserved();
});
test("failed new health retains the new unit and runtime without a JSON or old-code rollback", async t => {
  const f = fixture(t); f.failHealth = true; await assert.rejects(U.update(f.options), /health unavailable/);
  assert.equal(f.active, "active"); assert.match(fs.readFileSync(f.p.unit, "utf8"), new RegExp(f.target));
  assert.equal(f.calls.filter(row => row[0] === "drain").length, 1); assert.equal(f.calls.filter(row => row[0] === "systemctl" && row[1] === "start").length, 1);
  f.failHealth = false; assert.equal((await U.update(f.options)).unchanged, true); f.assertPreserved();
});
test("changed source, config and stopped process evidence refuse an interrupted plan", async t => {
  for (const kind of ["source", "config", "exit"]) {
    const f = fixture(t), prepare = f.storage.prepareStorage; f.storage.prepareStorage = () => { throw Error("paused after drain"); };
    await assert.rejects(U.update(f.options), /paused/); f.storage.prepareStorage = prepare;
    if (kind === "source") fs.writeFileSync(path.join(f.targetDir, "test-server.js"), "altered");
    if (kind === "config") fs.appendFileSync(f.runtimeFile, "\n"); if (kind === "exit") f.status = "1";
    await assert.rejects(U.update(f.options)); assert.equal(f.calls.some(row => row[0] === "systemctl" && row[1] === "start"), false); f.assertPreserved();
  }
});
test("configuration fingerprint never reads a signing key or operator secret", async t => {
  const f = fixture(t), read = fs.readFileSync, seen = [];
  fs.readFileSync = (file, ...args) => { seen.push(String(file)); if (String(file) === f.secretFile) throw Error("secret read"); return read(file, ...args); };
  try { assert.match(U.configFingerprint(f.p.config), /^[a-f0-9]{64}$/); } finally { fs.readFileSync = read; }
  assert.deepEqual(seen, [f.runtimeFile]); const before = U.configFingerprint(f.p.config); fs.chmodSync(f.secretFile, 0o400); assert.notEqual(U.configFingerprint(f.p.config), before);
});
test("linked public configuration is rejected before reading its target or stopping the service", async t => {
  const f = fixture(t), read = fs.readFileSync, seen = [];
  fs.unlinkSync(f.runtimeFile); fs.symlinkSync(f.secretFile, f.runtimeFile);
  fs.readFileSync = (file, ...args) => { seen.push(String(file)); return read(file, ...args); };
  try { await assert.rejects(U.update(f.options), /Real storage deployment path/); }
  finally { fs.readFileSync = read; }
  assert.equal(seen.includes(f.runtimeFile), false); assert.equal(seen.includes(f.secretFile), false);
  assert.equal(f.calls.some(row => row[0] === "drain"), false);
});
test("release verification rejects missing, extra, changed and linked code", async t => {
  const f = fixture(t), directory = path.join(f.p.releases, "verify"); fs.mkdirSync(directory); const file = path.join(directory, "entry.js"), manifest = [{ name: "entry.js", mode: "100644", blob: blob("safe") }];
  fs.writeFileSync(file, "safe", { mode: 0o644 }); U.verifyRelease(directory, manifest);
  fs.chmodSync(file, 0o666); assert.throws(() => U.verifyRelease(directory, manifest), /mode/); fs.chmodSync(file, 0o644);
  const linked = path.join(f.p.work, "external-link"); fs.linkSync(file, linked); assert.throws(() => U.verifyRelease(directory, manifest), /link count/); fs.unlinkSync(linked);
  fs.writeFileSync(file, "changed"); assert.throws(() => U.verifyRelease(directory, manifest)); fs.writeFileSync(file, "safe");
  fs.writeFileSync(path.join(directory, "extra.js"), "extra"); assert.throws(() => U.verifyRelease(directory, manifest)); fs.unlinkSync(path.join(directory, "extra.js"));
  fs.unlinkSync(file); assert.throws(() => U.verifyRelease(directory, manifest)); fs.symlinkSync(f.runtimeFile, file); assert.throws(() => U.verifyRelease(directory, manifest));
});
test("health requires v4 SQLite worker readiness and fresh earnings on both origins", async () => {
  const now = 1800000000000, expected = { chainId: "chain" };
  for (const broken of [null, "mode", "worker", "stale", "public"]) {
    const fetchImpl = async url => new Response(JSON.stringify(url.endsWith("/health") ? { chainId: "chain", rewardRuntimeVersion: 4, rewardStorage: { schema: 1, mode: broken === "mode" ? "legacy-json" : "sqlite-shadow", ready: broken !== "worker" && !(broken === "public" && url.startsWith("https:")) } } : { schema: 1, ready: true, observedAt: now, reasons: [], lastAvailabilitySuccess: now - (broken === "stale" ? 100000 : 1000), currentEpoch: { epoch: String(Math.floor(now / 86400000)), budgetPresent: true, dayPresent: true, openedAt: now - 100000, intervalCount: 1, lastIntervalEnd: now - 30000 } }));
    let wallets = 0; const options = { expected, fetchImpl, clock: () => now, timeoutMs: 0, checkWallet: async o => { wallets++; assert.equal(o.capabilities, true); } }; if (broken) await assert.rejects(U.health(options)); else await U.health(options); assert.equal(wallets, 1);
  }
});
