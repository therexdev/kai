"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { KoinShadow } = require("../lib/koin-network/shadow"), P = require("../lib/koin-network/policy");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-summary-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new KoinShadow(dir, { clock: () => 3 * P.DAY });
  const budget = P.dailyBudget({ balance: "100003", liabilities: "0", openedAt: P.DAY + 1000 });
  ledger.importBudget(1, budget); return { dir, ledger, budget };
}
function interval(i, epoch = 1) {
  return { start: epoch * P.DAY + (i + 1) * 60000, end: epoch * P.DAY + (i + 2) * 60000,
    slots: Array.from({ length: 1 + i % 5 }, (_, j) => ({ address: "provider-" + j % 3, capacityId: "capacity-" + j,
      verified: true, eligible: true, modelWeight: String(10000 + j * 3333), coverageBps: 7500 + j * 1000, reliabilityBps: 9000 + i % 1001 })) };
}
test("indexed availability preserves full-policy rounding for every provider after each appended interval and restart", t => {
  const { dir, ledger, budget } = fixture(t), day = ledger.state.days[1];
  for (let i = 0; i < 50; i++) {
    day.intervals.push(interval(i));
    const expected = new Map(P.allocate({ budget, intervals: day.intervals, work: [] }).allocations.map(row => [row.address, row.availability]));
    for (const address of ["provider-0", "provider-1", "provider-2", "absent"])
      assert.deepEqual(ledger.getAvailability(1, address), { availability: expected.get(address) || "0", asOf: day.intervals.at(-1).end });
  }
  ledger.save();
  const reopened = new KoinShadow(dir, { clock: () => 3 * P.DAY });
  assert.deepEqual(reopened.getAvailability(1, "provider-1"), ledger.getAvailability(1, "provider-1"));
  assert.deepEqual(ledger.getAvailability(99, "provider-1"), { availability: null, asOf: null });
});
test("many wallet polls reuse exact totals and only a newly closed interval invokes the allocator", t => {
  const { ledger } = fixture(t), day = ledger.state.days[1], allocate = P.allocate; let calls = 0;
  day.intervals = Array.from({ length: 20 }, (_, i) => interval(i));
  P.allocate = options => { calls++; return allocate(options); };
  try {
    ledger.getAvailability(1, "provider-0"); assert.equal(calls, 20);
    for (let i = 0; i < 1000; i++) ledger.getAvailability(1, "provider-" + i % 3);
    assert.equal(calls, 20, "wallet reads must not repeat historical allocation");
    day.intervals.push(interval(20)); ledger.getAvailability(1, "provider-0"); assert.equal(calls, 21);
    ledger.clock = () => P.DAY + 25 * 60000;
    ledger.status("provider-0"); const statusCalls = calls;
    for (let i = 0; i < 100; i++) ledger.status("provider-" + i % 3);
    assert.equal(calls, statusCalls, "legacy shadow status uses the same cached projection");
  } finally { P.allocate = allocate; }
});
test("cache rebuilds for replacement evidence, keeps only two days, and refuses overlapping intervals", t => {
  const { ledger, budget } = fixture(t), day = ledger.state.days[1];
  day.intervals.push(interval(0)); ledger.getAvailability(1, "provider-0");
  day.intervals = [interval(1)];
  assert.equal(ledger.getAvailability(1, "provider-0").availability, P.allocate({ budget, intervals: day.intervals, work: [] }).allocations[0].availability);
  day.intervals.push(interval(1)); assert.throws(() => ledger.getAvailability(1, "provider-0"), /Overlapping/);
  day.intervals.pop(); assert.doesNotThrow(() => ledger.getAvailability(1, "provider-0"));
  for (let epoch = 2; epoch <= 5; epoch++) {
    ledger.importBudget(epoch, P.dailyBudget({ balance: "1000", liabilities: "0", openedAt: epoch * P.DAY }));
    ledger.getAvailability(epoch, "absent");
  }
  assert.equal(ledger.availabilityCaches.size, 2);
});
test("compatibility methods preserve exact evidence order, detach reads and avoid rewriting idempotent mutations", t => {
  const { ledger, budget } = fixture(t); let saves = 0; const save = ledger.save.bind(ledger); ledger.save = () => { saves++; save(); };
  assert.equal(ledger.importBudget(1, budget), false); assert.equal(saves, 0);
  assert.throws(() => ledger.importBudget(1, { ...budget, availability: "1" }), /Invalid|differs/);
  const b = ledger.getBudget(1); b.openedAt = 0; assert.equal(ledger.getBudget(1).openedAt, budget.openedAt);
  ledger.state.days[1].intervals.push(interval(0));
  const work = [{ epoch: 1, jobId: "job-1", address: "provider-2", points: "3", charged: "3", verified: true, finalized: true, free: false, refunded: false }];
  assert.equal(ledger.commitWork(1, work), true); assert.equal(ledger.commitWork(1, work), false); assert.equal(saves, 1);
  const expected = { budget, intervals: ledger.state.days[1].intervals, work };
  assert.equal(JSON.stringify(ledger.getClosedEvidence(1)), JSON.stringify(expected));
  const copy = ledger.getClosedEvidence(1); copy.intervals[0].slots[0].modelWeight = "999";
  assert.equal(JSON.stringify(ledger.getClosedEvidence(1)), JSON.stringify(expected));
  for (const address of ["provider-0", "provider-2", "absent"]) {
    const row = P.allocate(expected).allocations.find(r => r.address === address), actual = ledger.status(address).estimate;
    // The fixture clock is day3; inspect its day1 cache projection directly.
    assert.deepEqual(ledger._accountAllocation(1, address), row ? { availability: row.availability, work: row.work } : null);
    assert.equal(actual, null);
  }
  assert.equal(ledger.markSealed(1), true); assert.equal(ledger.markSealed(1), false); assert.equal(saves, 2);
  assert.throws(() => ledger.commitWork(1, []), /Sealed/);
  assert.deepEqual(ledger.getDayProgress(1), { present: true, sealed: true, intervalCount: 1, nextStart: interval(0).end, lastIntervalEnd: interval(0).end });
  assert.deepEqual(ledger.getUnsealedEpochs(), []);
});
