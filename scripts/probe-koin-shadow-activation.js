"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const { Signer, utils } = require("koilib"), S = require("../lib/koin-network/shadow-storage-activation"), M = require("../lib/koin-network/reward-manifest");
const { KoinShadow } = require("../lib/koin-network/shadow"), { ShadowStore } = require("../lib/koin-network/shadow-store"), P = require("../lib/koin-network/policy");
const { productionGuard, withUpdaterLocks } = require("../deploy/koin-mainnet/activate-reward-storage");
const hash = value => crypto.createHash("sha256").update(value).digest("hex"), signer = Signer.fromSeed("activation-fixture-verifier"), address = Signer.fromSeed("activation-fixture-wallet").address;
const addr = name => Signer.fromSeed("activation-fixture-" + name).address;
const target = M.target({ chainId: utils.encodeBase64url(Buffer.from("1220" + hash("chain"), "hex")), credits: addr("credits"), creditsHash: "0x1220" + hash("credits"),
  rewards: addr("rewards"), rewardsHash: "0x1220" + hash("rewards"), token: addr("token"), tokenHash: "0x1220" + hash("token"), verifier: signer.address, version: "1", workCapBps: 8000 });
const identity = { schedulerUrl: "https://scheduler.invalid/scheduler", policyHash: hash("policy"), target };
async function fixture(t, { manifest = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-activation-")), paths = S.storagePaths(root); let now = P.DAY;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = new KoinShadow(paths.legacyDirectory, { clock: () => now }); legacy.open("100000000000");
  legacy.qualify({ address, capacityId: "one", model: "model", modelHash: hash("model"), benchmarkHash: hash("benchmark"), modelWeight: "10000", coverageBps: 10000, expires: now + P.DAY });
  for (let i = 0; i < 4; i++) { now = P.DAY + i * 25000; legacy.observe(address, { schema: 1, session: "a".repeat(32), sequence: i, at: now, model: "model", modelHash: hash("model"), ready: true }); }
  now = P.DAY + 105001; legacy.tick();
  const evidence = legacy.getManifestEvidence(1), tree = M.build(target, "1", evidence.allocation.allocations.filter(row => BigInt(row.availability) + BigInt(row.work) > 0n));
  const m = { schema: 1, mode: "reward-rehearsal", target, epoch: "1", evidenceHash: evidence.evidenceHash, root: tree.root,
    allocations: tree.claims.map(({ address, availability, work }) => ({ address, availability, work })) };
  const envelope = { manifest: m, signature: Buffer.from(await signer.signHash(M.signingHash(m))).toString("base64") }, manifestFile = path.join(root, "manifest-1.json");
  if (manifest) fs.writeFileSync(manifestFile, JSON.stringify(envelope, null, 2));
  const source = fs.readFileSync(paths.sourceFile), options = { stateDir: root, identity, assertQuiescent() {} };
  const f = { root, paths, legacy, source, envelope, manifestFile, options,
    prepare: extra => S.prepareStorage({ ...options, ...extra }), activate: extra => S.activateStorage({ ...options, ...extra }), inspect: () => S.inspectStorage(root, { identity }),
    open: () => new ShadowStore(paths.directory, { identity, staging: true }) };
  return f;
}
if (process.argv[2] === "--crash") {
  const options = JSON.parse(Buffer.from(process.argv[3], "base64url"));
  S.activateStorage({ ...options, assertQuiescent() {}, onStage(stage) { if (stage === "sentinel-installed") process.kill(process.pid, "SIGKILL"); } });
} else {
test("verified offline activation preserves original history, signatures and unrelated payment state", async t => {
  const f = await fixture(t); assert.equal(f.inspect().mode, "legacy");
  const untouched = path.join(f.root, "reward-cycle.sqlite"); fs.writeFileSync(untouched, "unrelated payment journal bytes");
  const manifest = fs.readFileSync(f.manifestFile), result = f.prepare();
  assert.equal(result.prepared, true); assert.equal(result.activated, false); assert.deepEqual(result.sealedEpochs, ["1"]);
  assert.deepEqual(fs.readFileSync(f.paths.sourceFile), f.source); assert.deepEqual(fs.readFileSync(f.paths.legacyBackup), f.source);
  assert.equal(fs.statSync(f.paths.legacyBackup).mode & 0o777, 0o400); assert.throws(f.inspect, /incomplete/);
  const store = f.open(); assert.equal(store.getDayProgress(1).sealed, true); store.close();
  assert.equal(f.activate().activated, true); assert.equal(f.inspect().mode, "sqlite-shadow");
  assert.throws(() => new KoinShadow(f.paths.legacyDirectory), /Invalid KOIN shadow ledger/);
  assert.deepEqual(fs.readFileSync(f.manifestFile), manifest); assert.equal(fs.readFileSync(untouched, "utf8"), "unrelated payment journal bytes");
  assert.equal(f.activate().alreadyActive, true); assert.throws(f.prepare, /already active/);
});
test("a crash after the downgrade sentinel resumes only the same verified preparation", async t => {
  const f = await fixture(t); f.prepare();
  const child = spawnSync(process.execPath, [__filename, "--crash", Buffer.from(JSON.stringify({ stateDir: f.root, identity })).toString("base64url")], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL", child.stderr); assert.equal(fs.existsSync(f.paths.markerFile), false);
  assert.throws(f.inspect, /maintenance/); assert.throws(() => new KoinShadow(f.paths.legacyDirectory), /Invalid/);
  assert.equal(f.activate().activated, true); assert.equal(f.inspect().mode, "sqlite-shadow"); assert.deepEqual(fs.readFileSync(f.paths.legacyBackup), f.source);
});
test("verified candidate and preparation stages are idempotently resumable", async t => {
  const f = await fixture(t); assert.throws(() => f.prepare({ onStage(stage) { if (stage === "candidate-migrated") throw Error("simulated power loss"); } }), /power loss/);
  assert.equal(fs.existsSync(f.paths.preparedFile), false); assert.deepEqual(fs.readFileSync(f.paths.sourceFile), f.source);
  const a = f.prepare(), b = f.prepare(); assert.deepEqual(a, b); f.activate();
});
test("a prepared source must stay byte-identical and new manifests cannot slip through", async t => {
  for (const change of ["source", "manifest", "missing", "new"]) {
    const f = await fixture(t); f.prepare();
    if (change === "source") fs.appendFileSync(f.paths.sourceFile, "\n");
    if (change === "manifest") fs.appendFileSync(f.manifestFile, "\n");
    if (change === "missing") fs.unlinkSync(f.manifestFile);
    if (change === "new") fs.writeFileSync(path.join(f.root, "manifest-2.json"), JSON.stringify(f.envelope));
    assert.throws(f.activate, /changed/); assert.equal(fs.existsSync(f.paths.markerFile), false);
  }
});
test("saved manifests need valid signatures, matching deployment, filename and exact migrated evidence", async t => {
  for (const kind of ["signature", "target", "filename", "evidence", "allocation"]) {
    const f = await fixture(t), e = structuredClone(f.envelope);
    if (kind === "signature") e.signature = Buffer.from(await Signer.fromSeed("wrong-verifier").signHash(M.signingHash(e.manifest))).toString("base64");
    if (kind === "target") e.manifest.target.creditsHash = "0x1220" + hash("different-code");
    if (kind === "evidence") e.manifest.evidenceHash = hash("different-history");
    if (kind === "allocation") { e.manifest.allocations[0].availability = "1"; e.manifest.root = M.build(target, "1", e.manifest.allocations).root; }
    if (["target", "evidence", "allocation"].includes(kind)) e.signature = Buffer.from(await signer.signHash(M.signingHash(e.manifest))).toString("base64");
    fs.writeFileSync(f.manifestFile, JSON.stringify(e)); if (kind === "filename") fs.renameSync(f.manifestFile, path.join(f.root, "manifest-2.json"));
    assert.throws(f.prepare); assert.equal(fs.existsSync(f.paths.preparedFile), false); assert.deepEqual(fs.readFileSync(f.paths.sourceFile), f.source);
  }
});
test("marker, sentinel, path and deployment form a strict startup agreement", async t => {
  for (const kind of ["marker", "sentinel", "missing-marker", "missing-source", "rewind", "identity", "directory", "extra"]) {
    const f = await fixture(t); f.prepare(); f.activate();
    if (kind === "marker") { const m = JSON.parse(fs.readFileSync(f.paths.markerFile)); m.sourceHash = hash("other"); fs.writeFileSync(f.paths.markerFile, JSON.stringify(m)); }
    if (kind === "sentinel") { const m = JSON.parse(fs.readFileSync(f.paths.sourceFile)); m.descriptorHash = hash("other"); fs.writeFileSync(f.paths.sourceFile, JSON.stringify(m)); }
    if (kind === "missing-marker") fs.unlinkSync(f.paths.markerFile);
    if (kind === "missing-source") fs.unlinkSync(f.paths.sourceFile);
    if (kind === "rewind") fs.writeFileSync(f.paths.sourceFile, f.source);
    if (kind === "directory") { const m = JSON.parse(fs.readFileSync(f.paths.markerFile)); m.directory = path.join(f.root, "elsewhere"); fs.writeFileSync(f.paths.markerFile, JSON.stringify(m)); }
    if (kind === "extra") { const m = JSON.parse(fs.readFileSync(f.paths.markerFile)); m.fallback = true; fs.writeFileSync(f.paths.markerFile, JSON.stringify(m)); }
    if (kind === "identity") assert.throws(() => S.inspectStorage(f.root, { identity: { ...identity, policyHash: hash("other") } }));
    else assert.throws(f.inspect);
  }
});
test("live writers, missing guards and changed clean-exit evidence stop activation", async t => {
  const f = await fixture(t); assert.throws(() => f.prepare({ assertQuiescent: undefined }), /quiescence/); f.prepare();
  const store = f.open(); try { assert.throws(f.activate, /Stop every/); } finally { store.close(); }
  let checks = 0; assert.throws(() => f.activate({ assertQuiescent() { if (++checks === 4) throw Error("service restarted"); } }), /service restarted/);
  assert.deepEqual(fs.readFileSync(f.paths.sourceFile), f.source); assert.equal(fs.existsSync(f.paths.markerFile), false);
});
test("altered backup and staged evidence fail closed without rewriting the source", async t => {
  for (const kind of ["backup", "records", "sealed", "anchor"]) {
    const f = await fixture(t, { manifest: false }); f.prepare();
    if (kind === "backup") { fs.chmodSync(f.paths.legacyBackup, 0o600); fs.appendFileSync(f.paths.legacyBackup, "\n"); }
    if (kind === "anchor") fs.renameSync(f.paths.directory + ".recovery-anchor.sqlite", f.paths.directory + ".moved-anchor");
    if (kind === "records") { const store = f.open(); store.expireQualifications(["one"], P.DAY + 200000); store.close(); }
    if (kind === "sealed") { const store = f.open(); store.markSealed(1); store.close(); }
    assert.throws(f.activate); assert.deepEqual(fs.readFileSync(f.paths.sourceFile), f.source); assert.equal(fs.existsSync(f.paths.markerFile), false);
  }
});
test("derived progress, eligibility, presence and allocation columns are reverified before activation", async t => {
  for (const sql of ["UPDATE days SET next_start=next_start+60000", "UPDATE days SET interval_count=interval_count+1", "UPDATE qualifications SET expires=expires+1", "UPDATE presence_latest SET retained_from=1", "UPDATE presence_samples SET observed_at=observed_at+1", "UPDATE availability SET atoms='1'"]) {
    const f = await fixture(t); f.prepare(); const store = f.open(); try { store._write(() => store.db.exec(sql)); } finally { store.close(); }
    assert.throws(f.activate, /semantic index/); assert.deepEqual(fs.readFileSync(f.paths.sourceFile), f.source);
  }
});
test("selectors never import SQLite and reject linked storage paths", async t => {
  const f = await fixture(t), modulePath = require.resolve("../lib/koin-network/shadow-storage-activation");
  const check = () => { const child = spawnSync(process.execPath, ["-e", `const M=require('node:module'),old=M._load;M._load=function(n,...a){if(n==='node:sqlite'||n.includes('shadow-store'))throw Error('database imported');return old.call(this,n,...a)};const s=require(${JSON.stringify(modulePath)});s.inspectStorage(${JSON.stringify(f.root)},{identity:${JSON.stringify(identity)}});`], { encoding: "utf8" }); assert.equal(child.status, 0, child.stderr); };
  check(); f.prepare(); f.activate(); check();
  fs.renameSync(f.paths.legacyDirectory, f.paths.legacyDirectory + "-real"); fs.symlinkSync(f.paths.legacyDirectory + "-real", f.paths.legacyDirectory); assert.throws(f.inspect, /Physical/);
});
test("atomic activation files retain the service-owned legacy file identity", { skip: process.getuid?.() !== 0 }, async t => {
  const f = await fixture(t);
  try { fs.chownSync(f.paths.sourceFile, 60001, 60002); }
  catch (error) { if (!["EINVAL", "EPERM"].includes(error.code)) throw error; t.skip("This host does not map a second service uid/gid"); return; }
  f.prepare(); f.activate();
  for (const file of [f.paths.sourceFile, f.paths.preparedFile, f.paths.markerFile]) { const stat = fs.statSync(file); assert.equal(stat.uid, 60001); assert.equal(stat.gid, 60002); }
});
test("production guard binds clean service exit, release, unit and public config without keys", async t => {
  const f = await fixture(t), config = path.join(f.root, "runtime.json"), release = "/opt/kai-koin-prepaid/releases/" + "a".repeat(40); fs.writeFileSync(config, "{}");
  const values = { ActiveState: "inactive", MainPID: "0", ExecMainPID: "123", ExecMainCode: "1", ExecMainStatus: "0", Result: "success", NRestarts: "0", WorkingDirectory: release,
    FragmentPath: "/etc/systemd/system/kai-koin-prepaid.service", DropInPaths: "", Restart: "on-failure", RestartForceExitStatus: "", UnitFileState: "enabled" };
  const run = () => Object.entries(values).map(([k, v]) => k + "=" + v).join("\n"), guard = productionGuard({ expectedRelease: release, configFile: config, run }); guard();
  values.ExecMainPID = "124"; assert.throws(guard, /identity changed/); values.ExecMainPID = "123"; guard();
  values.ActiveState = "active"; assert.throws(guard, /ActiveState/); values.ActiveState = "inactive";
  fs.appendFileSync(config, "\n"); assert.throws(guard, /configuration changed/);
  const usd = S.storageIdentity({ schedulerUrl: identity.schedulerUrl, policyHash: identity.policyHash, deployment: { ...target, product: "prepaid-usd-v1" }, version: 1 });
  assert.equal(usd.target.rewardBasis, "usd-pool"); assert.equal(usd.policyHash, identity.policyHash);
});
test("updater locks exclude concurrent maintenance and never remove another owner's lock", async t => {
  const f = await fixture(t), names = ["first.lock", "second.lock"], second = path.join(f.root, names[1]); fs.mkdirSync(second);
  assert.throws(() => withUpdaterLocks(() => assert.fail(), { work: f.root, names }));
  assert.equal(fs.existsSync(path.join(f.root, names[0])), false); assert.equal(fs.existsSync(second), true); fs.rmdirSync(second);
  assert.equal(withUpdaterLocks(() => 42, { work: f.root, names }), 42); assert.equal(fs.existsSync(second), false);
});
}
