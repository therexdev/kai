"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path");
const { fixture, verifier } = require("./helpers/koin-cycle-fixture"), { DAY } = require("../lib/koin-network/policy"), { TestRuntime } = require("../lib/koin-network/test-runtime");
const { KoinShadow } = require("../lib/koin-network/shadow"), { RewardObserver } = require("../lib/koin-network/reward-observer");
const { Serializer, utils } = require("koilib"), ABI = require("../lib/koin-network/rewards-abi.json"), CABI = require("../lib/koin-network/credits-abi.json");
async function setup(t) {
  const f = await fixture(t), pending = [{ id: "newer", createdAt: 2 * DAY + 1, settlement: { state: "needs_review" } }];
  let imported = 0;
  const shadow = Object.assign(Object.create(KoinShadow.prototype), { state: { qualifications: {}, budgets: { 1: { epoch: 1, openedAt: DAY, version: 1, total: "50", availability: "35", work: "15" } }, days: { 1: { intervals: [{ start: DAY, end: 2 * DAY, slots: [] }], work: [] } } }, save() {}, tick() {} });
  f.advance(DAY + 59000); f.epochs.set("1", { ...f.baseEpoch("1"), opened_at: String(DAY) }); f.balances.liabilities = "50";
  let spent = "0"; const originalRead = f.rpc.readContract, serializer = new Serializer(ABI.types);
  f.rpc.readContract = async operation => operation.contract_id === f.target.credits && operation.entry_point === CABI.methods.get_spend.entry_point
    ? { result: utils.encodeBase64url(await serializer.serialize({ amount: spent }, "koin.Result")) } : originalRead(operation);
  const runtime = Object.assign(Object.create(TestRuntime.prototype), { clock: () => 2 * DAY + 60000, stateDir: f.dir, rewardTarget: f.target, signers: { [f.target.verifier]: verifier },
    scheduler: { koinShadow: { ledger: shadow } }, qualifications: () => [], qualified: () => false,
    cycle: { days: () => ["1"], importManifest: () => { imported++; } },
    ledger: { pendingJobs: () => pending, pendingSponsorship: () => pending, settledJobs: () => [] },
    rewardObserver: new RewardObserver(f.rpc, { target: f.target, clock: f.clock }),
    client: { read: async (_kind, method) => method === "get_epoch" ? { epoch: { opened_at: String(DAY), version: "1", budget: "50", availability_budget: "35", work_budget: "15" } } : { amount: "0" } } });
  return { f, runtime, pending, shadow, setSpent(value) { spent = value; }, get imported() { return imported; } };
}
test("a newer-day review obligation cannot block an older reconciled irreversible reward epoch", async t => {
  const x = await setup(t), { f, runtime, pending } = x;
  await runtime.collectRewards(); assert.equal(x.imported, 1);

  const file = path.join(f.dir, "manifest-1.json"), original = fs.readFileSync(file, "utf8");
  pending.push({ id: "old uncertain", createdAt: DAY }); await runtime.collectRewards(); assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("unfinalized epoch boundaries and unexplained chain work cannot produce a signed root", async t => {
  const { f, runtime, setSpent } = await setup(t), file = path.join(f.dir, "manifest-1.json");
  f.head.last_irreversible_block = "0";
  await runtime.collectRewards(); assert.equal(fs.existsSync(file), false);
  f.head.last_irreversible_block = f.head.head_topology.height; setSpent("1");
  await runtime.collectRewards(); // The changed spend invalidates the earlier snapshot.
  await assert.rejects(runtime.collectRewards(), /Unexplained/); assert.equal(fs.existsSync(file), false);
});

test("a partial first UTC day with no complete minute can seal without inventing availability", async t => {
  const { runtime, shadow } = await setup(t), read = runtime.client.read;
  shadow.state.budgets[1].openedAt = 2 * DAY - 1000; shadow.state.days[1].intervals = [];
  runtime.client.read = async (kind, method) => { const value = await read(kind, method); if (value.epoch) value.epoch.opened_at = String(2 * DAY - 1000); return value; };
  await runtime.collectRewards(); assert.equal(shadow.state.days[1].sealed, true); assert.deepEqual(shadow.state.days[1].intervals, []);
});
