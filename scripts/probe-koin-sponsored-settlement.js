"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Signer } = require("koilib");
const { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol"), Policy = require("../lib/koin-network/policy");
const { PrepaidSettlement } = require("../lib/koin-network/prepaid-settlement");
for (const mixed of [false, true]) test(`${mixed ? "mixed" : "wallet-free"} usage submits one combined receipt without manufacturing a purchase`, async t => {
  const f = fixture(t, { product: "prepaid-usd-v1", freePolicy: { version: 1, accountDaily: mixed ? "10" : "1000", networkDaily: "2000", originDaily: "1000", accountConcurrent: 2, eligibleModels: ["fixture"] } });
  const identity = { accountId: P.hash("account"), origin: P.hash("origin") }, owner = mixed ? f.owner : "account-" + identity.accountId;
  if (mixed) f.purchase();
  const j = f.ledger.reserve({ ...f.request("sponsored-job"), identity, owner }), ready = await f.complete(j.id), consumed = f.ledger.acknowledge(j.id, owner, ready.receiptHash);
  const before = f.ledger.balance(owner), calls = [], signed = new Map(), submitted = [];
  const verifier = Signer.fromSeed("fixture-verifier").getAddress();
  const client = { d: { product: "prepaid-usd-v1", verifier }, verify: async () => {}, operation: async (kind, method, args) => { calls.push({ kind, method, args }); return { kind, method, args }; },
    provider: { getNonce: async () => 0, getAccountRc: async () => "1000", call: async (_method, body) => { submitted.push(body.transaction); throw Error("Lost fixture transport response"); } } };
  const signing = { reconcile: async () => {}, statusFor: () => null, status: () => [], prepare: async (id, { operation }) => {
    if (signed.has(id)) { assert.deepEqual(signed.get(id).operations[0].call_contract, operation); return signed.get(id); }
    const tx = { id: "0x1220" + P.hash(id), header: { payer: verifier, rc_limit: "1", nonce: require("../lib/koin-network/settlement-outbox").encodeNonce("1") }, operations: [{ call_contract: operation }] }; signed.set(id, tx); return tx;
  } };
  const settle = new PrepaidSettlement({ client, ledger: f.ledger, signing, clock: () => f.ledger.clock(), config: { roles: { settlement: verifier }, maxRcPerTransaction: "1", maxRcPerDay: "10" } });
  await settle.tick(); f.time(30001); await settle.tick();
  assert.equal(signed.size, 1); assert.equal(submitted.length, 2); assert.deepEqual(submitted[0], submitted[1]);
  assert.equal(calls[0].method, "settle_credit_usage"); assert.equal(calls[0].args.amount, consumed.funding.paidUsed);
  assert.equal(calls[0].args.charge.amount, consumed.receipt.usage.amount); assert.equal(!!calls[0].args.account, mixed);
  assert.equal(Buffer.from(calls[0].args.id, "base64url").toString("hex"), identity.accountId);
  assert.deepEqual(f.ledger.balance(owner), before); assert.equal(f.ledger.purchases(owner).length, mixed ? 1 : 0);
  assert.equal(f.ledger.pendingSponsorship().length, 1, "broadcast response alone is not finality");
  f.ledger.settlement(j.id, { state: "finalized", txId: submitted[0].id, finality: { state: "finalized" } });
  assert.equal(f.ledger.pendingSponsorship().length, 0); assert.equal(f.ledger.settledJobs().length, 1);
  f.restart(); assert.deepEqual(f.ledger.balance(owner), before); assert.equal(f.ledger.pendingSponsorship().length, 0);
});
test("finalized sponsored USD work shares only the fixed work pool; legacy free work remains excluded", () => {
  const budget = Policy.dailyBudget({ balance: "1000000000000", openedAt: Policy.DAY });
  const work = [{ epoch: 1, jobId: "sponsored", address: "provider", points: "100", charged: "100", verified: true, finalized: true, free: true, sponsored: true }];
  assert.equal(Policy.allocate({ budget, intervals: [], work }).allocations.length, 0);
  const allocation = Policy.allocate({ budget, intervals: [], work, workBasis: "usd-pool" });
  assert.equal(allocation.allocations[0].work, budget.work);
  for (const change of [{ finalized: false }, { verified: false }, { sponsored: false }, { refunded: true }])
    assert.equal(Policy.allocate({ budget, intervals: [], work: [{ ...work[0], ...change }], workBasis: "usd-pool" }).allocations.length, 0);
});
