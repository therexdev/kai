"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { readiness, chainReadiness, payoutJournal } = require("./wallet-access-readiness");
function config() {
  return { version: 1, maxRcPerTransaction: "100000000", roles: { settlement: "settlement-wallet", lifecycle: "lifecycle-wallet", claims: "claims-wallet" },
    deployment: { chainId: "chain", credits: "credits", creditsHash: "credits-hash", rewards: "rewards", rewardsHash: "rewards-hash", token: "token", tokenHash: "token-hash" },
    qualificationPolicies: [{ model: "koinos-fast" }, { model: "koinos-smart" }],
    freePolicy: { accountDaily: "10000", networkDaily: "100000", eligibleModels: ["koinos-fast"] },
  };
}
function fakeClient({ liquid = "1000000000000", liabilities = "100000000", network = "100000", rc = "1000000000", paused = false } = {}) {
  const calls = [];
  return { calls,
    verify: async () => { calls.push("verify"); return { credits: { reward_basis: 1, version: "1", sponsor_daily_limit: network, sponsor_account_daily_limit: "10000" }, paused }; },
    read: async (kind, method) => { calls.push([kind, method]); assert.deepEqual([kind, method], ["rewards", "balances"]); return { liquid, liabilities }; },
    provider: { getAccountRc: async address => { calls.push(["mana", address]); return rc; } },
  };
}
test("readiness verifies public pool, existing sponsor ceilings and all payer Mana without a transaction method", async () => {
  const client = fakeClient(), result = await chainReadiness(config(), { client });
  assert.equal(result.state, "verified"); assert.equal(result.rewardPool.unallocatedAtoms, "999900000000");
  assert.equal(result.sponsorship.configuredPolicyCovered, true); assert.equal(result.mana.length, 3);
  assert.ok(result.mana.every(row => row.coversConfiguredCeiling));
  assert.equal(client.calls.length, 5);
  for (const options of [{ liquid: "100", liabilities: "100" }, { network: "1" }, { paused: true }]) {
    const row = await chainReadiness(config(), { client: fakeClient(options) }); assert.equal(row.sponsorship.configuredPolicyCovered, false);
  }
});
test("readiness reports a completed code install separately from empty rewards, low Mana and sponsorship blockers", async () => {
  const c = config(), observed = { operator: { automaticPayouts: true, lastSuccess: 1000, sponsorship: { configured: true, ready: false },
    errors: [{ message: "private-runtime-secret-must-never-appear" }], qualificationModels: [] } };
  const result = await readiness({ config: c, observed, paths: { state: "/unused" }, commit: "a".repeat(40), clock: () => 1001,
    inspectChain: () => chainReadiness(c, { client: fakeClient({ liquid: "0", liabilities: "0", rc: "0" }) }),
    inspectPayouts: () => ({ state: "read", confirmed: 4, pending: 2, needsReview: 1, recent: [], chainRechecked: false }) });
  assert.equal(result.installed, true); assert.equal(result.transactionsSubmittedByCheck, false);
  assert.equal(result.status, "installed-attention-needed"); assert.match(result.next, /Address the listed operating conditions/);
  assert.equal(result.freeCredits.serviceReady, false); assert.equal(result.rewards.payouts.confirmed, 4);
  assert.ok(result.blockers.some(v => v.includes("reward pool"))); assert.equal(result.blockers.filter(v => v.includes("Mana")).length, 3);
  assert.ok(result.blockers.some(v => v.includes("claims need review"))); assert.ok(!JSON.stringify(result).includes("private-runtime"));
});
test("chain outage leaves policy and payout history visible without claiming readiness", async () => {
  const result = await readiness({ config: config(), paths: { state: "/unused" }, commit: "b".repeat(40),
    inspectChain: async () => { throw Error("untrusted RPC body with secret"); }, inspectPayouts: () => ({ state: "not-created", confirmed: 0 }) });
  assert.equal(result.chain.state, "unavailable"); assert.equal(result.freeCredits.serviceReady, false);
  assert.equal(result.qualification.eligibilityCreatedByUpdate, false); assert.ok(!JSON.stringify(result).includes("untrusted RPC"));
});
test("payout summary reads exact deployment journal without writes or exposing signatures and refuses another deployment", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-payout-summary-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "claims")); const file = path.join(root, "claims", "reward-claims.sqlite"), c = config();
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE identity(id INTEGER PRIMARY KEY,data TEXT); CREATE TABLE claims(state TEXT,tx_id TEXT,data TEXT)");
  db.prepare("INSERT INTO identity VALUES(1,?)").run(JSON.stringify({ target: c.deployment }));
  for (const [i, state] of ["paid", "paid_elsewhere", "pending", "needs_review"].entries()) db.prepare("INSERT INTO claims VALUES(?,?,?)").run(state, "0x1220" + String(i).repeat(64), JSON.stringify({ epoch: "20752", outbox: { signatures: ["private-fixture-signature"] } }));
  db.close(); const before = fs.readFileSync(file);
  const result = payoutJournal(root, c.deployment);
  assert.equal(result.confirmed, 2); assert.equal(result.pending, 1); assert.equal(result.needsReview, 1); assert.equal(result.chainRechecked, false);
  assert.equal(result.recent.length, 4); assert.ok(!JSON.stringify(result).includes("signature")); assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(payoutJournal(root, { ...c.deployment, rewards: "other" }).state, "unavailable");
  assert.deepEqual(fs.readFileSync(file), before);
});
