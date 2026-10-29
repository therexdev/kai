"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { rewardSummary } = require("../lib/koin-network/reward-summary"), { DAY } = require("../lib/koin-network/policy");
function fixture() {
  const state = { budgets: { "2": { epoch: 2, version: 1, openedAt: 2 * DAY, total: "100000000", availability: "70000000", work: "30000000" } },
    days: { "2": { intervals: [{ start: 2 * DAY, end: 2 * DAY + DAY / 2, slots: [
      { address: "alice", capacityId: "a", eligible: true, verified: true, modelWeight: "10000", coverageBps: 10000, reliabilityBps: 10000 },
      { address: "bob", capacityId: "b", eligible: true, verified: true, modelWeight: "10000", coverageBps: 10000, reliabilityBps: 10000 },
      { address: "unqualified", capacityId: "c", eligible: false, verified: true }
    ] }], work: [] } } };
  let payouts = [], now = 2 * DAY + DAY / 2 + 50000;
  const r = { clock: () => now, scheduler: { koinShadow: { ledger: { state } } }, rewardTarget: { rewardBasis: "usd-pool" },
    claims: { accountStatus: () => payouts },
    cycle: { days: () => ["1", "2"], readyDays: () => [], accountAllocation: (e, account) => account === "alice" ? { availability: "10000000", work: "2000000", rootHash: "hash" } : null,
      status: () => ({ complete: false, steps: [{ method: "propose_root", state: "complete" }] }) },
    rewardEpochObservations: new Map([["1", { observedAt: now, reviewUntil: 3 * DAY + 5000, rootHash: "hash" }]]) };
  return { r, state, set payouts(p) { payouts = p; }, set now(n) { now = n; } };
}
test("current earnings use funded elapsed verified intervals; status reads neither mutate nor pay", () => {
  const { r, state } = fixture(), before = JSON.stringify(state);
  const result = rewardSummary(r, "alice");
  assert.equal(result.current.availability, "17500000");
  assert.equal(result.current.asOf, 2.5 * DAY); assert.equal(result.current.closesAt, 3 * DAY);
  assert.equal(rewardSummary(r, "bob").current.availability, "17500000");
  assert.equal(rewardSummary(r, "unqualified").current.availability, "0");
  assert.deepEqual(result.pending, [{ epoch: "1", availability: "10000000", work: "2000000", state: "reviewing", reviewUntil: 3 * DAY + 5000 }]);
  assert.equal(JSON.stringify(state), before);
});
test("missing current budget is unknown, not a zero reward; signed pending allocations remain visible", () => {
  const { r, state } = fixture(); delete state.budgets["2"];
  const value = rewardSummary(r, "alice"); assert.equal(value.current.availability, null); assert.equal(value.current.asOf, null); assert.equal(value.pending.length, 1);
});
test("claim handoff cannot double count paid or sending allocations", () => {
  const f = fixture();
  for (const state of ["queued", "pending", "paid", "paid_elsewhere", "needs_review"]) {
    f.payouts = [{ epoch: "1", state }]; assert.deepEqual(rewardSummary(f.r, "alice").pending, []);
  }
});
test("stale or changed chain root never supplies a promised review deadline", () => {
  const f = fixture(); f.now = 2.5 * DAY + 120000;
  assert.equal(rewardSummary(f.r, "alice").pending[0].reviewUntil, null);
  f.r.rewardEpochObservations.set("1", { observedAt: f.r.clock(), reviewUntil: 3 * DAY, rootHash: "other" });
  assert.equal(rewardSummary(f.r, "alice").pending[0].reviewUntil, null);
});
test("review failures stay distinct from normal confirmation and only the requested wallet is returned", () => {
  const f = fixture(); f.r.cycle.status = () => ({ steps: [{ state: "needs_review" }] });
  assert.equal(rewardSummary(f.r, "alice").pending[0].state, "needs_review");
  assert.deepEqual(rewardSummary(f.r, "bob").pending, []);
});
