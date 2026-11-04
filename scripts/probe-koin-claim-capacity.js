"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { DatabaseSync } = require("node:sqlite");
const { fixture } = require("./helpers/koin-claims-fixture");
const { allowance, reader, plan } = require("../lib/koin-network/claim-sponsorship");
const P = require("../lib/koin-network/job-protocol"), { DAY } = require("../lib/koin-network/policy");
const tick = async f => (await f.runner().tick()).results[0];
function journal(f) {
  const db = new DatabaseSync(path.join(f.dir, "reward-claims.sqlite"), { readOnly: true });
  try { return { identity: db.prepare("SELECT data FROM identity WHERE id=1").get().data,
    claims: db.prepare("SELECT * FROM claims ORDER BY id").all(), mana: db.prepare("SELECT * FROM mana ORDER BY day,id").all() }; }
  finally { db.close(); }
}
test("raising only the daily allowance releases the exact staged claim without erasing prior reservations or signatures", async t => {
  const f = await fixture(t); let authorization = null;
  f.reopen({ sponsorship: () => authorization });
  assert.equal((await tick(f)).action, "await_finality");
  f.finalized(f.sent[0]);
  for (let i = 0; i < 3 && f.ledger.status(f.ids[0]).state !== "paid"; i++) await tick(f);
  assert.equal(f.ledger.status(f.ids[0]).state, "paid");
  assert.equal((await tick(f)).reason, "sponsorship_budget");
  const before = journal(f), signed = structuredClone(f.signed[1]);
  assert.equal(f.ledger.status(f.ids[1]).attempts, 0);
  assert.equal(f.ledger.sponsorshipStatus().remainingFullReservations, "0");
  authorization = { schema: 1, ledgerIdentityHash: P.hash(before.identity), maxRcPerDay: "30000" };
  assert.deepEqual(journal(f), before); // Loading config itself is not a ledger migration.
  assert.equal((await tick(f)).action, "await_finality");
  assert.deepEqual(f.sent[1], signed); assert.equal(f.signed.length, 2);
  const after = journal(f); assert.equal(after.identity, before.identity);
  assert.ok(after.mana.some(r => JSON.stringify(r) === JSON.stringify(before.mana[0])));
  assert.equal(f.ledger.sponsorshipStatus().reservedToday, "20000");
  assert.equal(f.ledger.sponsorshipStatus().remainingFullReservations, "1");
  f.advance(1001); await tick(f); // exact-envelope retry never refunds old reservations
  assert.deepEqual(f.sent[2], signed); assert.equal(f.ledger.sponsorshipStatus().reservedToday, "20000");
  f.reopen({ sponsorship: () => authorization });
  assert.equal(f.ledger.sponsorshipStatus().reservedToday, "20000");
  f.advance(DAY); assert.equal(f.ledger.sponsorshipStatus().reservedToday, "0");
  assert.equal(f.ledger.sponsorshipStatus().remainingFullReservations, "3");
});
test("wrong-ledger, malformed, lower and overlarge authorizations cannot enlarge the claim allowance", () => {
  const identity = "exact-ledger", valid = { schema: 1, ledgerIdentityHash: P.hash(identity), maxRcPerDay: "30000" };
  assert.equal(allowance(null, identity, "15000"), "15000");
  for (const value of [undefined, {}, { ...valid, schema: 2 }, { ...valid, ledgerIdentityHash: P.hash("other") },
    { ...valid, maxRcPerDay: "14999" }, { ...valid, maxRcPerDay: 30000 }, { ...valid, maxRcPerDay: "030000" },
    { ...valid, maxRcPerDay: "18446744073709551616" }, { ...valid, payer: "other" }])
    assert.throws(() => allowance(value, identity, "15000"));
});
test("configuration cannot bypass insufficient Mana, nonce checks or irreversible reward evidence", async t => {
  for (const blocked of ["claim_mana_recharging", "claim_nonce_unavailable", "reversible"]) {
    const f = await fixture(t), identity = journal(f).identity;
    f.reopen({ sponsorship: () => ({ schema: 1, ledgerIdentityHash: P.hash(identity), maxRcPerDay: "1000000" }),
      preflight: async () => blocked === "reversible" ? null : blocked });
    if (blocked === "reversible") f.head.last_irreversible_block = "99";
    const result = await tick(f);
    assert.equal(result.action, "wait"); assert.equal(result.reason, blocked === "reversible" ? "reward_reversible" : blocked);
    assert.equal(f.sent.length, 0); assert.equal(f.ledger.sponsorshipStatus().reservedToday, "0");
  }
});
test("legacy readers can reopen the same ledger after capacity authorization is removed", async t => {
  const f = await fixture(t), identity = journal(f).identity;
  f.reopen({ sponsorship: () => ({ schema: 1, ledgerIdentityHash: P.hash(identity), maxRcPerDay: "30000" }) });
  await tick(f); f.reopen();
  assert.equal(f.ledger.sponsorshipStatus().maxRcPerDay, "15000");
  assert.equal(f.ledger.sponsorshipStatus().reservedToday, "10000");
  assert.equal(journal(f).identity, identity);
});
test("protected config reader rejects writable, linked, oversized and malformed files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claim-capacity-reader-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "policy.json"), load = reader(file);
  assert.equal(load(), null);
  fs.writeFileSync(file, "{}", { mode: 0o640 });
  if (process.getuid() === 0) assert.deepEqual(load(), {});
  else assert.throws(load, /operator-owned/);
  fs.chmodSync(file, 0o666); assert.throws(load);
  fs.chmodSync(file, 0o640); fs.writeFileSync(file, "x".repeat(2049)); assert.throws(load);
  fs.writeFileSync(file, "{"); assert.throws(load);
  fs.unlinkSync(file); fs.symlinkSync(path.join(root, "elsewhere"), file); assert.throws(load);
});
test("capacity estimates include 25 percent headroom and five-day regeneration without floats in amounts", () => {
  assert.equal(plan(100, "100000000").maxRcPerDay, "12500000000");
  assert.equal(plan(100, "100000000").sponsorBalanceTargetAtoms, "62500000000");
  assert.equal(plan(500, "100000000").sponsorBalanceTargetAtoms, "312500000000");
  assert.equal(plan(1000, "100000000").sponsorBalanceTargetAtoms, "625000000000");
  for (const n of [0, 1001, 1.5, NaN]) assert.throws(() => plan(n, "100000000"));
});
