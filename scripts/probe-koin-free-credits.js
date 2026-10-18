"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol");
const { policy } = require("../lib/koin-network/free-credits");
const freePolicy = { version: 1, accountDaily: "100", networkDaily: "200", originDaily: "150", accountConcurrent: 2, eligibleModels: ["fixture"] };
const identity = { accountId: P.hash("verified-user"), origin: P.hash("origin") };
const setup = (t, overrides = {}) => fixture(t, { product: "prepaid-usd-v1", freePolicy: { ...freePolicy, ...overrides } });
const req = (f, name, changes = {}) => ({ ...f.request(name), identity, ...changes });

test("free policy has no default entitlement and rejects invalid units/caps/models", () => {
  assert.equal(policy(), null);
  for (const delta of [{ accountDaily: null }, { accountDaily: "250" }, { networkDaily: 200 }, { originDaily: "0" }, { accountConcurrent: 0 }, { eligibleModels: [] }])
    assert.throws(() => policy({ ...freePolicy, ...delta }));
});
test("new USD account can use free credits with no purchased balance and no payment wallet", async t => {
  const f = setup(t), owner = "account-" + identity.accountId;
  const request = req(f, "free-first-use", { owner, freeOnly: true });
  const j = f.ledger.reserve(request); assert.equal(j.funding.paidHold, "0");
  const ready = await f.complete(j.id); f.ledger.acknowledge(j.id, owner, ready.receiptHash);
  const after = f.ledger.creditView(owner, identity);
  assert.equal(after.purchased.spent, "0"); assert.equal(after.purchased.purchased, "0");
  assert.equal(BigInt(after.free.available), 100n - BigInt(ready.receipt.usage.amount));
  assert.equal(f.ledger.pendingJobs().length, 1);
  assert.equal(f.ledger.pendingJobs()[0].settlement.kind, "unified-usage");
  assert.equal(f.ledger.pendingSponsorship().length, 1);
  assert.equal(f.ledger.purchases(owner).length, 0, "free grants must never manufacture purchases");
});
test("mixed use atomically spends free first and charges paid remainder exactly once across restart", async t => {
  const f = setup(t, { accountDaily: "10" }); f.purchase();
  const j = f.ledger.reserve(req(f, "mixed")); assert.equal(j.funding.freeHold, "10"); assert.ok(BigInt(j.funding.paidHold) > 0n);
  const ready = await f.complete(j.id); const charged = f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(charged.funding.freeUsed, "10");
  assert.equal(BigInt(charged.funding.paidUsed) + 10n, BigInt(ready.receipt.usage.amount));
  f.restart(); f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(f.ledger.balance(f.owner).spent, charged.funding.paidUsed);
  assert.equal(f.ledger.creditView(f.owner, identity).free.available, "0");
  assert.equal(f.ledger.pendingSponsorship().length, 1);
});
test("Free only rejects paid continuation before dispatch even when purchased credits exist", t => {
  const f = setup(t, { accountDaily: "10" }); f.purchase();
  assert.throws(() => f.ledger.reserve(req(f, "limited", { freeOnly: true })), /Free only/);
  assert.equal(f.ledger.jobs().length, 0); assert.equal(f.ledger.balance(f.owner).available, "1000");
  assert.equal(f.ledger.creditView(f.owner, identity).free.available, "10");
});
test("Stop, provider rejection and restart restore both held funding portions", async t => {
  const f = setup(t, { accountDaily: "10" }); f.purchase();
  for (const kind of ["stop", "restart", "rejected"]) {
    const j = f.ledger.reserve(req(f, kind));
    if (kind === "restart") f.restart();
    else {
      if (kind === "rejected") { f.ledger.dispatch(j.id, f.provider); assert.throws(() => f.ledger.complete(j.id, { output: "bad", signature: "bad" }, false)); }
      f.ledger.cancel(j.id, f.owner);
    }
    assert.equal(f.ledger.creditView(f.owner, identity).free.available, "10");
    assert.equal(f.ledger.balance(f.owner).available, "1000");
  }
});
test("daily grants survive restart, reset once at UTC midnight and never accumulate", async t => {
  const f = setup(t); const j = f.ledger.reserve(req(f, "today")), ready = await f.complete(j.id);
  f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  const today = f.ledger.creditView(f.owner, identity); f.restart();
  assert.equal(f.ledger.creditView(f.owner, identity).free.available, today.free.available);
  f.time(today.free.resetAt - today.observedAt);
  assert.equal(f.ledger.creditView(f.owner, identity).free.available, "100");
  f.restart(); assert.equal(f.ledger.creditView(f.owner, identity).free.available, "100");
});
test("concurrent allocations share durable global and origin limits across account identities", t => {
  const f = setup(t, { accountDaily: "100", originDaily: "90", networkDaily: "100" });
  const first = f.ledger.reserve(req(f, "one", { freeOnly: true }));
  const secondIdentity = { ...identity, accountId: P.hash("second-user") };
  assert.throws(() => f.ledger.reserve(req(f, "two", { identity: secondIdentity, freeOnly: true })), /Free only/);
  const remaining = f.ledger.creditView(f.owner, secondIdentity).free.available;
  assert.equal(BigInt(remaining), 90n - BigInt(first.funding.freeHold));
  f.ledger.cancel(first.id, f.owner);
  assert.equal(f.ledger.creditView(f.owner, secondIdentity).free.available, "90");
});
test("linking a wallet cannot renew the verified account's grant or change a request preference on retry", async t => {
  const f = setup(t), oldOwner = "account-" + identity.accountId;
  const j = f.ledger.reserve(req(f, "link", { owner: oldOwner, freeOnly: true })), ready = await f.complete(j.id);
  f.ledger.acknowledge(j.id, oldOwner, ready.receiptHash);
  assert.equal(f.ledger.creditView(f.owner, identity).free.available, f.ledger.creditView(oldOwner, identity).free.available);
  assert.throws(() => f.ledger.reserve(req(f, "link", { owner: oldOwner, freeOnly: false })), /another message/);
});
test("missing policy never invents grants and legacy product is never relabelled as USD", t => {
  const f = fixture(t); assert.equal(f.ledger.creditView(f.owner, identity).free.state, "unavailable");
  assert.equal(f.ledger.creditView(f.owner, identity).unit, "legacy-KOIN-1e-8");
});
test("balance snapshot expires mixed holds and creates the daily view in one transaction", t => {
  const f = setup(t, { accountDaily: "10" }); f.purchase();
  const job = f.ledger.reserve(req(f, "expires-during-balance"));
  f.ledger.clock = () => job.expires;
  let writes = 0; const write = f.ledger.write.bind(f.ledger);
  f.ledger.write = fn => { writes++; return write(fn); };
  const balance = f.ledger.creditView(f.owner, identity);
  assert.equal(writes, 1); assert.equal(balance.purchased.available, "1000"); assert.equal(balance.free.available, "10");
  assert.equal(f.ledger.job(job.id).state, "cancelled");
});
