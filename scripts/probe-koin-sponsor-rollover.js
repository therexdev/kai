"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol"), { DAY } = require("../lib/koin-network/policy");
test("previous-day free obligations retain headroom across midnight and finalized settlement day", async t => {
  const f = fixture(t, { product: "prepaid-usd-v1", freePolicy: { version: 1, accountDaily: "100", networkDaily: "100", originDaily: "100", accountConcurrent: 2, eligibleModels: ["fixture"] } });
  const identity = { accountId: P.hash("rollover-account"), origin: P.hash("rollover-origin") };
  const day = Math.floor(f.ledger.clock() / DAY); f.time((day + 1) * DAY - 1000 - f.ledger.clock());
  const messages = [{ role: "user", content: "1234567890" }];
  const input = f.meter.quote(f.target.domain, "fixture", 1, messages, 1, f.ledger.clock()).inputTokens;
  const req = { ...f.request("before-midnight"), identity, messages, maxOutput: 100 - input, freeOnly: true };
  const j = f.ledger.reserve(req), ready = await f.complete(j.id, "x".repeat(100 - input)); f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(f.ledger.job(j.id).funding.freeUsed, "100"); f.time(1001);
  assert.equal(f.ledger.creditView(f.owner, identity, "fixture").free.available, "0", "yesterday's unsettled grant still occupies today's settlement headroom");
  f.restart(); assert.equal(f.ledger.creditView(f.owner, identity, "fixture").free.available, "0");
  f.ledger.settlement(j.id, { state: "finalized", finality: { state: "finalized", blockTime: String(f.ledger.clock()) } });
  assert.equal(f.ledger.creditView(f.owner, identity, "fixture").free.available, "0", "finalizing today must not reopen today's ceiling");
  f.purchase(); assert.equal(f.ledger.balance(f.owner).available, "1000", "purchased credits remain usable");
  f.time(DAY); assert.equal(f.ledger.creditView(f.owner, identity, "fixture").free.available, "100");
});
test("already-admitted rollover backlog waits for verified daily headroom without signing a doomed settlement", async () => {
  const { sponsorHeadroom } = require("../lib/koin-network/sponsor-headroom");
  let now = 2 * DAY + 1000, chainSpent = "100";
  const accountId = P.hash("same-customer"), first = { receipt: { usage: { amount: "100" } }, funding: { accountId, freeUsed: "100" }, finality: { blockTime: String(now) } };
  const job = { funding: { accountId, freeUsed: "100" } }, ledger = { settledJobs: () => [first] };
  const client = { verify: async () => ({ credits: { sponsor_daily_limit: "100", sponsor_account_daily_limit: "100" } }),
    provider: { getHeadInfo: async () => ({ head_block_time: String(now), head_topology: { id: "0x1220" + P.hash("head"), height: "10" } }) }, read: async () => ({ amount: chainSpent }) };
  const check = () => sponsorHeadroom({ client, ledger, job, clock: () => now });
  assert.equal(await check(), false, "the second 100-atom obligation waits instead of exceeding today's 100-atom cap");
  now += DAY; chainSpent = "0"; assert.equal(await check(), true, "same obligation can settle the next day without changing its amount or ID");
  chainSpent = "1"; assert.equal(await check(), false, "unexplained chain work is never treated as unused sponsorship");
  chainSpent = "0"; delete first.finality.blockTime; assert.equal(await check(), false, "historical finality needs a known settlement day");
});
