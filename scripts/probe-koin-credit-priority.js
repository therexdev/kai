"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol"), F = require("../lib/koin-network/funded-protocol");
const freePolicy = { version: 1, accountDaily: "100", networkDaily: "1000", originDaily: "1000", accountConcurrent: 4, eligibleModels: ["fixture"] };
const identity = { accountId: P.hash("credit-priority-account"), origin: P.hash("credit-priority-origin") };
const setup = (t, policy = {}) => fixture(t, { product: "prepaid-usd-v1", freePolicy: { ...freePolicy, ...policy } });
const request = (f, name, changes = {}) => ({ ...f.request(name), identity, ...changes });
async function prefix(f, job, output, sequence) {
  return { output, sequence, signature: Buffer.from(await f.worker.signHash(F.fundedChunkHash(f.target, job, output, sequence))).toString("base64") };
}

test("default and explicit false retain the original request hash and free-first debit", async t => {
  const f = setup(t); f.purchase(); const req = request(f, "legacy-default"), j = f.ledger.reserve(req);
  const legacyHash = P.hash(JSON.stringify({ model: req.model, version: req.version, messages: P.messages(req.messages), maxOutput: req.maxOutput, accountId: identity.accountId, freeOnly: false }));
  assert.equal(j.requestHash, legacyHash); assert.equal(j.funding.paidHold, "0"); assert.equal(Object.hasOwn(j.funding, "paidFirst"), false);
  assert.deepEqual(f.ledger.reserve({ ...req, paidFirst: false }), j);
  const ready = await f.complete(j.id), charged = f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(charged.funding.freeUsed, ready.receipt.usage.amount); assert.equal(charged.funding.paidUsed, "0");
});

test("paid-first final answer uses purchased credits before free and charges once after restart", async t => {
  const f = setup(t); f.purchase(); const req = request(f, "paid-first", { paidFirst: true }), j = f.ledger.reserve(req);
  assert.equal(j.funding.paidHold, j.quote.maxCharge); assert.equal(j.funding.freeHold, "0");
  assert.throws(() => f.ledger.reserve({ ...req, paidFirst: false }), /another message/);
  const ready = await f.complete(j.id), charged = f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(charged.funding.paidUsed, ready.receipt.usage.amount); assert.equal(charged.funding.freeUsed, "0");
  assert.equal(f.ledger.creditView(f.owner, identity).free.available, "100"); assert.equal(f.ledger.pendingSponsorship().length, 0);
  f.restart(); f.ledger.acknowledge(j.id, f.owner, ready.receiptHash); f.ledger.reserve(req);
  assert.equal(f.ledger.balance(f.owner).spent, ready.receipt.usage.amount); assert.equal(f.ledger.decrypt(j.id, f.ledger.job(j.id).answer), "Private answer");
});

test("paid-first exhausts its reserved paid balance then consumes free remainder in signed streams", async t => {
  const f = setup(t); f.purchase("small", "50"); const req = request(f, "mixed-stream", { paidFirst: true, stream: true, maxPaid: "50" });
  const j = f.ledger.reserve(req), job = f.ledger.dispatch(j.id, f.provider);
  assert.equal(j.funding.paidHold, "50"); assert.equal(BigInt(j.funding.freeHold), BigInt(j.quote.maxCharge) - 50n);
  const one = await prefix(f, job, "Hi", 1), two = await prefix(f, job, "Hi there friend", 2);
  const a = f.ledger.streamChunk(j.id, one, true);
  assert.equal(a.funding.freeUsed, "0"); assert.equal(a.funding.paidUsed, a.receipt.usage.amount);
  f.ledger.streamChunk(j.id, one, true);
  const b = f.ledger.streamChunk(j.id, two, true); assert.equal(b.funding.paidUsed, "50");
  assert.equal(BigInt(b.funding.freeUsed), BigInt(b.receipt.usage.amount) - 50n);
  f.ledger.streamChunk(j.id, two, true); f.restart();
  const recovered = f.ledger.job(j.id); assert.equal(recovered.state, "charged"); assert.equal(recovered.funding.paidUsed, "50");
  assert.equal(recovered.funding.freeUsed, b.funding.freeUsed); assert.equal(f.ledger.balance(f.owner).spent, "50");
  assert.equal(f.ledger.balance(f.owner).held, "0"); assert.equal(f.ledger.pendingSponsorship().length, 1);
  assert.equal(f.ledger.decrypt(j.id, recovered.answer), two.output);
});

test("paid-first with no purchased credits uses free; final answers release unused free holds", async t => {
  const f = setup(t); const free = f.ledger.reserve(request(f, "no-paid", { paidFirst: true, maxPaid: "0" }));
  assert.equal(free.funding.paidHold, "0"); f.ledger.cancel(free.id, f.owner);
  f.purchase("enough-for-answer", "55"); const j = f.ledger.reserve(request(f, "shorter-final", { paidFirst: true }));
  assert.ok(BigInt(j.funding.freeHold) > 0n);
  const ready = await f.complete(j.id, "Hi"); assert.equal(ready.funding.freeHold, "0");
  const charged = f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(charged.funding.freeUsed, "0"); assert.equal(charged.funding.paidUsed, ready.receipt.usage.amount);
  assert.equal(f.ledger.creditView(f.owner, identity).free.available, "100");
});

test("paid-first cannot bypass ceilings, insufficient funds, free-only, or priority type checks", t => {
  const f = setup(t, { accountDaily: "10" }); f.purchase("small", "10");
  assert.throws(() => f.ledger.reserve(request(f, "insufficient", { paidFirst: true })), /Not enough credits/);
  f.purchase("more", "100");
  assert.throws(() => f.ledger.reserve(request(f, "paid-cap", { paidFirst: true, maxPaid: "10" })), /estimate changed/);
  for (const paidFirst of [null, "true", 1]) assert.throws(() => f.ledger.reserve(request(f, "bad-type", { paidFirst })), /priority/);
  assert.throws(() => f.ledger.reserve(request(f, "contradictory", { paidFirst: true, freeOnly: true })), /cannot both/);
  assert.equal(f.ledger.jobs().length, 0); assert.equal(f.ledger.balance(f.owner).spent, "0");
  const j = f.ledger.reserve(request(f, "held", { paidFirst: true }));
  assert.throws(() => f.ledger.reserve(request(f, "concurrent", { paidFirst: true })), /Not enough credits/);
  f.ledger.cancel(j.id, f.owner); assert.equal(f.ledger.balance(f.owner).available, "110");
});

test("run priority is immutable across retries and restart without changing old run terms", t => {
  const f = setup(t); f.purchase(); const terms = { id: P.hash("priority-run"), owner: f.owner, identity, model: "fixture", mode: "research", maxTotal: "200", freeOnly: false, paidFirst: true };
  assert.equal(f.ledger.runs.open(terms).paidFirst, true);
  assert.throws(() => f.ledger.runs.open({ ...terms, paidFirst: false }), /terms cannot change/);
  assert.throws(() => f.ledger.reserve(request(f, "changed-subcall", { runId: terms.id })), /preference changed/);
  const j = f.ledger.reserve(request(f, "matching-subcall", { runId: terms.id, paidFirst: true })); assert.equal(j.funding.freeHold, "0");
  f.restart(); assert.equal(f.ledger.runs.status(terms.id, identity).paidFirst, true);
  const legacy = { ...terms, id: P.hash("legacy-run"), paidFirst: false };
  assert.equal(Object.hasOwn(f.ledger.runs.open(legacy), "paidFirst"), false);
  assert.throws(() => f.ledger.reserve(request(f, "changed-legacy", { runId: legacy.id, paidFirst: true })), /preference changed/);
});

test("HTTP capability, estimates and run terms expose real priority while invalid requests create no jobs", async t => {
  const f = setup(t), { KoinChain } = require("../lib/koin-network/chain"), { Scheduler } = require("../lib/scheduler"), { Signer } = require("koilib");
  const address = n => Signer.fromSeed("credit-priority-" + n).getAddress();
  const client = new KoinChain({ schema: 1, network: "mainnet", product: "prepaid-usd-v1", chainId: f.target.chainId, decimals: 8, rpc: ["https://fixture.invalid"],
    token: require("../lib/koin-network/payment-network").MAINNET_TOKEN, credits: f.target.credits, creditsHash: f.target.creditsHash,
    rewards: address("rewards"), admin: address("admin"), verifier: address("verifier"), mining: address("mining"), operations: address("operations"),
    tokenHash: "0x1220" + P.hash("token"), rewardsHash: "0x1220" + P.hash("rewards"), masterNode: require("../lib/koin-network/product").MASTER_NODE }, {});
  const accounts = { sessionAccount: token => token === "customer" ? { id: "customer" } : null, accountView: () => ({ wallets: [{ address: f.owner }] }) };
  const summary = { schema: 1, market: { chainId: 1, protocol: "uniswap-v4", poolId: require("../lib/koin-network/purchase-market").MARKET.poolId },
    referenceKind: "merchant-exchange-reference", usdPerKoinAtoms: "2000000", marketObservedAt: Date.now(), expiresAt: Date.now() + 60000,
    windowSeconds: 60, anchorHash: "0x" + P.hash("anchor"), pricingPolicyHash: P.hash("policy"), referenceHash: P.hash("reference"),
    maxPurchaseUsdAtoms: "1000000000", maxPurchaseKoinAtoms: "50000000000" };
  let previewReads = 0, quoteCalls = 0;
  const scheduler = new Scheduler({ dataDir: path.join(f.dir, "priority-http"), accounts, koinPrepaid: { ...f.options, client, publicAccounts: true,
    purchasePricePreview: async () => { previewReads++; return summary; }, purchaseQuote: async () => { quoteCalls++; throw Error("Explicit purchase only"); }, qualify: () => true, accept: () => true } });
  t.after(() => scheduler.close()); const port = await scheduler.listen(0, "127.0.0.1"), ledger = scheduler.koinPrepaid.ledger;
  const post = async (route, body = {}) => { const res = await fetch(`http://127.0.0.1:${port}` + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken: "customer", ...body }) }); return { status: res.status, body: await res.json() }; };
  const capabilities = (await post("/koin/prepaid/capabilities")).body.capabilities;
  assert.equal(capabilities.creditPriority, true); assert.equal(capabilities.purchasePricePreview, true);
  assert.equal((await post("/koin/prepaid/purchase-price", { sessionToken: "stranger" })).status, 401);
  for (let i = 0; i < 3; i++) assert.deepEqual((await post("/koin/prepaid/purchase-price", { creditWallet: null })).body.price, summary);
  assert.equal((await post("/koin/prepaid/purchase-price", { dollars: "5" })).status, 400);
  assert.equal(previewReads, 3); assert.equal(quoteCalls, 0); assert.equal(ledger.purchases(f.owner).length, 0);
  const purchase = "0x1220" + P.hash("http-paid"); ledger.queuePurchase(purchase, f.owner); ledger.confirmPurchase(purchase, { state: "finalized", txId: purchase, owner: f.owner, amount: "30" });
  const args = { model: "fixture", messages: [{ role: "user", content: "Hi" }], max_tokens: 16 };
  const ordinary = (await post("/koin/prepaid/estimate", args)).body.estimate;
  assert.equal(ordinary.maxPaid, "0"); assert.equal(Object.hasOwn(ordinary, "paidFirst"), false);
  const preferred = (await post("/koin/prepaid/estimate", { ...args, paidFirst: true })).body.estimate;
  assert.equal(preferred.paidFirst, true); assert.equal(preferred.allowed, true); assert.equal(preferred.maxPaid, "30");
  assert.equal(BigInt(preferred.maxFree), BigInt(preferred.maxCharge) - 30n);
  const runId = P.hash("http-run"), run = await post("/koin/prepaid/run-open", { runId, model: "fixture", mode: "research", maxTotal: "100", freeOnly: false, paidFirst: true });
  assert.equal(run.status, 200); assert.equal(run.body.run.paidFirst, true);
  assert.equal((await post("/koin/prepaid/estimate", { ...args, runId })).status, 400);
  for (const extra of [{ paidFirst: null }, { paidFirst: "true" }, { paidFirst: true, freeOnly: true }]) {
    assert.equal((await post("/koin/prepaid/estimate", { ...args, ...extra })).status, 400);
    assert.equal((await post("/consume/chat/completions", { ...args, ...extra, billing: "koin-prepaid-usd-v1", requestId: P.hash(JSON.stringify(extra)) })).status, 400);
  }
  assert.equal(ledger.jobs().length, 0); assert.equal(ledger.balance(f.owner).spent, "0");
});

test("paid-first mixed final answer settles its exact paid and total usage without charging again", async t => {
  const f = setup(t); f.purchase("mixed-final", "10");
  const j = f.ledger.reserve(request(f, "mixed-final", { paidFirst: true })), ready = await f.complete(j.id);
  const consumed = f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(consumed.funding.paidUsed, "10"); assert.equal(BigInt(consumed.funding.freeUsed), BigInt(ready.receipt.usage.amount) - 10n);
  const before = f.ledger.creditView(f.owner, identity), operations = [], verifier = f.provider;
  const client = { d: { product: "prepaid-usd-v1", verifier }, verify: async () => ({ credits: { sponsor_daily_limit: "1000", sponsor_account_daily_limit: "1000" } }),
    read: async () => ({ amount: "0" }), operation: async (kind, method, args) => { const op = { kind, method, args }; operations.push(op); return op; },
    provider: { getHeadInfo: async () => ({ head_block_time: String(f.ledger.clock()), head_topology: { id: "0x1220" + P.hash("priority-head"), height: "1" } }) } };
  const signing = { reconcile: async () => {}, statusFor: () => null, status: () => [], prepare: async () => { throw Error("Captured exact settlement before signing"); } };
  const settle = new (require("../lib/koin-network/prepaid-settlement").PrepaidSettlement)({ client, ledger: f.ledger, signing, clock: f.ledger.clock,
    config: { roles: { settlement: verifier }, maxRcPerTransaction: "1", maxRcPerDay: "10" } });
  await assert.rejects(settle.tick(), /Captured exact settlement/);
  assert.equal(operations.length, 1); assert.equal(operations[0].method, "settle_credit_usage");
  assert.equal(operations[0].args.amount, "10"); assert.equal(operations[0].args.charge.amount, consumed.receipt.usage.amount);
  f.restart(); f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  const after = f.ledger.creditView(f.owner, identity);
  assert.deepEqual(after.purchased, before.purchased); assert.deepEqual(after.free, before.free);
});

// Exact deployed source, pinned in fixtures so a shallow CI checkout can test
// rollback without git history, credentials or downloading executable code.
function previousLedger() {
  const fs = require("node:fs"), Module = require("node:module"), crypto = require("node:crypto");
  const hashes = { "prepaid-ledger": "8a0a82cc4c34b91cc463ee05a7182aa7dce296b9030319baf72f9f85d7a01ce5", "credit-runs": "7e1c6b14a0935c20942cabbeb5d9618be46291da5fbba3a430d6e54e40810356" };
  function load(name, overrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, "fixtures/credit-preferences/" + name + "-cbdb3a5.js.txt"));
    assert.equal(crypto.createHash("sha256").update(source).digest("hex"), hashes[name], "The rollback source must be the exact deployed baseline");
    const filename = path.resolve(__dirname, "../lib/koin-network/" + name + ".js"), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = loaded.require.bind(loaded); loaded.require = id => overrides[id] || original(id);
    loaded._compile(source.toString("utf8"), filename); return loaded.exports;
  }
  return load("prepaid-ledger", { "./credit-runs": load("credit-runs") }).PrepaidLedger;
}
for (const state of ["queued", "ready", "stream", "charged"]) test(`previous deployed ledger safely reopens ${state} paid-first usage without restoring balances or charging twice`, async t => {
  const f = setup(t), OldLedger = previousLedger(); f.purchase("rollback-small", "50");
  const runId = P.hash("rollback-run"), terms = { id: runId, owner: f.owner, identity, model: "fixture", mode: "research", maxTotal: "200", freeOnly: false, paidFirst: true };
  f.ledger.runs.open(terms);
  const req = request(f, "rollback-" + state, { paidFirst: true, runId, ...(state === "stream" ? { stream: true } : {}) }), j = f.ledger.reserve(req);
  let before = j;
  if (["ready", "charged"].includes(state)) {
    before = await f.complete(j.id, "Hi there friend");
    if (state === "charged") before = f.ledger.acknowledge(j.id, f.owner, before.receiptHash);
  }
  if (state === "stream") {
    const job = f.ledger.dispatch(j.id, f.provider);
    before = f.ledger.streamChunk(j.id, await prefix(f, job, "Hi there friend", 1), true);
  }
  const current = f.ledger; current.close(); current.close = () => {}; // fixture cleanup owns only the now-closed new instance
  const old = new OldLedger(f.dir, f.options);
  try {
    let actual = old.job(j.id);
    assert.equal(old.runs.get(runId, identity).paidFirst, true, "saved run preference is retained even though old service cannot honor new paid-first requests");
    if (state === "ready") actual = old.acknowledge(j.id, f.owner, before.receiptHash);
    if (state === "queued") { assert.equal(actual.state, "cancelled"); assert.equal(old.balance(f.owner).spent, "0"); }
    else {
      assert.equal(actual.state, "charged"); assert.equal(actual.funding.paidUsed, "50");
      assert.equal(BigInt(actual.funding.freeUsed), BigInt(before.receipt.usage.amount) - 50n);
      old.acknowledge(j.id, f.owner, actual.receiptHash); assert.equal(old.balance(f.owner).spent, "50");
      assert.equal(old.decrypt(j.id, actual.answer), "Hi there friend");
      assert.equal(old.pendingSponsorship().length, 1);
    }
    assert.equal(old.balance(f.owner).held, "0");
  } finally { old.close(); }
});
