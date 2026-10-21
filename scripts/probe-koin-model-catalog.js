"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("path");
const { Meter, price } = require("../lib/koin-network/metering"), P = require("../lib/koin-network/job-protocol");
const Models = require("../lib/koin-network/model-configuration"), { modelCatalog } = require("../lib/koin-network/model-catalog");
const { fixture } = require("./helpers/koin-prepaid-fixture");
const manifest = require("../lib/koin-network/tokenizers/qwen25-1.5b.json");
const entry = (model, input = "1000000", output = "4000000") => {
  const tokenizer = { ...manifest, model }, tariff = { model, version: 1, modelHash: tokenizer.modelHash,
    tokenizerHash: tokenizer.tokenizerHash, templateHash: tokenizer.templateHash, inputAtomsPerMillion: input,
    outputAtomsPerMillion: output, contextTokens: 4096, maxOutputTokens: 64, maxLatencyMs: 5000 };
  return { tokenizer, tariff };
};
const meterFor = values => new Meter(values.map(({ tariff }) => ({ tariff, adapter: { ...tariff,
  input: messages => Buffer.byteLength(JSON.stringify(messages)), output: s => Buffer.byteLength(s),
  render: JSON.stringify, encode: s => [...Buffer.from(s)] } })));

test("full catalog commitment is order-independent and rejects ambiguity, mixed versions and changed package pins", () => {
  const models = [entry("fixture"), entry("Z-fixture", "8000000", "32000000")], config = { schema: 2, version: 1, models };
  assert.equal(Models.policyHash(config), meterFor(models).policyHash);
  assert.equal(Models.policyHash({ ...config, models: [...models].reverse() }), Models.policyHash(config));
  for (const change of [c => c.models.push(c.models[0]), c => c.tariff = models[0].tariff,
    c => c.models[1].tariff.version = 2, c => c.models[1].tokenizer.modelHash = P.hash("other model"),
    c => c.models[1].tariff.model = "../other", c => c.models[1].tariff.outputAtomsPerMillion = "0"]) {
    const bad = structuredClone(config); change(bad); assert.throws(() => Models.entries(bad));
  }
  assert.equal(Models.policyHash({ schema: 1, version: 1, ...models[0] }), meterFor([models[0]]).policyHash);
});

test("catalog prices remain bound to policy while expired readiness cannot advertise availability", () => {
  const meter = meterFor([entry("fixture"), entry("premium", "8000000", "32000000")]), target = { policyHash: meter.policyHash };
  const now = 1790000000000, network = { observedAt: now, validUntil: now + 9000,
    models: [{ id: "fixture", available: true, providers: 2, freeEligible: true }, { id: "premium", available: false, providers: 0 }] };
  const options = { meter, target, clock: () => now, networkOverview: () => network };
  const c = modelCatalog(options); assert.equal(c.models.length, 2); assert.equal(c.validUntil, now + 9000);
  assert.deepEqual(c.models.map(m => [m.model, m.available, m.inputCreditsPerMillion, m.outputCreditsPerMillion]), [["fixture", true, "10", "40"], ["premium", false, "80", "320"]]);
  network.validUntil = now; assert.ok(modelCatalog(options).models.every(m => !m.available));
  network.validUntil = now + 15001; assert.ok(modelCatalog(options).models.every(m => !m.available));
  assert.throws(() => modelCatalog({ ...options, target: { policyHash: P.hash("wrong") } }), /authorized/);
});

test("two models use distinct rates against one balance, free eligibility and exact request recovery survive restart", async t => {
  const meter = meterFor([entry("fixture"), entry("premium", "8000000", "32000000")]);
  const f = fixture(t, { meter, product: "prepaid-usd-v1", freePolicy: { version: 1, accountDaily: "25", originDaily: "100", networkDaily: "200", accountConcurrent: 2, eligibleModels: ["fixture"] } });
  const identity = { accountId: P.hash("multi-buyer"), origin: P.hash("multi-origin") };
  f.purchase("multi", "10000"); let paid = 0n;
  for (const model of ["fixture", "premium"]) {
    const request = { ...f.request(model), model, identity }, job = f.ledger.reserve(request);
    assert.equal(job.funding.freeHold, model === "fixture" ? "25" : "0");
    assert.throws(() => f.ledger.reserve({ ...request, model: model === "fixture" ? "premium" : "fixture" }), /another message/);
    const ready = await f.complete(job.id, "PONG"); f.ledger.acknowledge(job.id, f.owner, ready.receiptHash);
    const exact = price(meter.entry(model, 1).tariff, Buffer.byteLength(JSON.stringify(request.messages)), 4);
    assert.equal(ready.receipt.usage.amount, exact); paid += BigInt(exact) - (model === "fixture" ? 25n : 0n);
    f.restart(); f.ledger.acknowledge(job.id, f.owner, ready.receiptHash);
    assert.equal(f.ledger.decrypt(job.id, f.ledger.job(job.id).answer), "PONG");
    assert.equal(f.ledger.balance(f.owner).spent, String(paid));
  }
  assert.equal(f.ledger.balance(f.owner).available, String(10000n - paid));
  assert.equal(f.ledger.balance(f.owner).held, "0");
});

test("authenticated HTTP catalog and unavailable model rejection preserve balances before any job is created", async t => {
  const f = fixture(t), { KoinChain } = require("../lib/koin-network/chain"), { Scheduler } = require("../lib/scheduler"), { Signer } = require("koilib");
  const address = n => Signer.fromSeed("catalog-" + n).getAddress(), meter = meterFor([entry("fixture"), entry("premium", "8000000", "32000000")]);
  const target = { ...f.target, policyHash: meter.policyHash }, now = Date.now();
  const client = new KoinChain({ schema: 1, network: "mainnet", product: "prepaid-v1", chainId: target.chainId, decimals: 8, rpc: ["https://fixture.invalid"],
    token: require("../lib/koin-network/payment-network").MAINNET_TOKEN, credits: target.credits, creditsHash: target.creditsHash,
    rewards: address("rewards"), admin: address("admin"), verifier: address("verifier"), mining: address("mining"), operations: address("operations"),
    tokenHash: "0x1220" + P.hash("token"), rewardsHash: "0x1220" + P.hash("rewards") }, {});
  const accounts = { sessionAccount: token => token === "customer" ? { id: "customer" } : null, accountView: () => ({ wallets: [{ address: f.owner }] }) };
  const scheduler = new Scheduler({ dataDir: path.join(f.dir, "catalog-http"), accounts, koinPrepaid: { ...f.options, meter, target, client, qualify: () => true, accept: () => true,
    networkOverview: () => ({ observedAt: now, validUntil: now + 15000, models: [{ id: "fixture", providers: 1, available: true }, { id: "premium", providers: 0, available: false }] }) } });
  t.after(() => scheduler.close()); const port = await scheduler.listen(0, "127.0.0.1"), ledger = scheduler.koinPrepaid.ledger;
  const post = async (route, body = {}) => { const res = await fetch(`http://127.0.0.1:${port}` + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken: "customer", ...body }) }); return { status: res.status, body: await res.json() }; };
  const good = await post("/koin/prepaid/models"); assert.equal(good.status, 200); assert.equal(good.body.catalog.policyHash, meter.policyHash); assert.equal(good.body.catalog.tariffs.length, 2);
  assert.equal((await post("/koin/prepaid/models", { sessionToken: "stranger" })).status, 401);
  assert.equal((await post("/koin/prepaid/models", { model: "fixture" })).status, 400);
  const args = { model: "premium", messages: [{ role: "user", content: "hello" }], max_tokens: 16 };
  const unavailable = await post("/koin/prepaid/estimate", args); assert.match(unavailable.body.error, /currently unavailable/);
  const requestId = P.hash("offline-request"), response = await post("/consume/chat/completions", { ...args, requestId, billing: "koin-prepaid-v1" });
  assert.match(response.body.error, /currently unavailable/); assert.equal(ledger.job(requestId), null); assert.equal(ledger.balance(f.owner).spent, "0");
});
