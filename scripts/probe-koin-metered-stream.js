"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/koin-prepaid-fixture"), F = require("../lib/koin-network/funded-protocol");
async function prefix(f, job, output, sequence) {
  return { output, sequence, signature: Buffer.from(await f.worker.signHash(F.fundedChunkHash(f.target, job, output, sequence))).toString("base64") };
}
test("signed stream prefixes debit cumulative usage once and Stop retains exactly the delivered reply", async t => {
  const f = fixture(t); f.purchase(); const j = f.ledger.reserve({ ...f.request("stream"), stream: true }), job = f.ledger.dispatch(j.id, f.provider);
  const first = await prefix(f, job, "One", 1), second = await prefix(f, job, "One two", 2);
  const a = f.ledger.streamChunk(j.id, first, true); f.ledger.streamChunk(j.id, first, true);
  assert.equal(f.ledger.balance(f.owner).spent, a.receipt.usage.amount);
  const b = f.ledger.streamChunk(j.id, second, true), stopped = f.ledger.cancel(j.id, f.owner);
  assert.equal(stopped.state, "charged"); assert.equal(f.ledger.decrypt(j.id, stopped.answer), "One two");
  assert.equal(f.ledger.balance(f.owner).spent, b.receipt.usage.amount); assert.equal(f.ledger.balance(f.owner).held, "0");
  f.restart(); assert.equal(f.ledger.decrypt(j.id, f.ledger.job(j.id).answer), "One two");
  f.ledger.acknowledge(j.id, f.owner, b.receiptHash);
  assert.equal(f.ledger.balance(f.owner).spent, b.receipt.usage.amount);
  assert.throws(() => f.ledger.streamChunk(j.id, { ...second, sequence: 3 }, true), /stopped/);
});
test("stream restart closes the remaining allocation while preserving its verified usage and encrypted prefix", async t => {
  const f = fixture(t); f.purchase(); const j = f.ledger.reserve({ ...f.request("restart-stream"), stream: true }), job = f.ledger.dispatch(j.id, f.provider);
  const ready = f.ledger.streamChunk(j.id, await prefix(f, job, "Hello", 1), true); f.restart();
  const saved = f.ledger.job(j.id); assert.equal(saved.state, "charged"); assert.equal(saved.reason, "service_restarted");
  assert.equal(f.ledger.balance(f.owner).spent, ready.receipt.usage.amount); assert.equal(f.ledger.balance(f.owner).held, "0");
  assert.equal(f.ledger.pendingJobs().length, 1);
});
test("out-of-order, changed, rejected and tampered prefixes cannot consume credits", async t => {
  const f = fixture(t); f.purchase(); const j = f.ledger.reserve({ ...f.request("bad-stream"), stream: true }), job = f.ledger.dispatch(j.id, f.provider);
  const first = await prefix(f, job, "Hello", 1);
  assert.throws(() => f.ledger.streamChunk(j.id, { ...first, sequence: 2 }, true), /order/);
  assert.throws(() => f.ledger.streamChunk(j.id, { ...first, output: "changed" }, true), /Signature/);
  assert.throws(() => f.ledger.streamChunk(j.id, first, false), /rejected/);
  assert.equal(f.ledger.balance(f.owner).spent, "0");
  const saved = f.ledger.streamChunk(j.id, first, true);
  assert.throws(() => f.ledger.streamChunk(j.id, { ...first, sequence: 2, output: "other" }, true), /prefix/);
  assert.equal(f.ledger.balance(f.owner).spent, saved.receipt.usage.amount);
});
test("final streamed answer and repeated completion never re-debit a delivered prefix", async t => {
  const f = fixture(t); f.purchase(); const j = f.ledger.reserve({ ...f.request("done-stream"), stream: true }), job = f.ledger.dispatch(j.id, f.provider);
  const first = f.ledger.streamChunk(j.id, await prefix(f, job, "Hello", 1), true);
  const final = { output: "Hello there", signature: Buffer.from(await f.worker.signHash(F.fundedResultHash(f.target, job, "Hello there"))).toString("base64") };
  const done = f.ledger.complete(j.id, final, true); f.ledger.complete(j.id, final, true);
  assert.ok(BigInt(done.receipt.usage.amount) > BigInt(first.receipt.usage.amount));
  assert.equal(f.ledger.balance(f.owner).spent, done.receipt.usage.amount); assert.equal(f.ledger.balance(f.owner).held, "0");
});
