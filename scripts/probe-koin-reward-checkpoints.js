"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { Signer } = require("koilib"), { KoinShadow } = require("../lib/koin-network/shadow");
const { DAY } = require("../lib/koin-network/policy"), { TestRuntime } = require("../lib/koin-network/test-runtime");
const address = Signer.fromSeed("reward-checkpoint-test").getAddress(), now = 3 * DAY + 60000;
const qualification = capacityId => ({ address, capacityId, model: "approved", modelHash: "1".repeat(64),
  modelWeight: "10000", coverageBps: 10000, benchmarkHash: "2".repeat(64), approvedAt: 2 * DAY, expires: now + DAY - 1000 });
class CountingShadow extends KoinShadow {
  save() { super.save(); this.saves = (this.saves || 0) + 1; }
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koin-reward-checkpoint-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shadow = new CountingShadow(dir, { clock: () => now });
  Object.assign(shadow.state, {
    qualifications: Object.fromEntries(["retained", "retired-one", "retired-two"].map(id => [id, qualification(id)])),
    presence: { [address]: { at: now, signedAt: now, ready: true, model: "approved", modelHash: "1".repeat(64), session: "a".repeat(32), sequence: 4 } },
    observations: { [address]: [{ at: DAY, ready: true, model: "approved", modelHash: "1".repeat(64) }] },
    budgets: { 1: { epoch: 1, openedAt: DAY, version: 1, total: "50", availability: "35", work: "15" } },
    days: { 1: { intervals: [{ start: DAY, end: DAY + 60000, slots: [{ ...qualification("retained"), weight: "10000" }] }],
      work: [{ epoch: 1, jobId: "retained-job", address, points: "3", charged: "3", verified: true, finalized: true }], sealed: true } },
  });
  shadow.save(); shadow.saves = 0;
  const runtime = Object.assign(Object.create(TestRuntime.prototype), {
    clock: () => now, stateDir: dir, scheduler: { koinShadow: { ledger: shadow } },
    qualifications: () => Object.values(shadow.state.qualifications), qualified: () => true,
    cycle: { days: () => [], importManifest() {} },
    client: { read: async () => ({ epoch: { opened_at: String(DAY), version: "1", budget: "50", availability_budget: "35", work_budget: "15" } }) },
  });
  return { dir, shadow, runtime, persisted: () => new KoinShadow(dir, { clock: () => now }).state };
}
test("qualification expiry checkpoints once and preserves all historical evidence", async t => {
  const { runtime, shadow, persisted } = setup(t), expected = structuredClone(shadow.state);
  runtime.qualifications = () => [qualification("retained")];
  expected.qualifications["retired-one"].expires = now;
  expected.qualifications["retired-two"].expires = now;
  await runtime.collectRewards();
  assert.equal(shadow.saves, 1);
  assert.deepEqual(shadow.state, expected);
  assert.deepEqual(persisted(), expected);
  shadow.saves = 0;
  await runtime.collectRewards();
  assert.equal(shadow.saves, 0, "unchanged qualifications require no checkpoint");
  assert.deepEqual(persisted(), expected);
});
test("qualification expiry remains durable when a later qualification fails validation", async t => {
  const { runtime, shadow, persisted } = setup(t), expected = structuredClone(shadow.state);
  runtime.qualifications = () => [qualification("retained"), { ...qualification("invalid"), modelHash: "invalid" }];
  expected.qualifications["retired-one"].expires = now;
  expected.qualifications["retired-two"].expires = now;
  await assert.rejects(runtime.collectRewards(), /Verified benchmark identity required/);
  assert.equal(shadow.saves, 1);
  assert.deepEqual(shadow.state, expected);
  assert.deepEqual(persisted(), expected);
});
test("existing sealed manifests import without rewriting unchanged shadow history", async t => {
  const { dir, runtime, shadow, persisted } = setup(t), expected = structuredClone(shadow.state);
  const file = path.join(dir, "manifest-1.json"), envelope = { fixture: "existing signed manifest" };
  fs.writeFileSync(file, JSON.stringify(envelope));
  const manifestBytes = fs.readFileSync(file), shadowBytes = fs.readFileSync(shadow.file);
  let imports = 0;
  runtime.cycle.days = () => ["1"];
  runtime.cycle.importManifest = value => { assert.deepEqual(value, envelope); imports++; };
  await runtime.collectRewards(); await runtime.collectRewards();
  assert.equal(imports, 2, "manifest recovery still runs on every collection pass");
  assert.equal(shadow.saves, 0);
  assert.deepEqual(fs.readFileSync(file), manifestBytes);
  assert.deepEqual(fs.readFileSync(shadow.file), shadowBytes);
  assert.deepEqual(shadow.state, expected);
  assert.deepEqual(persisted(), expected);
});
test("an existing manifest seals durably before an import failure without dropping evidence", async t => {
  const { dir, runtime, shadow, persisted } = setup(t);
  shadow.state.days[1].sealed = false; shadow.save(); shadow.saves = 0;
  const expected = structuredClone(shadow.state); expected.days[1].sealed = true;
  const file = path.join(dir, "manifest-1.json"), manifest = JSON.stringify({ fixture: "existing signed manifest" });
  fs.writeFileSync(file, manifest);
  runtime.cycle.days = () => ["1"];
  runtime.cycle.importManifest = () => { assert.deepEqual(persisted(), expected); throw Error("manifest import unavailable"); };
  await assert.rejects(runtime.collectRewards(), /manifest import unavailable/);
  assert.equal(shadow.saves, 1);
  assert.deepEqual(shadow.state, expected);
  assert.deepEqual(persisted(), expected);
  shadow.saves = 0;
  await assert.rejects(runtime.collectRewards(), /manifest import unavailable/);
  assert.equal(shadow.saves, 0);
  assert.equal(fs.readFileSync(file, "utf8"), manifest);
  assert.deepEqual(persisted(), expected);
});
