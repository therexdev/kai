"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Signer } = require("koilib"), { KoinShadow } = require("../lib/koin-network/shadow"), { ShadowStore } = require("../lib/koin-network/shadow-store"), P = require("../lib/koin-network/policy");
const address = Signer.fromSeed("shadow-store-a").address, other = Signer.fromSeed("shadow-store-b").address, start = P.DAY, identity = { chain: "fixture", scheduler: "https://scheduler.invalid" };
const sample = (offset, changes = {}) => ({ session: "a".repeat(32), sequence: offset + 100000, model: "approved", modelHash: "1".repeat(64), ready: true, at: start + offset, signedAt: start + offset, ...changes });
function fixture(samples = [], q = {}) {
  return { schema: 1, mode: "shadow", qualifications: { slot: { address, capacityId: "slot", model: "approved", modelHash: "1".repeat(64), modelWeight: "10000", coverageBps: 10000,
    benchmarkHash: "2".repeat(64), approvedAt: start, expires: 2 * P.DAY, ...q } }, presence: samples.length ? { [address]: { ...samples.at(-1), samples } } : {},
    observations: { [address]: [{ at: start - 100, success: false }, { at: start - 200, success: true }] },
    budgets: { 1: { epoch: 1, version: 1, openedAt: start, total: "1000003", availability: "700002", work: "300001" } }, days: { 1: { intervals: [], work: [] } } };
}
function pair(t, state, initial = start + 105001) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-store-equivalence-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "koin-shadow.json"), directory = path.join(root, "store"), f = { now: initial, root, source, directory };
  fs.writeFileSync(source, JSON.stringify(state)); f.report = ShadowStore.migrateLegacy({ sourceFile: source, directory, identity, clock: () => f.now });
  f.legacy = new KoinShadow(root, { clock: () => f.now }); f.store = new ShadowStore(directory, { identity, clock: () => f.now, staging: true });
  t.after(() => f.store.close()); f.reopen = () => { f.store.close(); f.store = new ShadowStore(directory, { identity, clock: () => f.now, staging: true }); };
  return f;
}
function equalDay(f, epoch = 1) {
  const expected = f.legacy.getClosedEvidence(epoch), actual = f.store.getClosedEvidence(epoch);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  for (const workBasis of [undefined, "usd-pool"]) {
    assert.deepEqual(f.store.getManifestEvidence(epoch, { workBasis }), { evidenceHash: crypto.createHash("sha256").update(JSON.stringify(expected)).digest("hex"), allocation: P.allocate({ ...expected, workBasis }) });
  }
  for (const wallet of [address, other]) { assert.deepEqual(f.store.getAvailability(epoch, wallet), f.legacy.getAvailability(epoch, wallet)); assert.deepEqual(f.store.status(wallet), f.legacy.status(wallet)); }
}
test("SQLite tick preserves exact legacy eligibility at watermark, gap, session, model and qualification boundaries", t => {
  const cases = [
    { offsets: [0,30000,60000] }, { offsets: [1,30000,60000] }, { offsets: [0,25000,50000] }, { offsets: [0,45000,90000] },
    { offsets: [0,45000,90001] }, { offsets: [0,25000,50000,75000], changeAt: 2, change: { ready: false } },
    { offsets: [0,25000,50000,75000], changeAt: 2, change: { model: "other" } },
    { offsets: [0,25000,50000,75000], changeAt: 2, change: { session: "b".repeat(32) } },
    { offsets: [0,30000,60000], q: { approvedAt: start + 1 } }, { offsets: [0,30000,60000], q: { expires: start + 59999 } },
    { offsets: [0,30000,60000], q: { expires: start + 60000 } }, { offsets: [0,30000,60000], now: start + 105000 },
  ];
  for (const c of cases) { const f = pair(t, fixture(c.offsets.map((at, i) => sample(at, i === c.changeAt ? c.change : {})), c.q), c.now); f.legacy.tick(); f.store.tick(); equalDay(f); }
});
test("live observation, logical retention, interval catch-up and restart remain legacy equivalent", t => {
  const f = pair(t, fixture(), start);
  for (let i = 0; i < 40; i++) {
    f.now = start + i * 25000; const report = { schema: 1, session: "a".repeat(32), sequence: i + 1, at: f.now, model: "approved", modelHash: "1".repeat(64), ready: i !== 7 };
    f.legacy.observe(address, report); f.store.observe(address, report);
    if (i % 5 === 4) { f.legacy.tick(); f.store.tick(); equalDay(f); }
  }
  f.reopen(); equalDay(f);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM presence_samples").get().n, 40, "archived evidence remains present");
  assert.ok(f.legacy.state.presence[address].samples.length < 40, "the fixture exercises legacy pruning");
  assert.deepEqual(f.store.getPresence(address), f.legacy.getPresence(address));
  const stored = f.store.db.prepare("SELECT retained_from FROM presence_latest WHERE address=?").get(address).retained_from;
  assert.ok(stored > start); assert.equal(f.store.state, undefined, "no full-history JS state is exposed");
});
test("bounded catch-up includes expired current qualifications and preserves all interval and work rounding", t => {
  const samples = Array.from({ length: 292 }, (_, i) => sample(i * 25000)), state = fixture(samples, { expires: start + 120 * 60000 });
  state.qualifications.second = { ...state.qualifications.slot, address: other, capacityId: "second", modelWeight: "30001" };
  state.presence[other] = { ...samples.at(-1), samples: samples.map(p => ({ ...p })) };
  state.days[1].work = [
    { jobId: "paid", epoch: 1, address, points: "13", charged: "101", verified: true, finalized: true },
    { jobId: "sponsored", epoch: 1, address: other, points: "7", charged: "11", verified: true, finalized: true, free: true, sponsored: true },
    { jobId: "paid", epoch: 1, address, points: "999", charged: "999", verified: false, finalized: true },
  ];
  const f = pair(t, state, start + 120 * 60000 + 45001); f.legacy.tick();
  for (let i = 0; i < 4; i++) f.store.tick({ maxIntervals: 30 });
  assert.equal(f.store.getDayProgress(1).intervalCount, 120); equalDay(f);
  assert.deepEqual(f.store.listQualifications({ expiresAfter: f.now }), []);
  f.reopen(); equalDay(f);
  const allocate = P.allocate; let calls = 0; P.allocate = (...args) => { calls++; return allocate(...args); };
  try { for (let i = 0; i < 100; i++) { f.store.getAvailability(1, address); f.store.status(other); } assert.equal(calls, 0, "wallet polls use indexed availability and work totals"); }
  finally { P.allocate = allocate; }
});
test("work replacement indexes exact totals and sealed evidence rejects later mutation", t => {
  const f = pair(t, fixture([0,25000,50000,75000].map(at => sample(at)))); f.legacy.tick(); f.store.tick();
  const work = [{ jobId: "quoted-\"-\\-☃", epoch: 1, address, points: "1", charged: "100", verified: true, finalized: true }];
  assert.equal(f.store.commitWork(1, work), true); f.legacy.commitWork(1, work); equalDay(f);
  assert.equal(f.store.commitWork(1, work), false);
  assert.throws(() => f.store.markSealedMany([1,999]), /unavailable/); assert.equal(f.store.getDayProgress(1).sealed, false);
  assert.equal(f.store.markSealedMany([1,1]), 1); assert.equal(f.store.markSealedMany([1]), 0); assert.equal(f.store.markSealed(1), false);
  const before = f.store.getManifestEvidence(1);
  assert.throws(() => f.store.commitWork(1, []), /Sealed/);
  assert.throws(() => f.store._write(() => f.store._appendInterval(1, { start: start + 60000, end: start + 120000, slots: [] })), /Invalid shadow interval/);
  assert.throws(() => f.store.db.prepare("UPDATE intervals SET data='{}' WHERE epoch=1").run(), /Immutable/);
  assert.deepEqual(f.store.getManifestEvidence(1), before); f.reopen(); assert.deepEqual(f.store.getManifestEvidence(1), before);
});
test("hot metadata migration verifies every qualification, presence sample and observation without reordering", t => {
  const state = fixture([0,25000,50000,75000].map(at => sample(at))), f = pair(t, state);
  assert.deepEqual({ ...f.report.recordVerification, hash: undefined }, { qualifications: 1, presence: 1, samples: 4, observations: 2, hash: undefined });
  assert.match(f.report.recordVerification.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.store.listQualifications(), Object.values(state.qualifications));
  assert.deepEqual(f.store.getPresence(address), f.legacy.getPresence(address));
  assert.equal(f.store.db.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(f.store.db.prepare("PRAGMA mmap_size").get().mmap_size, 0);
  assert.equal(f.store.db.prepare("PRAGMA cache_size").get().cache_size, -8192);
  assert.ok(f.store.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM presence_samples WHERE address=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at").all(address, start, start + 75000).every(r => /SEARCH .*INDEX/.test(r.detail)));
});
