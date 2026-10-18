"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path");
const { fixture, verifier } = require("./helpers/koin-cycle-fixture"), { DAY } = require("../lib/koin-network/policy"), { TestRuntime } = require("../lib/koin-network/test-runtime");
async function setup(t) {
  const f = await fixture(t), pending = [{ id: "newer", createdAt: 2 * DAY + 1, settlement: { state: "needs_review" } }];
  let imported = 0;
  const shadow = { state: { qualifications: {}, budgets: { 1: { epoch: 1, openedAt: DAY, version: 1, total: "50", availability: "35", work: "15" } }, days: { 1: { intervals: [{ start: DAY, end: 2 * DAY, slots: [] }], work: [] } } }, save() {}, tick() {} };
  const runtime = Object.assign(Object.create(TestRuntime.prototype), { clock: () => 2 * DAY + 60000, stateDir: f.dir, rewardTarget: f.target, signers: { [f.target.verifier]: verifier },
    scheduler: { koinShadow: { ledger: shadow } }, qualifications: () => [], qualified: () => false,
    cycle: { days: () => ["1"], importManifest: () => { imported++; } },
    ledger: { pendingJobs: () => pending, pendingSponsorship: () => pending, settledJobs: () => [] },
    rewardObserver: { inspectCycle: async args => { assert.equal(args.minimumTime, String(2 * DAY)); return { state: "verified", totalSpent: "0" }; } },
    client: { read: async (_kind, method) => method === "get_epoch" ? { epoch: { opened_at: String(DAY), version: "1", budget: "50", availability_budget: "35", work_budget: "15" } } : { amount: "0" } } });
  return { f, runtime, pending, shadow, get imported() { return imported; } };
}
test("a newer-day review obligation cannot block an older reconciled irreversible reward epoch", async t => {
  const x = await setup(t), { f, runtime, pending } = x;
  await runtime.collectRewards(); assert.equal(x.imported, 1);

  const file = path.join(f.dir, "manifest-1.json"), original = fs.readFileSync(file, "utf8");
  pending.push({ id: "old uncertain", createdAt: DAY }); await runtime.collectRewards(); assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("unfinalized epoch boundaries and unexplained chain work cannot produce a signed root", async t => {
  const { f, runtime } = await setup(t), file = path.join(f.dir, "manifest-1.json");
  runtime.rewardObserver.inspectCycle = async () => ({ state: "reversible" });
  await runtime.collectRewards(); assert.equal(fs.existsSync(file), false);
  runtime.rewardObserver.inspectCycle = async () => ({ state: "verified", totalSpent: "1" });
  await assert.rejects(runtime.collectRewards(), /Unexplained/); assert.equal(fs.existsSync(file), false);
});

test("a partial first UTC day with no complete minute can seal without inventing availability", async t => {
  const { runtime, shadow } = await setup(t), read = runtime.client.read;
  shadow.state.budgets[1].openedAt = 2 * DAY - 1000; shadow.state.days[1].intervals = [];
  runtime.client.read = async (kind, method) => { const value = await read(kind, method); if (value.epoch) value.epoch.opened_at = String(2 * DAY - 1000); return value; };
  await runtime.collectRewards(); assert.equal(shadow.state.days[1].sealed, true); assert.deepEqual(shadow.state.days[1].intervals, []);
});
