"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol");
const { PrepaidPurchases } = require("../lib/koin-network/prepaid-purchases"), { Signer } = require("koilib");
const tx = name => "0x1220" + P.hash(name), wallet = n => Signer.fromSeed("fair-confirmation-" + n).getAddress();
function observer(f, inspect) { return Object.assign(Object.create(PrepaidPurchases.prototype), { ledger: f.ledger, inspect }); }
test("64 unknown claims cannot starve a genuine 65th payment across ticks and restart", async t => {
  const f = fixture(t), pending = [];
  for (let w = 0; w < 8; w++) for (let n = 0; n < 8; n++) pending.push(f.ledger.queuePurchase(tx(`${w}:${n}`), wallet(w)));
  const id = tx("genuine-65"); f.ledger.queuePurchase(id, f.owner);
  const seen = [], inspect = async (id, owner) => { seen.push(id); return id === tx("genuine-65") ? { state: "finalized", txId: id, owner, amount: "123" } : { state: "pending" }; };
  await observer(f, inspect).tick(); assert.equal(seen.length, 64); f.restart();
  await observer(f, inspect).tick();
  assert.ok(seen.includes(id), "genuine payment must be inspected within two bounded batches, despite restart");
  assert.equal(f.ledger.balance(f.owner).purchased, "123");
  for (let i = 0; i < 3; i++) { f.restart(); await observer(f, inspect).tick(); }
  f.ledger.confirmPurchase(id, { state: "finalized", txId: id, owner: f.owner, amount: "123" });
  assert.equal(f.ledger.balance(f.owner).purchased, "123");
  for (const p of pending) assert.deepEqual(f.ledger.purchase(p.id, p.owner), p, "pending payment records are not expired or rewritten");
});
test("lookup outages and new arrivals cannot overtake waiting claims; rotation survives pre-inspection restart", async t => {
  const f = fixture(t), pending = [];
  for (let w = 0; w < 9; w++) for (let n = 0; n < 8; n++) pending.push(f.ledger.queuePurchase(tx(`outage-${w}:${n}`), wallet(w)));
  const old = JSON.stringify(f.ledger.purchases(wallet(0)));
  f.ledger.purchaseConfirmationBatch(); f.restart(); // crash after durable scheduling, before RPC
  const seen = []; await observer(f, async id => { seen.push(id); throw Error("RPC unavailable"); }).tick();
  assert.deepEqual(seen.slice(0, 8), pending.slice(64).map(p => p.id));
  const newest = f.ledger.queuePurchase(tx("newcomer"), wallet(10));
  const batch = f.ledger.purchaseConfirmationBatch(); assert.notEqual(batch[0].id, newest.id);
  assert.equal(JSON.stringify(f.ledger.purchases(wallet(0))), old);
});
test("old pending claims are seeded without rewriting payments; account admission spans linked wallets", t => {
  const f = fixture(t), id = tx("old pending"), p = f.ledger.queuePurchase(id, f.owner);
  f.ledger.write(() => f.ledger.db.exec("DROP TABLE purchase_confirmation_queue")); f.restart();
  assert.deepEqual(f.ledger.pendingPurchases(), [p]); assert.deepEqual(f.ledger.purchase(id, f.owner), p);
  const accountId = P.hash("one verified account");
  for (let i = 0; i < 8; i++) f.ledger.queuePurchase(tx("account-" + i), wallet(i), accountId);
  assert.throws(() => f.ledger.queuePurchase(tx("account-ninth"), wallet(9), accountId), /Account purchase.*full/);
  assert.equal(f.ledger.queuePurchase(tx("account-0"), wallet(0), accountId).state, "pending", "retries remain usable at capacity");
  f.restart(); assert.throws(() => f.ledger.queuePurchase(tx("account-ninth"), wallet(9), accountId), /Account purchase.*full/);
  f.ledger.queuePurchase(tx("unrelated-account"), wallet(9), P.hash("different verified account"));
});
test("server-verified winning purchase recovers at a full pending cap without changing old claims or crediting twice", async t => {
  const f = fixture(t), accountId = P.hash("full-cap-account"), pending = [];
  for (let i = 0; i < 8; i++) pending.push(f.ledger.queuePurchase(tx("old-candidate-" + i), f.owner, accountId));
  const winner = tx("same-nonce-winning-purchase");
  let proof = { state: "pending" };
  const register = (owner = f.owner) => observer(f, async (_id, selected) => { assert.equal(selected, owner); return proof; }).register(winner, owner, accountId);
  await assert.rejects(register(), /queue is full/);
  proof = { state: "finalized", txId: winner, owner: wallet("other"), amount: "123" };
  await assert.rejects(register(), /attribution/); assert.equal(f.ledger.balance(f.owner).purchased, "0");
  proof.owner = f.owner;
  await register(); f.restart(); await register();
  assert.equal(f.ledger.balance(f.owner).purchased, "123");
  assert.equal(f.ledger.pendingPurchases().length, 8);
  for (const p of pending) assert.deepEqual(f.ledger.purchase(p.id, p.owner), p);
  assert.equal(f.ledger.purchase(winner, f.owner).state, "confirmed");
  // A different wallet cannot turn this exact tx into another credit.
  await assert.rejects(register(wallet("other")), /attribution/);
  assert.equal(f.ledger.balance(wallet("other")).purchased, "0");
});
