"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { VerifiedManifestCache } = require("../lib/koin-network/verified-manifest-cache");
const P = require("../lib/koin-network/job-protocol"), M = require("../lib/koin-network/reward-manifest");
const { fixture } = require("./helpers/koin-cycle-fixture"), { DAY } = require("../lib/koin-network/policy");

function isolated(options = {}) {
  let calls = 0;
  const identity = "isolated-runtime-identity";
  const verify = input => {
    calls++;
    if (input.invalid) throw Error("Invalid signed input");
    return { hash: P.hash(input.epoch + ":" + input.value),
      envelope: { manifest: { epoch: input.epoch, allocations: [{ address: "fixture", availability: input.value, work: "0" }] } },
      claims: [{ address: "fixture", proof: [{ hash: P.hash("fixture-proof"), left: false }] }] };
  };
  const record = (epoch, value = "10") => ({ identity, epoch, hash: P.hash(epoch + ":" + value), data: JSON.stringify({ epoch, value }) });
  return { cache: new VerifiedManifestCache({ identity, verify, ...options }), record, get calls() { return calls; } };
}

test("unchanged exact saved bytes reuse an immutable verification result", () => {
  const f = isolated(), record = f.record("1"), first = f.cache.read(record);
  for (let i = 0; i < 20; i++) assert.strictEqual(f.cache.read({ ...record }), first);
  assert.equal(f.calls, 1);
  assert.throws(() => { first.envelope.manifest.allocations[0].availability = "999"; }, TypeError);
  assert.throws(() => { first.claims[0].proof.push({}); }, TypeError);
  assert.equal(f.cache.read(record).envelope.manifest.allocations[0].availability, "10");
});

test("data, digest, epoch and runtime identity are checked even after a cache hit", () => {
  const f = isolated(), record = f.record("1"); f.cache.read(record);
  assert.throws(() => f.cache.read({ ...record, data: JSON.stringify({ epoch: "1", value: "99" }) }), /Damaged reward manifest/);
  assert.throws(() => f.cache.read({ ...record, hash: "f".repeat(64) }), /Damaged reward manifest/);
  assert.throws(() => f.cache.read({ ...record, epoch: "2" }), /Damaged reward manifest/);
  assert.throws(() => f.cache.read({ ...record, identity: "different-runtime" }), /Damaged reward manifest/);
  assert.throws(() => f.cache.read({ ...record, data: "{" }), SyntaxError);
  const invalid = { ...record, data: JSON.stringify({ epoch: "1", value: "10", invalid: true }) }, before = f.calls;
  assert.throws(() => f.cache.read(invalid), /Invalid signed input/);
  assert.throws(() => f.cache.read(invalid), /Invalid signed input/);
  assert.equal(f.calls, before + 2, "Rejected data never becomes trusted cached data");
  assert.equal(f.cache.read(record).envelope.manifest.allocations[0].availability, "10");
});

test("LRU entry eviction and byte eviction bound retained verification results", () => {
  const f = isolated({ maxEntries: 2 }), one = f.record("1"), two = f.record("2"), three = f.record("3");
  f.cache.read(one); f.cache.read(two); f.cache.read(one); assert.equal(f.calls, 2);
  f.cache.read(three); f.cache.read(one); assert.equal(f.calls, 3);
  f.cache.read(two); assert.equal(f.calls, 4, "The least recently used entry was evicted");
  const measure = isolated(), input = measure.record("1"), value = measure.cache.read(input);
  const bytes = Buffer.byteLength(input.data) + Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(input.epoch) + Buffer.byteLength(input.hash);
  const byteBound = isolated({ maxBytes: bytes });
  byteBound.cache.read(one); byteBound.cache.read(one); assert.equal(byteBound.calls, 1);
  byteBound.cache.read(two); byteBound.cache.read(one); assert.equal(byteBound.calls, 3);
  const oversized = isolated({ maxBytes: bytes - 1 });
  oversized.cache.read(one); oversized.cache.read(one); assert.equal(oversized.calls, 2, "Oversized verified output is never retained");
});

test("the default entry bound covers a complete 64-claim account history", () => {
  const f = isolated(), records = Array.from({ length: 64 }, (_, i) => f.record(String(i)));
  for (const record of records) f.cache.read(record);
  for (const record of records) f.cache.read(record);
  assert.equal(f.calls, 64, "A repeated bounded account history does not evict itself");
});

function countVerifications(t) {
  const original = M.verify; let calls = 0;
  M.verify = (...args) => { calls++; return original(...args); };
  t.after(() => { M.verify = original; });
  return () => calls;
}
function openDatabase(t, file) {
  const db = new DatabaseSync(file); t.after(() => db.close()); return db;
}

test("claim status shares manifest verification while still rejecting changed manifests, claims and identity", async t => {
  const f = await fixture(t), count = countVerifications(t), claims = f.claims();
  const ids = claims.importManifest(f.envelope), before = count();
  const first = claims.status(ids[0]);
  assert.equal(count(), before + 1);
  for (let i = 0; i < 5; i++) for (const allocation of f.envelope.manifest.allocations) claims.accountStatus(allocation.address);
  assert.equal(count(), before + 1, "Every account and repeated status read shares the same verified manifest");
  const db = openDatabase(t, path.join(f.dir, "claims", "reward-claims.sqlite"));
  const row = db.prepare("SELECT hash,data FROM manifests WHERE epoch='1'").get();
  const changed = JSON.parse(row.data); changed.manifest.allocations[0].availability = "999";
  db.prepare("UPDATE manifests SET data=? WHERE epoch='1'").run(JSON.stringify(changed));
  assert.throws(() => claims.status(ids[0]), /root or sums mismatch/);
  db.prepare("UPDATE manifests SET data=?,hash=? WHERE epoch='1'").run(row.data, "f".repeat(64));
  assert.throws(() => claims.status(ids[0]), /Damaged reward manifest/);
  db.prepare("UPDATE manifests SET data=?,hash=? WHERE epoch='1'").run(row.data, row.hash);
  const claim = db.prepare("SELECT data FROM claims WHERE id=?").get(ids[0]).data, changedClaim = JSON.parse(claim);
  changedClaim.claim.availability = "999";
  db.prepare("UPDATE claims SET data=? WHERE id=?").run(JSON.stringify(changedClaim), ids[0]);
  assert.throws(() => claims.status(ids[0]), /Damaged reward claim binding/);
  db.prepare("UPDATE claims SET data=? WHERE id=?").run(claim, ids[0]);
  const identity = db.prepare("SELECT data FROM identity WHERE id=1").get().data;
  db.prepare("UPDATE identity SET data='changed' WHERE id=1").run();
  assert.throws(() => claims.status(ids[0]), /Damaged reward manifest/);
  db.prepare("UPDATE identity SET data=? WHERE id=1").run(identity);
  assert.deepEqual(claims.status(ids[0]), first);
});

test("cycle allocation cache rejects exact-byte tampering and re-verifies after reopening", async t => {
  const f = await fixture(t), count = countVerifications(t); f.cycle.importManifest(f.envelope);
  const account = f.envelope.manifest.allocations[0].address, before = count(), first = f.cycle.accountAllocation("1", account);
  assert.equal(count(), before + 1);
  assert.deepEqual(f.cycle.accountAllocation("1", account), first); assert.equal(count(), before + 1);
  const db = openDatabase(t, path.join(f.dir, "reward-cycle.sqlite")), row = db.prepare("SELECT manifest,hash FROM days WHERE epoch='1'").get();
  const changed = JSON.parse(row.manifest); changed.signature = "invalid";
  db.prepare("UPDATE days SET manifest=? WHERE epoch='1'").run(JSON.stringify(changed));
  assert.throws(() => f.cycle.accountAllocation("1", account));
  db.prepare("UPDATE days SET manifest=?,hash=? WHERE epoch='1'").run(row.manifest, "f".repeat(64));
  assert.throws(() => f.cycle.accountAllocation("1", account), /Damaged cycle manifest/);
  db.prepare("UPDATE days SET manifest=?,hash=? WHERE epoch='1'").run(row.manifest, row.hash);
  const identity = db.prepare("SELECT data FROM identity WHERE id=1").get().data;
  db.prepare("UPDATE identity SET data='changed' WHERE id=1").run();
  assert.throws(() => f.cycle.accountAllocation("1", account), /Damaged cycle manifest/);
  db.prepare("UPDATE identity SET data=? WHERE id=1").run(identity);
  const beforeRestart = count(); f.reopen();
  assert.deepEqual(f.cycle.accountAllocation("1", account), first); assert.equal(count(), beforeRestart + 1);
  assert.deepEqual(f.cycle.accountAllocation("1", account), first); assert.equal(count(), beforeRestart + 1);
});

test("a finalized public manifest is a fresh copy and cannot mutate trusted cached content", async t => {
  const f = await fixture(t); f.cycle.importManifest(f.envelope);
  for (let step = 0; step < 3; step++) {
    const result = (await f.runner().tick({ openCurrentDay: false })).results[0];
    assert.equal(result.action, "await_finality"); await f.include(f.sent.at(-1));
    let decision;
    for (let i = 0; i < 3; i++) { decision = await f.cycle.advance("1"); if (decision.reason !== "cycle_changed") break; }
    assert.equal(decision.action, "step_complete"); if (step < 2) f.advance(DAY);
  }
  const first = f.cycle.readyManifest("1"), expected = structuredClone(first);
  first.manifest.allocations[0].availability = "999"; first.manifest.root.hash = "0".repeat(64);
  assert.deepEqual(f.cycle.readyManifest("1"), expected);
  assert.notStrictEqual(f.cycle.readyManifest("1"), first);
});
