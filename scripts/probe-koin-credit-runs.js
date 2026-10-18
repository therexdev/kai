"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol");
function setup(t) {
  const f = fixture(t, { product: "prepaid-usd-v1", freePolicy: { version: 1, accountDaily: "40", networkDaily: "1000", originDaily: "1000", accountConcurrent: 4, eligibleModels: ["fixture"] } });
  f.purchase(); const identity = { accountId: P.hash("verified-user"), origin: P.hash("origin") }, id = P.hash("advanced-run");
  const terms = { id, identity, owner: f.owner, model: "fixture", mode: "research", maxTotal: "120", freeOnly: false };
  f.ledger.runs.open(terms);
  return { ...f, get ledger() { return f.ledger; }, identity, id, terms, request: name => ({ ...f.request(name), identity, runId: id }) };
}
test("one immutable run ceiling covers all subcalls, concurrent holds and retries across restart", async t => {
  const f = setup(t), one = f.ledger.reserve(f.request("first"));
  assert.equal(f.ledger.runs.status(f.id, f.identity).modelCalls, 1);
  assert.throws(() => f.ledger.reserve(f.request("concurrent")), /Total run budget/);
  const ready = await f.complete(one.id); f.ledger.acknowledge(one.id, f.owner, ready.receiptHash);
  const spent = f.ledger.runs.status(f.id, f.identity).spent; assert.equal(spent, ready.receipt.usage.amount);
  f.ledger.reserve(f.request("first")); assert.equal(f.ledger.runs.status(f.id, f.identity).spent, spent);
  assert.throws(() => f.ledger.runs.open({ ...f.terms, maxTotal: "200" }), /terms cannot change/);
  assert.throws(() => f.ledger.runs.get(f.id, { accountId: P.hash("stranger") }), /unavailable/);
  f.restart(); assert.equal(f.ledger.runs.status(f.id, f.identity).spent, spent);
  assert.throws(() => f.ledger.reserve(f.request("retry-after-restart")), /Total run budget/);
});
test("Stop releases unfinished run work, preserves delivered results, and cannot reopen the same run", async t => {
  const f = setup(t), one = f.ledger.reserve(f.request("first")), ready = await f.complete(one.id);
  f.ledger.acknowledge(one.id, f.owner, ready.receiptHash);
  const stopped = f.ledger.runs.stop(f.id, f.identity); assert.equal(stopped.spent, ready.receipt.usage.amount);
  assert.equal(f.ledger.decrypt(one.id, f.ledger.job(one.id).answer), "Private answer");
  assert.equal(f.ledger.runs.open(f.terms).state, "stopped");
  assert.throws(() => f.ledger.reserve(f.request("new-after-stop")), /stopped/);
  const terms = { ...f.terms, id: P.hash("unfinished"), maxTotal: "200" };
  f.ledger.runs.open(terms); f.ledger.reserve({ ...f.request("pending"), runId: terms.id });
  const result = f.ledger.runs.stop(terms.id, f.identity); assert.equal(result.spent, "0"); assert.equal(result.pending, "0");
  assert.equal(f.ledger.balance(f.owner).held, "0");
});
test("run routing and free-only preferences cannot change after approval", t => {
  const f = setup(t);
  assert.throws(() => f.ledger.reserve({ ...f.request("changed-wallet"), owner: f.provider }), /changed/);
  assert.throws(() => f.ledger.reserve({ ...f.request("changed-free"), freeOnly: true }), /changed/);
  f.time(86400001); assert.throws(() => f.ledger.reserve(f.request("expired")), /expired/);
});
test("streamed run usage counts paid and free portions once while retaining the undelivered ceiling", async t => {
  const f = setup(t), request = { ...f.request("streamed"), stream: true }, j = f.ledger.reserve(request), job = f.ledger.dispatch(j.id, f.provider), output = "Hi";
  const signature = Buffer.from(await f.worker.signHash(require("../lib/koin-network/funded-protocol").fundedChunkHash(f.target, job, output, 1))).toString("base64");
  const delivered = f.ledger.streamChunk(j.id, { output, signature, sequence: 1 }, true);
  const during = f.ledger.runs.status(f.id, f.identity);
  assert.equal(BigInt(during.spent) + BigInt(during.pending), BigInt(j.quote.maxCharge));
  assert.ok(BigInt(delivered.funding.freeUsed) > 0n); assert.ok(BigInt(delivered.funding.paidUsed) > 0n);
  f.ledger.streamChunk(j.id, { output, signature, sequence: 1 }, true); assert.equal(f.ledger.runs.status(f.id, f.identity).spent, during.spent);
  const stopped = f.ledger.runs.stop(f.id, f.identity); assert.equal(stopped.spent, during.spent); assert.equal(stopped.pending, "0");
  f.restart(); assert.equal(f.ledger.runs.status(f.id, f.identity).spent, during.spent); assert.equal(f.ledger.decrypt(j.id, f.ledger.job(j.id).answer), output);
});
test("Free only run cannot continue on purchased credits and failed admission creates no charge", t => {
  const f = setup(t), runId = P.hash("free-only-run"); f.ledger.runs.open({ ...f.terms, id: runId, freeOnly: true });
  assert.throws(() => f.ledger.reserve({ ...f.request("not-enough-free"), runId, freeOnly: true }), /Free only/);
  const state = f.ledger.runs.status(runId, f.identity); assert.equal(state.spent, "0"); assert.equal(state.modelCalls, 0);
  assert.equal(f.ledger.balance(f.owner).spent, "0");
});
