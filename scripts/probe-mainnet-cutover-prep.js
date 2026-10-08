"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Signer } = require("koilib");
const { Scheduler, merkleRoot, seedOnce, seedMysteryOnce } = require("../lib/scheduler");
const { snapshot, rootFor, decimal } = require("../lib/kai-earned-snapshot");
const { readRecords } = require("./kai-earned-snapshot");
const { FILE } = require("../lib/legacy-reward-cutoff");
const { configuration, verifyIdentity, prepare, MAINNET_CHAIN, MAINNET_TOKEN, ROLES } = require("../deploy/koin-mainnet/prepare");
const address = n => Signer.fromSeed("mainnet-cutover-probe-" + n).getAddress(), A = address(1), B = address(2);
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cutover-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function record(epoch = 10) {
  const totals = { [A]: "9007199254740993" }, spentSat = { [A]: "17", [B]: "25" }, debts = { [B]: "6" };
  return { epoch, receipts: [{ worker: A }, { worker: B }], spentSat,
    summary: { epoch, root: rootFor(epoch, totals), totals, debts, receipts: 2, persisted: true,
      claims: { [A]: { amount: totals[A] } }, settlement: { status: "complete", rootTx: "fixture" } } };
}
const cutoffFor = r => ({ schema: 1, mode: "legacy-kai-cutoff", effectiveAt: "2026-01-01T00:00:00.000Z", finalEpoch: r.epoch, finalRoot: r.summary.root });
function settings() {
  return { mode: "mainnet-pilot-plan", rpc: ["https://rpc-a.example", "https://rpc-b.example"],
    settings: { owner: A, schedulerUrl: "https://test.example/scheduler", deployRcLimit: "10000", maxRcPerTransaction: "100", maxRcPerDay: "1000",
      limits: { amount: "100", perJob: "10", maxJobs: 10, durationMs: 60000 },
      tariff: { inputAtomsPerMillion: "1", outputAtomsPerMillion: "2", contextTokens: 256, maxOutputTokens: 32, maxLatencyMs: 1000 } },
    funding: { buyerCreditsAtoms: "100", rewardPoolAtoms: "100", maxTotalKoinAtoms: "1100", roles: Object.fromEntries(ROLES.map(r => [r, "100"])) } };
}
const provider = () => ({ getChainId: async () => MAINNET_CHAIN,
  invokeGetContractAddress: async () => ({ value: { address: MAINNET_TOKEN } }),
  invokeGetContractMetadata: async () => ({ value: { hash: "0x1220" + "a".repeat(64) } }) });

test("historical earnings and 10:1 conversion use exact atoms, including debt and dust", () => {
  const r = record(), s = snapshot([r], { firstEpoch: 10, finalEpoch: 10 });
  const a = s.rows.find(r => r.address === A), b = s.rows.find(r => r.address === B);
  assert.equal(a.earnedKaiAtoms, "9007199254741010"); assert.equal(a.proposedKoinAtoms, "900719925474101");
  assert.equal(b.earnedKaiAtoms, "19"); assert.equal(b.proposedKoinAtoms, "1"); assert.equal(b.conversionRemainderKaiAtoms, "9");
  assert.equal(s.totals.proposedKoinAtoms, "900719925474102"); assert.equal(s.payoutEnabled, false);
  assert.equal(decimal("900719925474102"), "9007199.25474102");
  const leaf = crypto.createHash("sha256").update(`10|${A}|9007199254740993`).digest();
  assert.equal(r.summary.root, merkleRoot([leaf]).toString("hex")); assert.equal(rootFor(1, {}), merkleRoot([]).toString("hex"));
});
test("snapshot refuses open, duplicated, mismatched and imprecise history", () => {
  const options = { firstEpoch: 10, finalEpoch: 10 };
  assert.throws(() => snapshot([record(), record()], options), /Duplicate/);
  for (const mutate of [r => { r.summary = null; }, r => { r.spentSat = undefined; }, r => { r.summary.root = "b".repeat(64); },
    r => { r.summary.totals[A] = 9007199254740993; }, r => { r.summary.earnedAtoms = { [A]: "1" }; }, r => { r.summary.claims[A].amount = "1"; }]) {
    const r = record(); mutate(r); assert.throws(() => snapshot([r], options));
  }
  assert.throws(() => snapshot([record()], { firstEpoch: 1, finalEpoch: 10 }), /coverage/);
  const r = record(); r.summary.settlement = { status: "pending" };
  assert.equal(snapshot([r], options).blockers.some(b => b.reason === "legacy_settlement_unresolved"), true);
});
test("transferred balances stay separate from earned KAI", () => {
  const C = address(3), r = record();
  const s = snapshot([r], { firstEpoch: 10, finalEpoch: 10, cutoff: cutoffFor(r),
    chainBalances: { chainId: "testnet-fixture", contract: B, blockId: "0x1220" + "a".repeat(64), blockHeight: "100", balances: { [C]: "1000", [A]: "3" } } });
  assert.equal(s.rows.find(r => r.address === C).proposedKoinAtoms, "0"); assert.equal(s.rows.find(r => r.address === C).currentKaiBalanceAtoms, "1000");
  assert.equal(s.rows.find(r => r.address === A).earnedKaiAtoms, "9007199254741010");
  assert.equal(s.payoutEnabled, false); assert.equal(s.coverage.completeHistoryVerified, false);
});
test("read-only export refuses stale JSON views when SQLite exists", t => {
  const d = temp(t), r = record(); fs.writeFileSync(path.join(d, "epoch-10.json"), JSON.stringify(r));
  assert.deepEqual(readRecords(d, "json"), [r]);
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(d, "kai-store.sqlite"));
  db.exec("CREATE TABLE epochs(epoch INTEGER PRIMARY KEY,data TEXT NOT NULL)"); db.prepare("INSERT INTO epochs VALUES(?,?)").run(10, JSON.stringify(r)); db.close();
  assert.throws(() => readRecords(d, "json"), /stale/); assert.deepEqual(readRecords(d, "sqlite"), [r]);
  fs.writeFileSync(path.join(d, "epoch-10.json"), "{broken"); assert.deepEqual(readRecords(d, "sqlite"), [r]);
});
test("Alpha cutoff survives restarts, stops new rewards and preserves existing settlement recovery", async t => {
  const d = temp(t), r = record(), calls = [];
  fs.writeFileSync(path.join(d, "epoch-10.json"), JSON.stringify(r)); fs.writeFileSync(path.join(d, FILE), JSON.stringify(cutoffFor(r)));
  for (let i = 0; i < 2; i++) {
    const s = new Scheduler({ dataDir: d, storeMode: "json", priceSources: [], settlement: { settleEpoch: async v => { calls.push(v.epoch); return { status: "complete", rootTx: "fixture" }; } } });
    assert.throws(() => s.enqueue({}), /ended/); assert.equal(seedOnce(s), null); assert.equal(seedMysteryOnce(s), null);
    assert.equal(s._servableIndex({ legacy: true }), -1); assert.throws(() => s.closeEpoch(), /disabled/);
    await assert.rejects(s.settleClosedEpoch({ epoch: 11 }), /cutoff/);
    await s.settleClosedEpoch(r.summary); await s.close();
    assert.deepEqual(fs.readdirSync(d).filter(n => /^epoch-/.test(n)), ["epoch-10.json"]);
  }
  assert.deepEqual(calls, [10, 10]);
});
test("absent cutoff preserves Test behavior; invalid/future cutoff fails closed", async t => {
  const d = temp(t), r = record(); fs.writeFileSync(path.join(d, "epoch-10.json"), JSON.stringify(r));
  const s = new Scheduler({ dataDir: d, storeMode: "json", priceSources: [] }); assert.equal(s.legacyRewardCutoff, null); assert.ok(s.enqueue({}).id); await s.close();
  fs.writeFileSync(path.join(d, FILE), "{}"); assert.throws(() => new Scheduler({ dataDir: d, storeMode: "json" }), /cutoff/);
  fs.writeFileSync(path.join(d, FILE), JSON.stringify({ ...cutoffFor(r), effectiveAt: "2999-01-01T00:00:00.000Z" }));
  assert.throws(() => new Scheduler({ dataDir: d, storeMode: "json" }), /cutoff/);
});
test("mainnet plans reject missing budgets, mismatched networks and excessive funding", async () => {
  assert.equal(configuration(settings()).total, "1100");
  for (const change of [s => { s.mode = "test-deployment"; }, s => { s.funding.maxTotalKoinAtoms = "1099"; },
    s => { s.funding.roles.claims = "0"; }, s => { s.settings.limits.amount = "101"; }, s => { s.rpc[1] = s.rpc[0]; }]) {
    const c = settings(); change(c); assert.throws(() => configuration(c));
  }
  await assert.rejects(verifyIdentity(settings().rpc, () => ({ ...provider(), getChainId: async () => "testnet" })), /identity/);
  await assert.rejects(verifyIdentity(settings().rpc, () => ({ ...provider(), invokeGetContractAddress: async () => ({ value: { address: B } }) })), /identity/);
  assert.equal((await verifyIdentity(settings().rpc, provider)).length, 2);
});
test("bootstrap keeps fresh role keys private and cannot activate payments", async t => {
  const d = temp(t), input = path.join(d, "settings.json"), out = path.join(d, "bootstrap"); fs.writeFileSync(input, JSON.stringify(settings()));
  for (const kind of ["credits", "rewards"]) fs.writeFileSync(path.join(d, kind + ".wasm"), Buffer.from("0061736d01000000", "hex"));
  const result = await prepare(out, input, d, { providerFactory: provider }); assert.equal(result.runtimeReady, false); assert.equal(new Set(Object.values(result.roleAddresses)).size, 9);
  const keys = JSON.parse(fs.readFileSync(path.join(out, "offline-keys.json")));
  for (const role of ROLES) { assert.equal(Signer.fromWif(keys[role]).getAddress(), result.roleAddresses[role]); assert.ok(!JSON.stringify(result).includes(keys[role])); }
  if (process.platform !== "win32") { assert.equal(fs.statSync(out).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(out, "offline-keys.json")).mode & 0o777, 0o600); }
  assert.equal(fs.existsSync(path.join(out, "runtime.json")), false);
  await assert.rejects(prepare(out, input, d, { providerFactory: provider }), /new absolute/);
});

test("drain fences parked polls and seeding, then commits an idempotent final cutoff", async t => {
  const d = temp(t), s = new Scheduler({ dataDir: d, storeMode: "json", priceSources: [], epoch: 10 });
  s.enqueue({}); s.pending.set("in-flight", { id: "in-flight" });
  s.legacyRewardTransition({ action: "drain" });
  assert.throws(() => s.enqueue({}), /ended/); assert.equal(s._servableIndex({ legacy: true }), -1); assert.equal(seedOnce(s), null);
  assert.throws(() => s.closeEpoch(), /drain/);
  assert.throws(() => s.legacyRewardTransition({ action: "cutoff", finalEpoch: 10, finalRoot: "a".repeat(64) }), /pending/);
  s.pending.clear();
  const last = s.closeEpoch(); assert.equal(last.persisted, true); assert.deepEqual(last.earnedAtoms, {});
  const command = { action: "cutoff", finalEpoch: last.epoch, finalRoot: last.root };
  const first = s.legacyRewardTransition(command), again = s.legacyRewardTransition(command);
  assert.deepEqual(first.cutoff, again.cutoff); assert.throws(() => s.closeEpoch(), /disabled/);
  await s.close();
  const restart = new Scheduler({ dataDir: d, storeMode: "json", priceSources: [] });
  assert.deepEqual(restart.legacyRewardCutoff, first.cutoff); assert.ok(restart.legacyRewardsDraining);
  await restart.close();
});

test("cutover HTTP actions require the operator secret and refuse unauthenticated callers", async t => {
  const d = temp(t), s = new Scheduler({ dataDir: d, storeMode: "json", priceSources: [], operatorSecret: "cutover-probe-secret" });
  const port = await s.listen(), url = `http://127.0.0.1:${port}/operator/legacy-rewards`;
  try {
    const bad = await fetch(url, { method: "POST", body: JSON.stringify({ action: "drain" }), headers: { "content-type": "application/json" } });
    assert.equal(bad.status, 401); assert.equal(s.legacyRewardsDraining, null);
    const good = await fetch(url, { method: "POST", body: JSON.stringify({ action: "drain" }), headers: { "content-type": "application/json", "x-operator-secret": "cutover-probe-secret" } });
    assert.equal(good.status, 200); assert.equal((await good.json()).draining.mode, "legacy-kai-draining");
    assert.equal((await fetch(`http://127.0.0.1:${port}/consume/chat/completions`, { method: "POST", body: "{}" })).status, 410);
    s._legacyConsumersActive = 1; assert.throws(() => s.closeEpoch(), /drain/); s._legacyConsumersActive = 0;
  } finally { await s.close(); }
});
