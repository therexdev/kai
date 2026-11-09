"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer } = require("koilib"), { KoinShadow } = require("../lib/koin-network/shadow"), P = require("../lib/koin-network/policy");
const start = P.DAY, address = Signer.fromSeed("indexed-shadow-a").address, other = Signer.fromSeed("indexed-shadow-b").address;
const sample = (offset, changes = {}) => ({ session: "a".repeat(32), sequence: offset, model: "approved", modelHash: "1".repeat(64), ready: true,
  at: start + offset, signedAt: start + offset, ...changes });
function state(samples, qualification = {}) {
  return { schema: 1, mode: "shadow", qualifications: { slot: { address, capacityId: "slot", model: "approved", modelHash: "1".repeat(64),
    modelWeight: "10000", coverageBps: 10000, benchmarkHash: "2".repeat(64), approvedAt: start, expires: 2 * P.DAY, ...qualification } },
    presence: { [address]: { ...samples.at(-1), samples } }, observations: { [address]: [{ at: start - 1000, success: true }] },
    budgets: { 1: { epoch: 1, version: 1, openedAt: start, total: "1000000", availability: "700000", work: "300000" } },
    days: { 1: { intervals: [], work: [] } } };
}
function ledger(value, now = start + 105001) {
  return Object.assign(Object.create(KoinShadow.prototype), { state: structuredClone(value), clock: () => now, writes: 0, save() { this.writes++; } });
}
// Frozen pre-index algorithm: this oracle verifies complete serialized accounting
// output rather than restating the binary-search implementation's assertions.
function referenceTick() {
  const now = this.clock(), watermark = Math.floor((now - 45001) / 60000) * 60000;
  let remaining = 120, changed = false;
  for (const epoch of Object.keys(this.state.budgets).sort((a, b) => Number(a) - Number(b))) {
    const budget = this.state.budgets[epoch], day = this.state.days[epoch];
    if (!day || day.sealed) continue;
    let from = day.intervals.at(-1)?.end ?? Math.ceil(budget.openedAt / 60000) * 60000;
    const limit = Math.min(watermark, (Number(epoch) + 1) * P.DAY);
    for (; from + 60000 <= limit && remaining > 0; from += 60000, remaining--) {
      const end = from + 60000, slots = [];
      for (const q of Object.values(this.state.qualifications)) {
        const samples = (this.state.presence[q.address]?.samples || []).filter(p => p.at <= end + 45000);
        const first = samples.findLastIndex(p => p.at <= from), last = samples.findIndex(p => p.at >= end);
        if (q.approvedAt > from || q.expires < end || first < 0 || last < first) continue;
        const window = samples.slice(first, last + 1);
        if (window.some((p, i) => !p.ready || p.model !== q.model || p.modelHash !== q.modelHash ||
          (i > 0 && (p.at - window[i - 1].at > 45000 || p.session !== window[i - 1].session)))) continue;
        slots.push({ ...q, verified: true, eligible: true, reliabilityBps: P.reliability((this.state.observations[q.address] || []).filter(o => o.at <= end), end) });
      }
      slots.sort((a, b) => a.address.localeCompare(b.address) || a.capacityId.localeCompare(b.capacityId));
      day.intervals.push({ start: from, end, slots }); changed = true;
    }
    if (!remaining) break;
  }
  if (changed) this.save();
}
function compare(value, now) {
  const expected = ledger(value, now), actual = ledger(value, now);
  referenceTick.call(expected); actual.tick();
  assert.equal(JSON.stringify(actual.state), JSON.stringify(expected.state), "every persisted field and its order must match");
  assert.equal(actual.writes, expected.writes);
  return actual;
}
test("indexed coverage retains exact minute, gap, readiness, model, session and qualification boundaries", () => {
  const cases = [
    { offsets: [0, 30000, 60000], eligible: true },
    { offsets: [-1, 30000, 60000], eligible: true },
    { offsets: [1, 30000, 60000], eligible: false },
    { offsets: [0, 25000, 50000], eligible: false },
    { offsets: [0, 45000, 90000], eligible: true },
    { offsets: [0, 45000, 90001], eligible: false },
    { offsets: [0, 30000, 59999, 105000], eligible: false },
    { offsets: [0, 30000, 59999, 105001], eligible: false },
    { offsets: [0, 25000, 50000, 75000, 100000], at: 3, changes: { ready: false }, eligible: false },
    { offsets: [0, 25000, 50000, 75000, 100000], at: 4, changes: { ready: false }, eligible: true },
    { offsets: [0, 25000, 50000, 75000], at: 2, changes: { model: "different" }, eligible: false },
    { offsets: [0, 25000, 50000, 75000], at: 2, changes: { modelHash: "2".repeat(64) }, eligible: false },
    { offsets: [0, 25000, 50000, 75000], at: 2, changes: { session: "b".repeat(32) }, eligible: false },
    { offsets: [0, 30000, 60000], qualification: { approvedAt: start + 1 }, eligible: false },
    { offsets: [0, 30000, 60000], qualification: { expires: start + 59999 }, eligible: false },
    { offsets: [0, 30000, 60000], qualification: { expires: start + 60000 }, eligible: true },
  ];
  for (const c of cases) {
    const actual = compare(state(c.offsets.map((at, i) => sample(at, i === c.at ? c.changes : {})), c.qualification));
    assert.equal(actual.state.days[1].intervals[0].slots.length, c.eligible ? 1 : 0, JSON.stringify(c));
  }
  assert.equal(compare(state([0, 30000, 60000].map(at => sample(at))), start + 105000).state.days[1].intervals.length, 0);
});
test("deterministic mixed histories and 120-minute catch-up preserve serialized accounting and allocation", () => {
  let seed = 321;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let scenario = 0; scenario < 80; scenario++) {
    const samples = []; let at = -60000;
    for (let i = 0; i < 180; i++, at += 10000 + random(50000)) samples.push(sample(at, {
      ready: random(10) !== 0, model: random(20) ? "approved" : "different", session: random(30) ? "a".repeat(32) : "b".repeat(32),
    }));
    const value = state(samples), q = value.qualifications.slot;
    value.qualifications.second = { ...q, address: other, capacityId: "second" };
    value.presence[other] = { ...samples.at(-1), samples: samples.map(p => ({ ...p, ready: true, model: "approved", session: "a".repeat(32) })) };
    const actual = compare(value, start + 60 * 60000 + 45001);
    assert.equal(actual.state.days[1].intervals.length, 60);
  }
  const samples = Array.from({ length: 3457 }, (_, i) => sample(7225000 - (3456 - i) * 25000));
  const value = state(samples), actual = compare(value, start + 120 * 60000 + 45001), expected = ledger(value, start + 120 * 60000 + 45001);
  referenceTick.call(expected);
  assert.equal(actual.state.days[1].intervals.length, 120);
  assert.ok(actual.state.days[1].intervals.every(row => row.slots.length === 1));
  assert.deepEqual(P.allocate({ budget: actual.state.budgets[1], ...actual.state.days[1] }), P.allocate({ budget: expected.state.budgets[1], ...expected.state.days[1] }));
});
test("loaded nonchronological or malformed samples fail closed without sorting or modifying original files", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-index-order-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "koin-shadow.json");
  for (const samples of [[sample(0), sample(-1)], [sample(0), sample(0)], [sample(0, { at: -1 })], [sample(0, { at: 1.5 })], [sample(0, { at: "1" })], [null], { 0: sample(0) }]) {
    const value = state([]); value.presence[address].samples = samples;
    const original = JSON.stringify(value); fs.writeFileSync(file, original);
    assert.throws(() => new KoinShadow(directory), /sample history|strictly chronological/);
    assert.equal(fs.readFileSync(file, "utf8"), original); assert.deepEqual(fs.readdirSync(directory), ["koin-shadow.json"]);
  }
  const valid = state([-25000, 0, 25000, 50000, 75000].map(at => sample(at))), original = JSON.stringify(valid);
  fs.writeFileSync(file, original); const reopened = new KoinShadow(directory, { clock: () => start + 105001 });
  const expected = compare(valid); reopened.tick(); assert.equal(JSON.stringify(reopened.state), JSON.stringify(expected.state));
});
test("validated long histories use bounded lookup work rather than filtering or copying all samples per interval", () => {
  const samples = Array.from({ length: 20000 }, (_, i) => sample(100000 - (19999 - i) * 25000));
  // Keep synthetic timestamps nonnegative while retaining a long ordered tail.
  for (const p of samples) { p.at += 10 * P.DAY; p.signedAt += 10 * P.DAY; }
  const value = state(samples); value.budgets[1].openedAt += 10 * P.DAY; value.budgets[1].epoch = 11;
  value.budgets[11] = value.budgets[1]; delete value.budgets[1]; value.days[11] = value.days[1]; delete value.days[1];
  value.qualifications.slot.approvedAt += 10 * P.DAY; value.qualifications.slot.expires += 10 * P.DAY;
  const actual = ledger(value, 11 * P.DAY + 105001); let reads = 0;
  actual.state.presence[address].samples = new Proxy(actual.state.presence[address].samples, { get(target, key, receiver) {
    if (key === "filter" || key === "slice") throw Error("Full sample copy is not allowed in tick");
    if (/^\d+$/.test(String(key))) reads++;
    return Reflect.get(target, key, receiver);
  } });
  actual.tick(); assert.ok(reads >= samples.length, "a new history is validated once");
  actual.state.days[11].intervals = []; reads = 0; actual.tick();
  assert.ok(reads < 100, "later lookups must inspect only binary bounds and the minute window");
  assert.equal(actual.state.days[11].intervals[0].slots.length, 1);
});
test("idle ticks skip qualification snapshots and catch-up takes one stable snapshot", () => {
  const value = state(Array.from({ length: 300 }, (_, i) => sample(i * 25000)));
  const idle = ledger(value, start + 105000);
  idle.state.qualifications = new Proxy(idle.state.qualifications, { ownKeys() { throw Error("Idle tick scanned qualifications"); } });
  idle.tick(); assert.equal(idle.writes, 0);
  const active = ledger(value, start + 120 * 60000 + 45001); let snapshots = 0;
  active.state.qualifications = new Proxy(active.state.qualifications, { ownKeys(target) { snapshots++; return Reflect.ownKeys(target); } });
  active.tick(); assert.equal(snapshots, 1); assert.equal(active.state.days[1].intervals.length, 120); assert.equal(active.writes, 1);
});
