"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const U = require("./update-rpc-backoff");
process.umask(0o077);
const blob = bytes => crypto.createHash("sha1").update("blob " + Buffer.byteLength(bytes) + "\0").update(bytes).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-backoff-update-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), state: path.join(root, "state"), unit: path.join(root, U.UNIT) };
  for (const file of [p.releases, p.config, p.state]) fs.mkdirSync(file);
  const baseDir = path.join(p.releases, U.BASE), target = "a".repeat(40), targetDir = path.join(p.releases, target); fs.mkdirSync(baseDir);
  const config = { mode: "mainnet-pilot", accountMode: "public", schedulerUrl: "https://credits.koinosai.com/scheduler", policyHash: "f".repeat(64), deployment: { product: "prepaid-usd-v1", chainId: "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", credits: "18QmSHrMszxmYPaDB1jxzY35vYDcG6aomN", creditsHash: "0x1220" + "b".repeat(64) } };
  const runtimeFile = path.join(p.config, "runtime.json"), secretFile = path.join(p.config, "runtime-keys.json"), operatorFile = path.join(p.config, "operator-secret");
  fs.writeFileSync(runtimeFile, JSON.stringify(config)); fs.writeFileSync(secretFile, "never-read-secret"); fs.writeFileSync(operatorFile, "never-read-operator");
  const journals = ["cycle.sqlite", "claims.sqlite", "wallet-nonces.sqlite"].map(name => path.join(p.state, name)); for (const file of journals) fs.writeFileSync(file, "existing payment bytes");
  const oldUnit = Buffer.from(`[Service]\nUser=kai-koin-prepaid\nGroup=kai-koin-prepaid\nWorkingDirectory=${baseDir}\nExecStart=${process.execPath} ${baseDir}/test-server.js\nEnvironment=KAI_KOIN_TEST_CONFIG_DIR=${p.config}\nEnvironment=KAI_KOIN_TEST_STATE_DIR=${p.state}\nEnvironment=KAI_KOIN_TEST_PORT=3109\nEnvironmentFile=${p.config}/account.env\nReadWritePaths=${p.state}\nReadOnlyPaths=${p.config}\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nUMask=0077\nRestart=on-failure\n`); fs.writeFileSync(p.unit, oldUnit);
  const calls = [], logs = [], directory = path.join(p.state, "shadow"), sourceFile = path.join(p.state, "shadow.json"), markerFile = path.join(p.state, "active.json");
  fs.mkdirSync(directory); fs.mkdirSync(path.join(p.state, "provider-devices")); fs.writeFileSync(sourceFile, "unsupported sentinel"); fs.writeFileSync(markerFile, "verified marker");
  fs.writeFileSync(path.join(directory, "shadow.sqlite"), "existing SQLite bytes"); fs.writeFileSync(directory + ".recovery-anchor.sqlite", "existing shadow anchor");
  const preserved = [...journals, sourceFile, markerFile, path.join(directory, "shadow.sqlite"), directory + ".recovery-anchor.sqlite"], snapshots = new Map(preserved.map(file => [file, fs.readFileSync(file)]));
  let active = "active", pid = "42", execPid = "42", loaded = baseDir, dirty = "", changed = U.REQUIRED.join("\n"), restart = "on-failure", dropIns = "", status = "0", result = "success", restarts = "0", hook = () => {}, failHealth = false, idleHook = () => {}, activationMode = "sqlite-shadow";
  const state = () => ({ ActiveState: active, MainPID: pid, ExecMainPID: execPid, ExecMainCode: "1", ExecMainStatus: status, Result: result, NRestarts: restarts });
  const run = (exe, args) => {
    calls.push([exe, ...args]); hook(exe, args);
    if (exe === "git") { if (args[0] === "rev-parse") return target; if (args[0] === "status") return dirty; if (args[0] === "diff") return changed; if (args[0] === "ls-tree") return "100644 blob " + blob("source") + "\ttest-server.js\0"; }
    if (exe === "systemctl") {
      if (args[0] === "show") { const values = { ...state(), WorkingDirectory: loaded, FragmentPath: p.unit, DropInPaths: dropIns, Restart: restart, RestartForceExitStatus: "", UnitFileState: "enabled" }, key = args.at(-1).split("=")[1]; return key.includes(",") ? key.split(",").map(k => k + "=" + values[k]).join("\n") : values[key]; }
      if (args[0] === "daemon-reload") loaded = fs.readFileSync(p.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)[1];
      if (args[0] === "start") { active = "active"; pid = execPid = String(Number(execPid) + 1); }
    }
    return "";
  };
  const storage = { storageIdentity: () => ({ fixture: true }), inspectStorage() { return { mode: activationMode, descriptor: { storeId: "fixture" }, paths: { sourceFile }, directory, markerFile }; },
    prepareStorage() { assert.fail("Code update must never prepare migration"); }, activateStorage() { assert.fail("Code update must never activate migration"); } };
  const options = { paths: p, run, storage, log: message => logs.push(message),
    prepareSource({ targetDir }) { calls.push(["stage"]); fs.mkdirSync(targetDir); const file = path.join(targetDir, "test-server.js"); fs.writeFileSync(file, "source"); fs.chmodSync(file, 0o644); },
    async drain(o) { calls.push(["drain", o.timeoutMs]); o.assertUnchanged(); active = "inactive"; pid = "0"; return state(); },
    assertStorageIdle(info) { calls.push(["storage-idle"]); assert.equal(active, "inactive"); assert.equal(info.directory, directory); idleHook(); },
    async checkHealth() { calls.push(["health"]); if (failHealth) throw Error("new health unavailable"); } };
  return { p, target, targetDir, baseDir, oldUnit, calls, logs, storage, options, sourceFile, markerFile, directory, runtimeFile, secretFile, operatorFile, journals, state,
    get active() { return active; }, set active(v) { active = v; if (v === "inactive") pid = "0"; }, set loaded(v) { loaded = v; }, set hook(v) { hook = v; }, set idleHook(v) { idleHook = v; }, set dirty(v) { dirty = v; }, set changed(v) { changed = v; }, set restart(v) { restart = v; }, set dropIns(v) { dropIns = v; }, set failHealth(v) { failHealth = v; }, set status(v) { status = v; }, set result(v) { result = v; }, set restarts(v) { restarts = v; }, set activationMode(v) { activationMode = v; },
    assertPreserved() { for (const [file, bytes] of snapshots) assert.deepEqual(fs.readFileSync(file), bytes); },
    assertNoStop() { assert.equal(calls.some(row => row[0] === "drain" || (row[0] === "systemctl" && ["kill", "stop", "restart", "start"].includes(row[1]))), false); assert.equal(active, "active"); assert.deepEqual(fs.readFileSync(p.unit), oldUnit); } };
}
test("code preflight precedes clean drain and both writer checks; activation and journals remain unchanged", async t => {
  const f = fixture(t), result = await U.update(f.options); assert.equal(result.installed, true);
  const index = name => f.calls.findIndex(row => row[0] === name), drain = index("drain"), start = f.calls.findIndex(row => row[0] === "systemctl" && row[1] === "start");
  assert.ok(index("stage") < drain); assert.ok(f.calls.findIndex(row => row[0] === process.execPath && row[1] === "--test") < drain);
  assert.ok(f.calls.findIndex(row => row.some(v => String(v).endsWith("check-rpc-recovery.js"))) < drain);
  assert.deepEqual(f.calls[drain], ["drain", 240000]); assert.ok(drain < index("storage-idle")); assert.ok(index("storage-idle") < start);
  assert.equal((await U.update(f.options)).unchanged, true); assert.equal(f.calls.filter(row => row[0] === "drain").length, 1); f.assertPreserved();
});
test("unreviewed source, wrong service, missing activation, locks and failed tests do not stop production", async t => {
  for (const kind of ["dirty", "extra", "missing", "restart", "override", "release", "legacy", "missing-db", "lock", "probe"]) {
    const f = fixture(t);
    if (kind === "dirty") f.dirty = " M source"; if (kind === "extra") f.changed = U.REQUIRED.join("\n") + "\nsecret.js"; if (kind === "missing") f.changed = U.REQUIRED.slice(1).join("\n");
    if (kind === "restart") f.restart = "always"; if (kind === "override") f.dropIns = "/tmp/override.conf"; if (kind === "release") f.loaded = path.join(f.p.releases, "b".repeat(40));
    if (kind === "legacy") f.activationMode = "legacy"; if (kind === "missing-db") fs.unlinkSync(path.join(f.directory, "shadow.sqlite"));
    if (kind === "lock") fs.mkdirSync(path.join(f.p.work, U.LOCKS.at(-1)));
    if (kind === "probe") f.hook = (exe, args) => { if (exe === process.execPath && args[0] === "--test") throw Error("probe failed"); };
    await assert.rejects(U.update(f.options)); f.assertNoStop(); assert.equal(fs.existsSync(f.targetDir), false);
    assert.equal(fs.readdirSync(f.p.work).some(name => name.startsWith("kai-rpc-backoff-plan-")), false);
  }
});
test("pinned RPC preflight failure keeps the old runtime active and the exact staged plan can resume", async t => {
  const f = fixture(t); f.hook = (exe, args) => { if (exe === "runuser" && args.some(v => String(v).endsWith("check-rpc-recovery.js"))) throw Error("RPC unavailable"); };
  await assert.rejects(U.update(f.options), /RPC unavailable/); f.assertNoStop(); f.assertPreserved();
  f.hook = () => {}; assert.equal((await U.update(f.options)).installed, true); assert.equal(f.calls.filter(row => row[0] === "stage").length, 1);
});
test("clean interruption after drain resumes forward without restarting the previous writer", async t => {
  const f = fixture(t); f.idleHook = () => { throw Error("paused after drain"); };
  await assert.rejects(U.update(f.options), /paused/); assert.equal(f.active, "inactive"); assert.deepEqual(fs.readFileSync(f.p.unit), f.oldUnit);
  assert.equal(f.calls.some(row => row[0] === "systemctl" && row[1] === "start"), false); f.assertPreserved();
  f.idleHook = () => {}; assert.equal((await U.update(f.options)).installed, true); assert.equal(f.calls.filter(row => row[0] === "drain").length, 1); f.assertPreserved();
});
test("failure after unit replacement resumes forward from the same clean exit", async t => {
  const f = fixture(t); let failed = false;
  f.hook = (exe, args) => { if (exe === "systemctl" && args[0] === "daemon-reload" && !failed) { failed = true; throw Error("reload interrupted"); } };
  await assert.rejects(U.update(f.options), /reload interrupted/); assert.equal(f.active, "inactive"); assert.match(fs.readFileSync(f.p.unit, "utf8"), new RegExp(f.target));
  assert.equal((await U.update(f.options)).installed, true); assert.equal(f.calls.filter(row => row[0] === "drain").length, 1); f.assertPreserved();
});
test("failed new health retains new code and running SQLite state; exact retry only rechecks health", async t => {
  const f = fixture(t); f.failHealth = true; await assert.rejects(U.update(f.options), /health unavailable/);
  assert.equal(f.active, "active"); assert.match(fs.readFileSync(f.p.unit, "utf8"), new RegExp(f.target));
  f.failHealth = false; assert.equal((await U.update(f.options)).unchanged, true);
  assert.equal(f.calls.filter(row => row[0] === "drain").length, 1); assert.equal(f.calls.filter(row => row[0] === "systemctl" && row[1] === "start").length, 1); f.assertPreserved();
});
test("tampered source, config, marker, sentinel, plan and stopped process block resumed installation", async t => {
  for (const kind of ["source", "config", "marker", "sentinel", "plan", "mode", "exit", "restarts", "old-writer"]) {
    const f = fixture(t); f.idleHook = () => { throw Error("paused after drain"); }; await assert.rejects(U.update(f.options), /paused/); f.idleHook = () => {};
    if (kind === "source") fs.writeFileSync(path.join(f.targetDir, "test-server.js"), "altered");
    if (kind === "config") fs.appendFileSync(f.runtimeFile, "\n"); if (kind === "marker") fs.appendFileSync(f.markerFile, "changed"); if (kind === "sentinel") fs.appendFileSync(f.sourceFile, "changed");
    if (kind === "mode") fs.chmodSync(f.p.unit, 0o644);
    if (kind === "plan") { const file = path.join(f.p.work, "kai-rpc-backoff-plan-" + f.target + ".json"), plan = JSON.parse(fs.readFileSync(file)); plan.base = "b".repeat(40); fs.writeFileSync(file, JSON.stringify(plan)); }
    if (kind === "exit") f.status = "1"; if (kind === "restarts") f.restarts = "1"; if (kind === "old-writer") f.active = "active";
    await assert.rejects(U.update(f.options)); assert.equal(f.calls.some(row => row[0] === "systemctl" && row[1] === "start"), false);
  }
});
test("changes during drain and a live extra writer prevent unit replacement and startup", async t => {
  for (const kind of ["activation", "config", "lease"]) {
    const f = fixture(t), drain = f.options.drain;
    if (kind === "lease") f.idleHook = () => { throw Error("live shadow writer"); };
    else f.options.drain = async o => { const state = await drain(o); fs.appendFileSync(kind === "config" ? f.runtimeFile : f.sourceFile, "changed"); return state; };
    await assert.rejects(U.update(f.options)); assert.equal(f.active, "inactive"); assert.deepEqual(fs.readFileSync(f.p.unit), f.oldUnit);
    assert.equal(f.calls.some(row => row[0] === "systemctl" && row[1] === "start"), false);
  }
});
test("updater never reads signing keys, operator credentials or payment journal content", async t => {
  const f = fixture(t), read = fs.readFileSync, forbidden = [f.secretFile, f.operatorFile, ...f.journals, path.join(f.directory, "shadow.sqlite"), f.directory + ".recovery-anchor.sqlite"];
  fs.readFileSync = (file, ...args) => { if (forbidden.includes(String(file))) assert.fail("sensitive file read: " + path.basename(String(file))); return read(file, ...args); };
  try { await U.update(f.options); } finally { fs.readFileSync = read; }
  f.assertPreserved();
});
test("linked public configuration is rejected before reading its target or stopping service", async t => {
  const f = fixture(t), read = fs.readFileSync, seen = [];
  fs.unlinkSync(f.runtimeFile); fs.symlinkSync(f.secretFile, f.runtimeFile);
  fs.readFileSync = (file, ...args) => { seen.push(String(file)); return read(file, ...args); };
  try { await assert.rejects(U.update(f.options), /Real unlinked/); } finally { fs.readFileSync = read; }
  assert.equal(seen.includes(f.runtimeFile), false); assert.equal(seen.includes(f.secretFile), false); f.assertNoStop();
});
test("orphan staged release and unclean initial service require review without automatic cleanup", async t => {
  for (const kind of ["orphan", "inactive"]) {
    const f = fixture(t); if (kind === "orphan") fs.mkdirSync(f.targetDir); else f.active = "inactive";
    await assert.rejects(U.update(f.options)); assert.equal(f.calls.some(row => row[0] === "drain" || row[0] === "stage"), false);
    assert.deepEqual(fs.readFileSync(f.p.unit), f.oldUnit); f.assertPreserved();
  }
});
test("health requires new backoff version and existing v4 SQLite/earnings readiness on both origins", async () => {
  const now = 1800000000000, expected = { chainId: "chain" };
  for (const broken of [null, "local", "public", "worker", "stale"]) {
    const fetchImpl = async url => new Response(JSON.stringify(url.endsWith("/health") ? { chainId: "chain", rpcBackoffVersion: (broken === "local" && url.startsWith("http:")) || (broken === "public" && url.startsWith("https:")) ? undefined : 1, rewardRuntimeVersion: 4, rewardStorage: { schema: 1, mode: "sqlite-shadow", ready: broken !== "worker" } } : { schema: 1, ready: true, observedAt: now, reasons: [], lastAvailabilitySuccess: now - (broken === "stale" ? 100000 : 1000), currentEpoch: { epoch: String(Math.floor(now / 86400000)), budgetPresent: true, dayPresent: true, openedAt: now - 100000, intervalCount: 1, lastIntervalEnd: now - 30000 } }));
    const options = { expected, fetchImpl, clock: () => now, timeoutMs: 0, checkWallet: async () => {} };
    if (broken) await assert.rejects(U.health(options)); else await U.health(options);
  }
});
test("clean exit after SIGTERM but before saving exit evidence resumes from the saved initial process", async t => {
  const f = fixture(t), drain = f.options.drain; let once = true;
  f.options.drain = async o => { const exited = await drain(o); if (once) { once = false; throw Error("lost drain response"); } return exited; };
  await assert.rejects(U.update(f.options), /lost drain response/); assert.equal(f.active, "inactive"); assert.deepEqual(fs.readFileSync(f.p.unit), f.oldUnit);
  assert.equal((await U.update(f.options)).installed, true); assert.equal(f.calls.filter(row => row[0] === "drain").length, 1); f.assertPreserved();
});
test("lost start acknowledgement keeps the target writer and exact retry checks it without a second start", async t => {
  const f = fixture(t), run = f.options.run; let once = true;
  f.options.run = (exe, args, ...rest) => { const result = run(exe, args, ...rest); if (exe === "systemctl" && args[0] === "start" && once) { once = false; throw Error("lost start acknowledgement"); } return result; };
  await assert.rejects(U.update(f.options), /lost start acknowledgement/); assert.equal(f.active, "active"); assert.match(fs.readFileSync(f.p.unit, "utf8"), new RegExp(f.target));
  assert.equal((await U.update(f.options)).unchanged, true); assert.equal(f.calls.filter(row => row[0] === "systemctl" && row[1] === "start").length, 1); f.assertPreserved();
});
test("real read-only source and shadow anchor checks reject either live writer without modifying anchors", async t => {
  const { DatabaseSync } = require("node:sqlite");
  for (const blocked of [null, "provider", "shadow"]) {
    const f = fixture(t); delete f.options.assertStorageIdle;
    const anchors = [["provider", path.join(f.p.state, "provider-devices") + ".recovery-anchor.sqlite"], ["shadow", f.directory + ".recovery-anchor.sqlite"]];
    for (const [kind, file] of anchors) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      const db = new DatabaseSync(file);
      try { db.exec("CREATE TABLE leases (host TEXT NOT NULL,pid INTEGER NOT NULL)"); if (kind === blocked) db.prepare("INSERT INTO leases VALUES (?,?)").run(os.hostname(), process.pid); }
      finally { db.close(); }
    }
    const before = anchors.map(([, file]) => fs.readFileSync(file));
    if (blocked) {
      await assert.rejects(U.update(f.options), /Stop every/); assert.equal(f.active, "inactive"); assert.deepEqual(fs.readFileSync(f.p.unit), f.oldUnit);
      assert.equal(f.calls.some(row => row[0] === "systemctl" && row[1] === "start"), false);
    } else assert.equal((await U.update(f.options)).installed, true);
    anchors.forEach(([, file], i) => assert.deepEqual(fs.readFileSync(file), before[i]));
    for (const file of f.journals) assert.equal(fs.readFileSync(file, "utf8"), "existing payment bytes");
    assert.equal(fs.readFileSync(f.sourceFile, "utf8"), "unsupported sentinel"); assert.equal(fs.readFileSync(f.markerFile, "utf8"), "verified marker");
  }
});
