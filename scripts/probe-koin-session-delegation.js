"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Signer, Transaction } = require("koilib");
const { setup, sign } = require("./helpers/koin-delegation-fixture");
const P = require("../lib/koin-network/job-protocol"), D = require("../lib/koin-network/session-delegation");
const { FundedReservations, fundedResultHash } = require("../lib/koin-network/funded-reservations");
const path = require("path");
const { nextId } = require("./helpers/koin-funding-fixture");

test("one owner approval supports multiple bounded requests without per-job signatures or USD charges", async t => {
  const f = await setup(t), approval = await f.authorize();
  for (const n of ["one", "two", "three"]) {
    const h = await f.ledger.reserveDelegated(f.request(approval, n));
    assert.equal(h.delegationId, approval.delegationId); assert.equal(h.signature, undefined); assert.equal(h.paymentsEnabled, false);
  }
  await assert.rejects(f.ledger.reserveDelegated(f.request(approval, "four")), /spending limit/);
  const status = await f.post("status", { id: approval.delegationId });
  assert.equal(status.body.remainingJobs, 0); assert.equal(status.body.spent, "0");
  assert.equal(f.accounts.spendableGrant(f.account.id, f.grant.id).remainingMicro, 1000000);
  assert.equal((await f.ledger.reserveDelegated(f.request(approval))).id, P.hash("one"));
});

test("changed limits, accounts, chain pins and legacy signatures cannot authorize a session", async t => {
  const f = await setup(t), review = await f.review(), signature = await sign(D.hash(review.terms));
  for (const alter of [
    x => { x.amount = "600"; }, x => { x.perJob = "201"; }, x => { x.maxJobs++; }, x => { x.expires++; },
    x => { x.maxOutput++; }, x => { x.accountId = "acc_other"; }, x => { x.grantId = "grant_other"; },
    x => { x.session = P.hash("another"); }, x => { x.target.creditsHash = "0x1220" + P.hash("other"); },
    x => { x.target.domain = "shadow:other"; },
  ]) {
    const terms = structuredClone(review.terms); alter(terms);
    const r = await f.post("authorize", { terms, signature, observationId: f.observationId, grantId: f.grant.id });
    assert.ok(r.status >= 400);
  }
  const legacy = await sign(P.authorizeHash(f.target.domain, f.id, P.hash("one"), f.quote().hash));
  assert.ok((await f.post("authorize", { terms: review.terms, signature: legacy, observationId: f.observationId, grantId: f.grant.id })).status >= 400);
  for (const change of [{ amount: "1001" }, { perJob: "201" }, { expires: f.proposal.expires + 60001 }, { maxJobs: 11 }]) await assert.rejects(f.review(change));
});

test("a second delegation cannot reset a session budget and revoked approval cannot replay after restart", async t => {
  const f = await setup(t), first = await f.authorize();
  await assert.rejects(f.authorize(), /already has a delegation/);
  await f.ledger.reserveDelegated(f.request(first));
  const revoked = await f.post("revoke", { id: first.delegationId }); assert.equal(revoked.body.state, "revoked"); assert.equal(revoked.body.held, "0");
  await f.restart();
  const replay = await f.post("authorize", first.request); assert.equal(replay.body.state, "revoked");
  await assert.rejects(f.ledger.reserveDelegated(f.request(first, "new")), /revoked/);
  await assert.rejects(f.authorize(), /already has a delegation/);
});

test("parallel processes share both the delegated cap and funded budget", async t => {
  const f = await setup(t), approval = await f.authorize(await f.review({ amount: "100", perJob: "100", maxJobs: 10 }));
  const other = new FundedReservations(path.join(f.config.dataDir, "koin-funded-sessions"), {
    observer: f.observer, target: f.target, meter: f.meter, accounts: f.accounts, clock: f.config.koinFundedSessions.clock });
  t.after(() => other.close());
  const results = await Promise.allSettled([f.ledger.reserveDelegated(f.request(approval, "a")), other.reserveDelegated(f.request(approval, "b"))]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.ledger.delegationStatus({ id: approval.delegationId, accountId: f.account.id }).remainingJobs, 9);
});

test("account isolation and grant revocation block reservations and queued dispatch but permit historical revocation", async t => {
  const f = await setup(t), approval = await f.authorize(), r = f.request(approval); await f.ledger.reserveDelegated(r);
  const account = f.accounts._newAccount({ email: "other@example.invalid" }), token = f.accounts._issueSession(account.id, "other");
  for (const action of ["status", "revoke"]) assert.ok((await f.post(action, { id: approval.delegationId }, token)).status >= 400);
  await assert.rejects(f.ledger.reserveDelegated({ ...f.request(approval, "other"), accountId: account.id }), /another account/);
  f.accounts.revokeGrant(f.account, f.grant.id);
  await assert.rejects(f.ledger.reserveDelegated(f.request(approval, "new")));
  await assert.rejects(f.ledger.markDispatched({ id: r.id, observationId: f.observationId, provider: Signer.fromSeed("worker").getAddress() }));
  assert.equal((await f.post("status", { id: approval.delegationId })).body.state, "account_unavailable");
  assert.equal((await f.post("revoke", { id: approval.delegationId })).body.state, "revoked");
});

test("revocation preserves dispatched liability and its accepted result, releasing only queued work", async t => {
  const f = await setup(t), approval = await f.authorize(), a = f.request(approval, "a"), b = f.request(approval, "b");
  await f.ledger.reserveDelegated(a); await f.ledger.reserveDelegated(b);
  const worker = Signer.fromSeed("funded-delegated-worker"), job = await f.ledger.markDispatched({ id: a.id, observationId: f.observationId, provider: worker.getAddress() });
  const revoked = await f.post("revoke", { id: approval.delegationId }); assert.equal(revoked.body.held, a.quote.maxCharge);
  const signature = Buffer.from(await worker.signHash(fundedResultHash(f.target, job, "4"))).toString("base64");
  f.ledger.complete({ id: a.id, output: "4", signature });
  const status = f.ledger.delegationStatus({ id: approval.delegationId, accountId: f.account.id });
  assert.equal(status.held, String(a.quote.inputTokens + 1)); assert.equal(status.remainingJobs, 2);
  assert.equal(f.ledger.prepare(a.id).amount, status.held);
});

test("expired session approvals and stale chain evidence cannot admit or dispatch new work", async t => {
  const f = await setup(t), approval = await f.authorize(), r = f.request(approval); await f.ledger.reserveDelegated(r);
  f.time(f.proposal.expires);
  await assert.rejects(f.ledger.reserveDelegated(f.request(approval, "late")), /expired/);
  await assert.rejects(f.ledger.markDispatched({ id: r.id, observationId: f.observationId, provider: Signer.fromSeed("worker").getAddress() }), /expired/);
  assert.equal((await f.post("status", { id: approval.delegationId })).body.state, "expired");
  const g = await setup(t), a = await g.authorize(); g.metadata.value.hash = "0x1220" + P.hash("replacement");
  await assert.rejects(g.ledger.reserveDelegated(g.request(a)), /bytecode/);
});

test("settled charges remain inside the delegated lifetime budget after reconciliation and restart", async t => {
  const f = await setup(t), approval = await f.authorize(await f.review({ amount: "100", perJob: "100", maxJobs: 10 }));
  const r = f.request(approval), worker = Signer.fromSeed("funded-budget-worker"); await f.ledger.reserveDelegated(r);
  const job = await f.ledger.markDispatched({ id: r.id, observationId: f.observationId, provider: worker.getAddress() });
  const signature = Buffer.from(await worker.signHash(fundedResultHash(f.target, job, "4"))).toString("base64");
  const receipt = f.ledger.complete({ id: r.id, output: "4", signature }), charge = BigInt(receipt.usage.amount);
  f.ledger.prepare(r.id); const op = await f.ledger.settlementOperation(r.id);
  const tx = await Transaction.prepareTransaction({ header: { chain_id: f.target.chainId, payer: f.owner, nonce: "KAE=", rc_limit: "1000000" },
    operations: [{ call_contract: op }], signatures: [] });
  f.ledger.recordTransaction({ id: r.id, txId: tx.id });
  f.session.session.remaining = String(1000n - charge); f.session.session.jobs = "1"; f.session.session.nonce = "1";
  f.balances.balance.reserved = String(1000n - charge); f.balances.liabilities = String(1020n - charge); f.balances.liquid = String(1020n - charge);
  f.block.block_id = nextId; f.block.block_height = "101"; f.block.block.id = nextId; f.block.block.header.height = "101";
  f.block.block.transactions = [tx]; f.block.receipt = { id: nextId, height: "101", transaction_receipts: [{ id: tx.id, reverted: false }] };
  f.head.last_irreversible_block = "101";
  f.rpc.getTransactionsById = async () => ({ transactions: [{ transaction: tx, containing_blocks: [nextId] }] });
  f.rpc.getBlocksById = async () => ({ block_items: [{ block_id: nextId, block_height: "101" }] });
  const reconciliation = await f.observer.observe({ id: f.id, owner: f.owner, purpose: "reconciliation" });
  assert.equal((await f.ledger.reconcile({ id: r.id, observationId: reconciliation.observationId })).state, "settled");
  await f.restart();
  const status = await f.post("status", { id: approval.delegationId }); assert.equal(status.body.spent, String(charge));
  assert.equal(status.body.available, String(100n - charge)); assert.equal(status.body.remainingJobs, 9);
  const observed = await f.observer.observe({ id: f.id, owner: f.owner });
  await f.ledger.reserveDelegated({ ...f.request(approval, "two"), observationId: observed.observationId });
  await assert.rejects(f.ledger.reserveDelegated({ ...f.request(approval, "three"), observationId: observed.observationId }), /spending limit/);
});
