"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const { Signer } = require("koilib"), { KoinShadow } = require("../lib/koin-network/shadow"), { ShadowStore, SHADOW_STORE_SCHEMA, SHADOW_STORE_FILE } = require("../lib/koin-network/shadow-store"), P = require("../lib/koin-network/policy");
const address = Signer.fromSeed("shadow-store-recovery-fixture").address, identity = { deployment: "shadow-store-recovery", schedulerUrl: "https://scheduler.invalid", chainId: "1".repeat(64) };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function qualification(now, capacityId = "capacity-one") {
  return { address, capacityId, model: "approved", modelHash: "2".repeat(64), benchmarkHash: "3".repeat(64), modelWeight: "10000", coverageBps: 10000, expires: now + P.DAY };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-store-recovery-")), stores = [];
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const f = { root, directory: path.join(root, "store"), markerFile: path.join(root, "activation.json"), now: P.DAY, stores };
  f.legacy = new KoinShadow(path.join(root, "legacy"), { clock: () => f.now });
  f.legacy.open("100000000000"); f.legacy.qualify(qualification(f.now));
  for (const [sequence, offset] of [0, 25000, 50000, 75000].entries()) {
    f.now = P.DAY + offset;
    f.legacy.observe(address, { schema: 1, session: "4".repeat(32), sequence, at: f.now, model: "approved", modelHash: "2".repeat(64), ready: true });
  }
  f.now = P.DAY + 105001; f.legacy.tick();
  f.legacy.commitWork(1, [{ epoch: 1, jobId: "job-one", address, points: "300", charged: "500", verified: true, finalized: true, refunded: false }]);
  f.sourceFile = f.legacy.file; f.source = fs.readFileSync(f.sourceFile);
  f.evidence = f.legacy.getClosedEvidence(1); f.manifestFile = path.join(path.dirname(f.sourceFile), "manifest-1.json");
  f.now = 2 * P.DAY + 45001;
  f.manifestBytes = Buffer.from("\n  " + JSON.stringify({ manifest: f.legacy.manifest(1), signature: "fixture-only" }, null, 2) + "\n");
  fs.writeFileSync(f.manifestFile, f.manifestBytes);
  f.migrate = options => ShadowStore.migrateLegacy({ sourceFile: f.sourceFile, directory: f.directory, identity, clock: () => f.now, ...options });
  f.open = options => { const store = new ShadowStore(f.directory, { identity, clock: () => f.now, staging: true, ...options }); stores.push(store); return store; };
  f.activate = descriptor => fs.writeFileSync(f.markerFile, JSON.stringify(descriptor), { mode: 0o600 });
  return f;
}
test("offline migration preserves source and manifest bytes and requires matching verified activation", t => {
  const f = fixture(t), result = f.migrate();
  assert.equal(result.activated, false); assert.equal(result.sourceBytes, f.source.length);
  assert.equal(result.descriptor.schema, SHADOW_STORE_SCHEMA); assert.equal(result.descriptor.sourceHash, hash(f.source));
  assert.equal(result.descriptor.verificationHash, hash(JSON.stringify({ epochs: result.verification, records: result.recordVerification })));
  assert.deepEqual({ ...result.recordVerification, hash: undefined }, { qualifications: 1, presence: 1, samples: 4, observations: 0, hash: undefined });
  assert.match(result.recordVerification.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(f.sourceFile), f.source); assert.deepEqual(fs.readFileSync(f.manifestFile), f.manifestBytes);
  assert.deepEqual(fs.readFileSync(result.legacyBackup), f.source); assert.equal(fs.statSync(result.legacyBackup).mode & 0o777, 0o400);
  assert.equal(fs.existsSync(f.markerFile), false);
  assert.throws(() => f.open({ staging: false }), /activation marker/);
  f.activate(result.descriptor);
  const store = f.open({ staging: false, markerFile: f.markerFile });
  assert.deepEqual(store.getClosedEvidence(1), f.evidence);
  for (const workBasis of [undefined, "usd-pool"]) {
    assert.deepEqual(store.getManifestEvidence(1, { workBasis }), { evidenceHash: hash(JSON.stringify(f.evidence)), allocation: P.allocate({ ...f.evidence, workBasis }) });
  }
  assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(store.db.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(store.db.prepare("PRAGMA cache_size").get().cache_size, -8192);
  assert.equal(store.db.prepare("PRAGMA mmap_size").get().mmap_size, 0);
  store.close();
  const reordered = { chainId: identity.chainId, schedulerUrl: identity.schedulerUrl, deployment: identity.deployment };
  assert.deepEqual(f.open({ staging: false, markerFile: f.markerFile, identity: reordered }).descriptor(), result.descriptor);
});
test("activation rejects every mismatched descriptor field, changed deployment and unverified staging", t => {
  const f = fixture(t), { descriptor } = f.migrate();
  const variants = [
    { ...descriptor, schema: descriptor.schema + 1 }, { ...descriptor, mode: "other" },
    { ...descriptor, storeId: crypto.randomUUID() }, { ...descriptor, directory: path.join(f.root, "wrong") },
    { ...descriptor, identityHash: "5".repeat(64) }, { ...descriptor, sourceHash: "6".repeat(64) },
    { ...descriptor, verificationHash: "7".repeat(64) }, { ...descriptor, extra: true },
  ];
  for (const marker of variants) {
    f.activate(marker);
    assert.throws(() => f.open({ staging: false, markerFile: f.markerFile }), /activation/);
  }
  fs.writeFileSync(f.markerFile, "{"); assert.throws(() => f.open({ staging: false, markerFile: f.markerFile }), SyntaxError);
  f.activate(descriptor);
  assert.throws(() => f.open({ staging: false, markerFile: f.markerFile, identity: { ...identity, deployment: "changed" } }), /identity/);
  assert.throws(() => f.open({ identity: { ...identity, deployment: "changed" } }), /identity/);
  fs.rmSync(f.markerFile); fs.symlinkSync(f.sourceFile, f.markerFile);
  assert.throws(() => f.open({ staging: false, markerFile: f.markerFile }), /Regular shadow file/);
  assert.deepEqual(fs.readFileSync(f.sourceFile), f.source); assert.deepEqual(fs.readFileSync(f.manifestFile), f.manifestBytes);
  const emptyDirectory = path.join(f.root, "empty"), emptyMarker = path.join(f.root, "empty-marker.json");
  const empty = new ShadowStore(emptyDirectory, { identity, staging: true, create: true }); f.stores.push(empty);
  const unverified = empty.descriptor(); empty.close(); fs.writeFileSync(emptyMarker, JSON.stringify(unverified));
  assert.throws(() => new ShadowStore(emptyDirectory, { identity, markerFile: emptyMarker }), /activation/);
});
test("missing database or external anchor never initializes a replacement", t => {
  for (const missing of ["database", "anchor"]) {
    const f = fixture(t), { descriptor } = f.migrate(); f.activate(descriptor);
    const file = missing === "database" ? path.join(f.directory, SHADOW_STORE_FILE) : f.directory + ".recovery-anchor.sqlite";
    fs.rmSync(file);
    assert.throws(() => f.open({ staging: false, markerFile: f.markerFile }), /database or recovery anchor missing/);
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => f.open({ create: true }), /New empty staging/);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
  }
});
test("offline migration refuses oversized, linked and incompatible sources without changing them", t => {
  const f = fixture(t);
  assert.throws(() => f.migrate({ maxSourceBytes: f.source.length - 1 }), /size limit/);
  assert.equal(fs.existsSync(f.directory), false); assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
  const linked = path.join(f.root, "linked.json"); fs.symlinkSync(f.sourceFile, linked);
  assert.throws(() => f.migrate({ sourceFile: linked }), /Regular shadow file/); assert.equal(fs.existsSync(f.directory), false);
  const incompatible = JSON.parse(f.source); incompatible.qualificationHistory = {};
  const bytes = JSON.stringify(incompatible); fs.writeFileSync(f.sourceFile, bytes);
  assert.throws(() => f.migrate(), /separately reviewed migration/); assert.equal(fs.readFileSync(f.sourceFile, "utf8"), bytes);
  assert.equal(fs.existsSync(f.directory), false);
});
test("bounded source reads reject growth and path replacement without allocating from the changed size", t => {
  for (const change of ["grow", "replace"]) {
    const f = fixture(t), initial = fs.statSync(f.sourceFile), read = fs.readSync, displaced = path.join(f.root, "displaced.json");
    let changed = false, totalRead = 0, largestBuffer = 0;
    fs.readSync = function (fd, buffer, offset, length, position) {
      const stat = fs.fstatSync(fd);
      if (stat.dev === initial.dev && stat.ino === initial.ino) {
        largestBuffer = Math.max(largestBuffer, buffer.length);
        if (!changed) {
          changed = true;
          if (change === "grow") fs.appendFileSync(f.sourceFile, "\n".repeat(4096));
          else { fs.renameSync(f.sourceFile, displaced); fs.writeFileSync(f.sourceFile, f.source); }
        }
        const n = read.call(this, fd, buffer, offset, length, position); totalRead += n; return n;
      }
      return read.call(this, fd, buffer, offset, length, position);
    };
    try { assert.throws(() => f.migrate({ maxSourceBytes: f.source.length }), /source changed during bounded read/); }
    finally { fs.readSync = read; }
    assert.equal(changed, true); assert.equal(largestBuffer, f.source.length + 1); assert.ok(totalRead <= f.source.length + 1);
    assert.equal(fs.existsSync(f.directory), false);
    if (change === "grow") assert.deepEqual(fs.readFileSync(f.sourceFile), Buffer.concat([f.source, Buffer.from("\n".repeat(4096))]));
    else {
      assert.notEqual(fs.statSync(f.sourceFile).ino, initial.ino);
      assert.deepEqual(fs.readFileSync(f.sourceFile), f.source); assert.deepEqual(fs.readFileSync(displaced), f.source);
    }
  }
});
test("nonboolean sealed state is rejected without silently unsealing legacy evidence", t => {
  for (const sealed of [0, 1, "true", null]) {
    const f = fixture(t), damaged = JSON.parse(f.source); damaged.days[1].sealed = sealed;
    const bytes = JSON.stringify(damaged); fs.writeFileSync(f.sourceFile, bytes);
    assert.throws(() => f.migrate(), /invalid legacy shadow day/);
    assert.equal(fs.readFileSync(f.sourceFile, "utf8"), bytes);
    assert.equal(fs.readFileSync(path.join(f.directory, "legacy-koin-shadow.json"), "utf8"), bytes);
    const staged = f.open(); assert.equal(staged.getDayProgress(1).present, false); assert.equal(staged.descriptor().verificationHash, null);
    assert.deepEqual(staged.listQualifications(), []);
  }
});
test("invalid source evidence rolls back the import and leaves an inactive inspectable candidate", t => {
  const f = fixture(t), damaged = JSON.parse(f.source);
  damaged.presence[address].samples.reverse(); const bytes = JSON.stringify(damaged); fs.writeFileSync(f.sourceFile, bytes);
  assert.throws(() => f.migrate(), /strictly chronological/);
  assert.equal(fs.readFileSync(f.sourceFile, "utf8"), bytes);
  assert.equal(fs.readFileSync(path.join(f.directory, "legacy-koin-shadow.json"), "utf8"), bytes);
  const staged = f.open(); assert.equal(staged.getBudget(1), null); assert.deepEqual(staged.listQualifications(), []);
  assert.equal(staged.descriptor().sourceHash, null); assert.equal(staged.descriptor().verificationHash, null); staged.close();
  assert.throws(() => f.open({ staging: false, markerFile: f.markerFile }), /activation marker/);
  assert.throws(() => f.migrate(), /New empty staging/);
});
test("a source change during migration aborts verification without overwriting either source version", t => {
  const f = fixture(t), changed = Buffer.concat([f.source, Buffer.from("\n")]), append = ShadowStore.prototype._appendInterval;
  ShadowStore.prototype._appendInterval = function (...args) {
    const result = append.apply(this, args); fs.writeFileSync(f.sourceFile, changed); return result;
  };
  try { assert.throws(() => f.migrate(), /source identity changed|changed during offline migration/); }
  finally { ShadowStore.prototype._appendInterval = append; }
  assert.deepEqual(fs.readFileSync(f.sourceFile), changed);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "legacy-koin-shadow.json")), f.source);
  const staged = f.open(); assert.equal(staged.descriptor().verificationHash, null); assert.equal(staged.getBudget(1), null);
  assert.deepEqual(staged.listQualifications(), []);
});
test("a failed interval transaction restores interval, total and cursor together across restart", t => {
  const f = fixture(t); f.migrate();
  const store = f.open(), before = store.getClosedEvidence(1), progress = store.getDayProgress(1), availability = store.getAvailability(1, address);
  const append = store._appendInterval;
  store._appendInterval = function (...args) { append.apply(this, args); throw Error("injected-after-interval-write"); };
  assert.throws(() => store.tick({ maxIntervals: 1 }), /injected-after-interval-write/);
  assert.deepEqual(store.getClosedEvidence(1), before); assert.deepEqual(store.getDayProgress(1), progress); assert.deepEqual(store.getAvailability(1, address), availability);
  store._appendInterval = append; store.close();
  const reopened = f.open(); assert.deepEqual(reopened.getClosedEvidence(1), before); assert.deepEqual(reopened.getDayProgress(1), progress);
  reopened.tick({ maxIntervals: 1 }); assert.equal(reopened.getDayProgress(1).intervalCount, progress.intervalCount + 1);
});
test("restoring an older store database cannot roll back the external generation witness", t => {
  const f = fixture(t); f.migrate();
  const backup = path.join(f.root, "older-shadow.sqlite"), file = path.join(f.directory, SHADOW_STORE_FILE);
  fs.copyFileSync(file, backup);
  const store = f.open(); store.qualify(qualification(f.now, "capacity-two")); store.close();
  fs.copyFileSync(backup, file);
  assert.throws(() => f.open(), /generation.*mismatch|generation differs/);
  assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
});
test("a crash after store commit but before anchor commit fails closed on restart", t => {
  const f = fixture(t); f.migrate();
  const source = `
    const { DatabaseSync } = require('node:sqlite');
    const { ShadowStore } = require(${JSON.stringify(require.resolve("../lib/koin-network/shadow-store"))});
    const store = new ShadowStore(${JSON.stringify(f.directory)}, { identity: ${JSON.stringify(identity)}, staging: true, clock: () => ${f.now} });
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (sql === 'COMMIT' && this.prepare('PRAGMA database_list').all().some(row => row.name === 'main' && row.file === store.file)) process.exit(86);
      return result;
    };
    store.qualify(${JSON.stringify(qualification(f.now, "capacity-crash"))});
    process.exit(87);
  `;
  const child = spawnSync(process.execPath, ["--no-warnings", "-e", source], { encoding: "utf8", timeout: 15000, env: process.env });
  assert.equal(child.error, undefined); assert.equal(child.status, 86, child.stderr || child.stdout);
  assert.throws(() => f.open(), /generation.*mismatch|generation differs/);
  assert.deepEqual(fs.readFileSync(f.sourceFile), f.source); assert.deepEqual(fs.readFileSync(f.manifestFile), f.manifestBytes);
});
