"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { DatabaseSync } = require("node:sqlite");
const { configure, atomicAuthorization } = require("./configure-claim-capacity");
const { configDigest } = require("./update-prepaid-web");
const { FILE, allowance, reader } = require("../../lib/koin-network/claim-sponsorship");
const P = require("../../lib/koin-network/job-protocol");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claim-capacity-config-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: root, config: path.join(root, "config"), state: path.join(root, "state") };
  fs.mkdirSync(p.config); fs.mkdirSync(path.join(p.state, "claims"), { recursive: true });
  const config = { mode: "mainnet-pilot", maxRcPerTransaction: "100000000", maxRcPerDay: "500000000", version: 1,
    roles: { claims: "claims" }, deployment: { product: "prepaid-usd-v1", chainId: "chain", credits: "credits", creditsHash: "creditshash",
      rewards: "rewards", rewardsHash: "rewardshash", token: "token", tokenHash: "tokenhash", verifier: "verifier" } };
  const { product, ...target } = config.deployment;
  const identity = JSON.stringify({ schema: 1, mode: "reward-mainnet-pilot", target: { ...target, version: "1", workCapBps: 8000, rewardBasis: "usd-pool" },
    policy: { payer: "claims", verifier: "claims", maxRcPerDay: config.maxRcPerDay, maxRcPerTransaction: config.maxRcPerTransaction, maxAttempts: 3, minRetryMs: 10000 } });
  const dbFile = path.join(p.state, "claims", "reward-claims.sqlite"), db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE identity(id INTEGER PRIMARY KEY,data TEXT); CREATE TABLE claims(data TEXT); CREATE TABLE mana(amount TEXT)");
  db.prepare("INSERT INTO identity VALUES(1,?)").run(identity); db.prepare("INSERT INTO claims VALUES(?)").run("signed-bytes-and-attempt-history"); db.prepare("INSERT INTO mana VALUES(?)").run("500000000"); db.close();
  fs.writeFileSync(path.join(p.config, "runtime.json"), JSON.stringify(config), { mode: 0o640 });
  fs.writeFileSync(path.join(p.config, "runtime-keys.json"), "private-fixture-never-read");
  const load = reader(path.join(p.config, FILE)); let active = "active", hook = () => {};
  const readOperator = async () => { hook(); return { chainId: config.deployment.chainId, claimSponsorship: {
    version: 1, ledgerIdentityHash: P.hash(identity), payer: "claims", maxRcPerTransaction: config.maxRcPerTransaction,
    maxRcPerDay: allowance(load(), identity, config.maxRcPerDay), reservedToday: "500000000" } }; };
  return { p, config, identity, dbFile, readOperator, set active(v) { active = v; }, set hook(v) { hook = v; },
    options: { paths: p, readOperator, validate: v => v, show: () => active,
      inspectFunding: async () => ({ address: "claims", balanceAtoms: "1000000000", topUpAtoms: "61500000000", transferSubmitted: false }) } };
}
const rootOnly = { skip: process.getuid?.() !== 0 ? "Production authorization files must be root-owned" : false };
test("plan is read-only; apply changes only the bound allowance and immediately verifies it without restarting or touching signed claims", rootOnly, async t => {
  const f = fixture(t), before = fs.readFileSync(f.dbFile), original = fs.readFileSync(path.join(f.p.config, "runtime.json"));
  const planned = await configure(f.options); assert.equal(planned.applied, false); assert.equal(fs.existsSync(path.join(f.p.config, FILE)), false);
  const changed = await configure({ ...f.options, apply: true });
  assert.equal(changed.applied, true); assert.equal(changed.current.maxRcPerDay, "12500000000");
  assert.equal(changed.current.reservedToday, "500000000");
  assert.equal(fs.statSync(path.join(f.p.config, FILE)).mode & 0o777, 0o640);
  assert.equal((await configure({ ...f.options, apply: true })).applied, true);
  assert.deepEqual(fs.readFileSync(f.dbFile), before); assert.deepEqual(fs.readFileSync(path.join(f.p.config, "runtime.json")), original);
  assert.equal(fs.readFileSync(path.join(f.p.config, "runtime-keys.json"), "utf8"), "private-fixture-never-read");
  assert.doesNotMatch(JSON.stringify(changed), /private-fixture/);
});
test("unavailable service, missing capability, wrong identity and concurrent updater do not authorize a budget change", rootOnly, async t => {
  for (const kind of ["stopped", "capability", "identity", "lock"]) {
    const f = fixture(t); let options = { ...f.options, apply: true };
    if (kind === "stopped") f.active = "failed";
    if (kind === "capability") options.readOperator = async () => ({});
    if (kind === "identity") options.readOperator = async () => ({ ...(await f.readOperator()), claimSponsorship: { ...(await f.readOperator()).claimSponsorship, ledgerIdentityHash: P.hash("other") } });
    if (kind === "lock") fs.mkdirSync(path.join(f.p.work, "kai-reward-progress-update.lock"));
    await assert.rejects(configure(options)); assert.equal(fs.existsSync(path.join(f.p.config, FILE)), false);
  }
});
test("configuration changes during funding reads are preserved; post-write verification failure reports the installed file accurately", rootOnly, async t => {
  const f = fixture(t);
  await assert.rejects(configure({ ...f.options, apply: true, inspectFunding: async () => { fs.writeFileSync(path.join(f.p.config, "new-config"), "operator edit"); return {}; } }), /Concurrent configuration change/);
  assert.equal(fs.existsSync(path.join(f.p.config, FILE)), false);
  assert.equal(fs.readFileSync(path.join(f.p.config, "new-config"), "utf8"), "operator edit");
  let reads = 0;
  await assert.rejects(configure({ ...f.options, apply: true, readOperator: async () => { if (++reads === 2) throw Error("offline"); return f.readOperator(); } }), /Allowance file installed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.p.config, FILE))).maxRcPerDay, "12500000000");
});
test("funding RPC failure does not fabricate a balance or prevent an explicitly authorized allowance", rootOnly, async t => {
  const f = fixture(t), result = await configure({ ...f.options, apply: true, inspectFunding: async () => { throw Error("RPC unavailable"); } });
  assert.equal(result.applied, true); assert.equal(result.funding.state, "unavailable"); assert.equal(result.funding.transferSubmitted, false);
});
test("failed authorization persistence before rename leaves the previous allowance intact", rootOnly, t => {
  const f = fixture(t), file = path.join(f.p.config, FILE), previous = "previous exact bytes";
  fs.writeFileSync(file, previous); const digest = configDigest(f.p.config), original = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error("disk flush failed"); };
  try { assert.throws(() => atomicAuthorization(file, {}, path.join(f.p.config, "runtime.json"), digest), /disk flush/); }
  finally { fs.fsyncSync = original; }
  assert.equal(fs.readFileSync(file, "utf8"), previous);
});
