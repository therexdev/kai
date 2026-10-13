"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm"), crypto = require("node:crypto");
const source = fs.readFileSync(path.join(__dirname, "../deploy/koin-mainnet/reviewed-renewals/2026-10-13.js"), "utf8");
const owner = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK", capacityId = "pilot-2592ee13a89f212f";
const modelHash = "1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370";
const benchmarkHash = "b57a896e1bf4d0cfdf7154ddaca6a89ac17687bdf4a379d6eb2a29fbd8650609";
const priorHash = "730b29967b4397a0251e0a85d50bc5da227941ae5abae7ebbd29f4d87f173b39";
const at = 1791929965183, expires = at + 86400000;
const old = { address: owner, capacityId, model: "koinos-fast", modelHash, benchmarkHash: priorHash,
  modelWeight: "6124", coverageBps: 10000, expires: 1791743121324 };
const renewed = { ...old, benchmarkHash, expires };
const unrelated = { address: "different-reviewed-provider", capacityId: "different-capacity", note: "preserve this exact record" };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-renewal-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { "/etc/kai-koin-mainnet-pilot/runtime.json": path.join(root, "service/runtime.json"),
    "/root/kai-mainnet-bootstrap/qualifications.json": path.join(root, "bootstrap/qualifications.json"),
    "/etc/kai-koin-mainnet-pilot/qualifications.json": path.join(root, "service/qualifications.json") };
  fs.mkdirSync(path.join(root, "service")); fs.mkdirSync(path.join(root, "bootstrap"));
  const files = [paths["/root/kai-mainnet-bootstrap/qualifications.json"], paths["/etc/kai-koin-mainnet-pilot/qualifications.json"]];
  const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  const config = { mode: "mainnet-pilot", schedulerUrl: "https://payments.koinosai.com/scheduler", deployment: {
    chainId: "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", credits: "13xiS64Z7mQXBNXniKPYRbFDCaNfvKbrPT", rewards: "1E1Stp1xMGt5ZmSTzEknLVyi79j9hDK9iT" }, tokenizer: { modelHash } };
  save(paths["/etc/kai-koin-mainnet-pilot/runtime.json"], config);
  files.forEach(file => save(file, [old, unrelated]));
  if (process.getuid?.() === 0) {
    try { fs.chownSync(files[1], 12345, 12346); }
    catch (error) { if (!["EINVAL", "EPERM"].includes(error.code)) throw error; } // Restricted user namespaces may map only this UID.
  }
  const hardware = { platform: "win32", arch: "x64", cpu: { model: "fixture CPU", cores: 16 }, ramBytes: 33816125440, gpus: [{ name: "fixture GPU" }] };
  const fingerprint = crypto.createHash("sha256").update("win32|x64|fixture CPU|16|34|fixture GPU").digest("hex").slice(0, 16);
  // Keep production identity constants intact except the expected digest of
  // synthetic hardware. Every filesystem path is redirected into this fixture.
  let script = source.replace('fingerprint !== "2592ee13a89f212f"', `fingerprint !== "${fingerprint}"`);
  assert.notEqual(script, source);
  for (const [from, to] of Object.entries(paths)) script = script.replaceAll(JSON.stringify(from), JSON.stringify(to));
  assert(!script.includes('"/root/') && !script.includes('"/etc/'));
  const proof = { wallet: owner, configuredOwner: owner, hardware, privacy: "local-only", version: "0.54.12-test.177.1",
    runtime: { activeAlias: "koinos-fast", loading: false, lastLoadError: null, runtime: { kind: "llamacpp", running: true } }, modelHash, benchmarkHash, benchmarkAt: at };
  const writes = [], renames = [], owners = [], output = [];
  const io = Object.create(fs);
  io.writeFileSync = (...args) => { writes.push(args[0]); return fs.writeFileSync(...args); };
  io.fchownSync = (fd, uid, gid) => { owners.push({ uid, gid }); return fs.fchownSync(fd, uid, gid); };
  io.renameSync = (from, to) => {
    assert(files.includes(to)); assert.equal(path.dirname(from), path.dirname(to));
    assert.equal(fs.statSync(from).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(from, "utf8")), [renewed, unrelated]);
    renames.push(to); return fs.renameSync(from, to);
  };
  const run = ({ now = at + 1000, uid = 0 } = {}) => vm.runInNewContext(script, {
    require: name => { if (name === "node:fs") return io; if (["node:crypto", "node:path"].includes(name)) return require(name); throw Error("Unexpected dependency"); },
    Buffer, Date: class extends Date { static now() { return now; } },
    process: { argv: ["node", "reviewed-renewal", Buffer.from(JSON.stringify(proof)).toString("base64")], getuid: () => uid, umask: () => 0o077 },
    console: { log: value => output.push(String(value)) },
  }, { timeout: 1000 });
  return { files, paths, save, config, proof, run, io, writes, renames, owners, output, snapshot: () => files.map(file => fs.readFileSync(file, "utf8")) };
}
test("reviewed renewal atomically preserves unrelated records, ownership, permissions and exact backups", t => {
  const f = fixture(t), before = f.snapshot(), stats = f.files.map(file => fs.statSync(file));
  f.run(); assert.deepEqual(f.renames, f.files);
  assert.deepEqual(f.owners, stats.map(stat => ({ uid: stat.uid, gid: stat.gid })));
  f.files.forEach((file, index) => {
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [renewed, unrelated]);
    const stat = fs.statSync(file); assert.equal(stat.uid, stats[index].uid); assert.equal(stat.gid, stats[index].gid); assert.equal(stat.mode & 0o777, 0o600);
    const names = fs.readdirSync(path.dirname(file)), backups = names.filter(name => name.startsWith("qualifications.json.before-renewal-"));
    assert.equal(backups.length, 1); const backup = path.join(path.dirname(file), backups[0]);
    assert.equal(fs.readFileSync(backup, "utf8"), before[index]); assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert(!names.some(name => name.includes(".new-")));
  });
  assert(f.output.some(line => line.includes('"qualificationUpdated": true')));
  const after = f.snapshot(), writes = f.writes.length; f.run();
  assert.deepEqual(f.snapshot(), after); assert.equal(f.writes.length, writes); assert.equal(f.renames.length, 2);
});
for (const updated of [0, 1]) test(`partial renewal retries when file ${updated + 1} already holds the exact reviewed record`, t => {
  const f = fixture(t); f.save(f.files[updated], [renewed, unrelated]); f.run();
  assert.deepEqual(f.renames, [f.files[1 - updated]]);
  f.files.forEach(file => assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [renewed, unrelated]));
});
test("a failed second rename leaves a complete old service file, cleans staging and can safely resume", t => {
  const f = fixture(t), before = f.snapshot(), rename = f.io.renameSync;
  f.io.renameSync = (from, to) => { if (to === f.files[1]) throw Error("Simulated filesystem interruption"); return rename(from, to); };
  assert.throws(() => f.run(), /Simulated filesystem interruption/);
  assert.deepEqual(JSON.parse(f.snapshot()[0]), [renewed, unrelated]); assert.equal(f.snapshot()[1], before[1]);
  assert(!fs.readdirSync(path.dirname(f.files[1])).some(name => name.includes(".new-")));
  f.io.renameSync = rename; f.run();
  assert.deepEqual(f.renames, f.files);
  f.files.forEach(file => assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [renewed, unrelated]));
});
for (const [name, mutate, options] of [
  ["expired benchmark", () => {}, { now: expires }],
  ["server clock before benchmark", () => {}, { now: at - 1 }],
  ["non-root user", () => {}, { uid: 1000 }],
  ["wrong active wallet", f => { f.proof.wallet = "buyer"; }],
  ["wrong configured wallet", f => { f.proof.configuredOwner = "buyer"; }],
  ["wrong hardware", f => { f.proof.hardware.cpu.cores++; }],
  ["changed benchmark digest", f => { f.proof.benchmarkHash = "0".repeat(64); }],
  ["changed benchmark time", f => { f.proof.benchmarkAt++; }],
  ["network-enabled benchmark", f => { f.proof.privacy = "local-first"; }],
  ["non-native runtime", f => { f.proof.runtime.runtime.kind = "ollama"; }],
  ["changed deployment", f => { f.config.deployment.credits = "unexpected"; f.save(f.paths["/etc/kai-koin-mainnet-pilot/runtime.json"], f.config); }],
  ["changed second-file reward weight", f => f.save(f.files[1], [{ ...old, modelWeight: "9999" }, unrelated])],
  ["changed second-file prior expiry", f => f.save(f.files[1], [{ ...old, expires: old.expires + 1 }, unrelated])],
  ["duplicate provider", f => f.save(f.files[1], [old, old, unrelated])],
  ["unprotected second file", f => fs.chmodSync(f.files[1], 0o644)],
  ["second file symlink", f => { const target = f.files[1] + ".target"; fs.renameSync(f.files[1], target); fs.symlinkSync(target, f.files[1]); }],
]) test(`renewal rejects ${name} before writing either qualification file`, t => {
  const f = fixture(t); mutate(f); const before = f.snapshot();
  assert.throws(() => f.run(options)); assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.renames, []);
});
