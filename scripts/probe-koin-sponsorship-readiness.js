"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { SponsorshipReadiness } = require("../lib/koin-network/sponsorship-readiness");
const freePolicy = { version: 1, accountDaily: "10", networkDaily: "100", originDaily: "50", accountConcurrent: 1, eligibleModels: ["fixture"] };
const verified = { credits: { version: "1", reward_basis: 1, sponsor_daily_limit: "100", sponsor_account_daily_limit: "10" } }, pool = { liquid: "1000000", liabilities: "0" };
test("free admission requires configured ceilings, fresh proof and funded uncommitted rewards", () => {
  let now = 100000; const gate = new SponsorshipReadiness({ freePolicy, version: 1, clock: () => now });
  assert.equal(gate.ready(), false); assert.equal(gate.refresh(verified, pool), true); assert.equal(gate.ready(), true);
  now += 30000; assert.equal(gate.ready(), false); assert.equal(gate.refresh(verified, pool, now - 30000), false);
  for (const delta of [{ sponsor_daily_limit: "99" }, { sponsor_account_daily_limit: "9" }, { sponsor_daily_limit: undefined }, { version: "2" }, { reward_basis: 0 }])
    assert.equal(gate.refresh({ credits: { ...verified.credits, ...delta } }, pool), false);
  for (const state of [{ liquid: "0", liabilities: "0" }, { liquid: "10", liabilities: "10" }, { liquid: "1000000", liabilities: "1000001" }, { liquid: "1", liabilities: "0" }])
    assert.equal(gate.refresh(verified, state), false);
  assert.equal(gate.refresh({ ...verified, paused: true }, pool), false);
  assert.equal(new SponsorshipReadiness({ version: 1 }).refresh(verified, pool), false);
});
test("sponsorship outage leaves purchased credits usable and lets allocated free replies complete", async t => {
  const { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol");
  const f = fixture(t, { product: "prepaid-usd-v1", freePolicy: { ...freePolicy, accountDaily: "100", originDaily: "100" } }); f.purchase();
  const identity = { accountId: P.hash("user"), origin: P.hash("origin") }; let ready = true; f.ledger.free.isAvailable = () => ready;
  const j = f.ledger.reserve({ ...f.request("allocated"), identity, freeOnly: true }); ready = false;
  const delivered = await f.complete(j.id); f.ledger.acknowledge(j.id, f.owner, delivered.receiptHash);
  assert.equal(f.ledger.balance(f.owner).spent, "0");
  const view = f.ledger.creditView(f.owner, identity); assert.equal(view.free.state, "unavailable"); assert.equal(view.purchased.available, "1000");
  const paid = f.ledger.reserve({ ...f.request("paid-during-outage"), identity }); assert.equal(paid.funding.freeHold, "0"); assert.ok(BigInt(paid.funding.paidHold) > 0n);
});
