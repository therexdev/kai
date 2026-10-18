"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { KoinShadow } = require("../lib/koin-network/shadow"), { DAY } = require("../lib/koin-network/policy"), { Signer } = require("koilib");
const addresses = ["A", "B"].map(s => Signer.fromSeed("fair-presence-" + s).getAddress());
function scenario(t, { reverse = false, timer = false, restart = false, dayEnd = false, outage = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-presence-order-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const start = dayEnd ? 2 * DAY - 60000 : DAY; let now = start, ledger = new KoinShadow(dir, { clock: () => now }); ledger.open("100000000000");
  addresses.forEach((address, i) => ledger.qualify({ address, capacityId: "slot" + i, model: "fixture", modelHash: "1".repeat(64), modelWeight: "10000", coverageBps: 10000, benchmarkHash: "2".repeat(64), expires: start + DAY }));
  const report = (address, seq) => ledger.observe(address, { schema: 1, session: "a".repeat(32), sequence: seq, at: now, model: "fixture", modelHash: "1".repeat(64), ready: true });
  for (const [seq, at] of [0, 25000, 50000].entries()) { now = start + at; addresses.forEach(a => report(a, seq)); }
  if (outage) {
    now = start + 75000; addresses.forEach(a => report(a, 3));
    now = start + 300000; ledger = new KoinShadow(dir, { clock: () => now });
    const order = reverse ? [...addresses].reverse() : addresses;
    report(order[0], 4); ledger.tick(); now++; report(order[1], 4); ledger.tick();
    const intervals = ledger.state.days[Math.floor(start / DAY)].intervals;
    assert.ok(intervals.slice(1).every(i => i.slots.length === 0), "outage earns no invented coverage");
    return intervals[0].slots.map(s => s.address).sort();
  }
  if (timer) { now = start + 60000; ledger.tick(); }
  const order = reverse ? [...addresses].reverse() : addresses;
  now = start + 61000; report(order[0], 3); ledger.tick();
  if (restart) ledger = new KoinShadow(dir, { clock: () => now });
  now = start + 62000; report(order[1], 3); ledger.tick();
  now = start + 105001; ledger.tick();
  const intervals = ledger.state.days[Math.floor(start / DAY)].intervals;
  assert.equal(intervals.length, 1); assert.equal(intervals[0].start, start);
  return intervals[0].slots.map(s => s.address).sort();
}
test("equivalent heartbeat coverage is independent of arrival order, early timer, day end and restart", t => {
  for (const options of [{}, { reverse: true }, { timer: true }, { restart: true }, { reverse: true, timer: true, restart: true, dayEnd: true }])
    assert.deepEqual(scenario(t, options), [...addresses].sort());
});

test("catch-up is bounded and sealed availability history is immutable across restart", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-presence-catchup-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = DAY, ledger = new KoinShadow(dir, { clock: () => now }); ledger.open("100000000000");
  now += 12 * 3600000; ledger.tick(); assert.equal(ledger.state.days[1].intervals.length, 120);
  ledger.state.days[1].sealed = true; ledger.save(); const old = JSON.stringify(ledger.state.days[1]);
  now += DAY; ledger = new KoinShadow(dir, { clock: () => now }); ledger.tick(); assert.equal(JSON.stringify(ledger.state.days[1]), old);
});

test("long-outage restart preserves historical coverage whichever provider returns first", t => {
  for (const options of [{ outage: true }, { outage: true, reverse: true }, { outage: true, reverse: true, dayEnd: true }])
    assert.deepEqual(scenario(t, options), [...addresses].sort());
});
