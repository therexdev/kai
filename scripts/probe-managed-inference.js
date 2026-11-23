"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Signer } = require("koilib");
const P = require("../lib/koin-network/job-protocol"), { Meter } = require("../lib/koin-network/metering");
const M = require("../lib/koin-network/managed-protocol"), { ManagedProvider, ManagedMeter, secret } = require("../lib/koin-network/managed-provider");
const { fixture } = require("./helpers/koin-prepaid-fixture");
const { verifyAnswer: verifyManagedAnswer } = M;
const signer = Signer.fromSeed("managed-inference-test-verifier"), verifier = signer.getAddress();
const identity = { accountId: P.hash("managed-customer"), origin: P.hash("managed-origin") };
const freePolicy = { version: 1, accountDaily: "100000000", networkDaily: "300000000", originDaily: "200000000", accountConcurrent: 4, eligibleModels: M.models.map(m => m.model) };
function setup(t, overrides = {}) {
  const f = fixture(t, { product: "prepaid-usd-v1", meter: new ManagedMeter(new Meter()), managedVerifier: verifier, freePolicy, ...overrides });
  const model = M.models[0], messages = [{ role: "user", content: "Hello" }];
  const request = name => ({ ...f.request(name), identity, model: model.model, messages, maxOutput: 1024 });
  const rows = M.models.map(m => ({ id: m.upstream, pricing: { input: Number(m.input) / 1e14, output: Number(m.output) / 1e14, input_cache_read: Number(m.cache) / 1e14, request: "0" } }));
  let posts = 0;
  const provider = new ManagedProvider({ key: "test-api-key-never-log", verifier, signer, domain: f.target.domain, clock: f.options.clock,
    fetchImpl: async (url, opts) => {
      if (url.endsWith("/models")) return Response.json({ data: rows });
      posts++; const request = JSON.parse(opts.body);
      assert.equal(request.model, model.upstream); assert.equal(request.max_completion_tokens, 1024);
      return Response.json({ id: "upstream-test", choices: [{ message: { content: "Hello from the network" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 20 } } }, { headers: { "Inference-Id": "test-inference" } });
    } });
  t.after(() => provider.close());
  return { f, provider, request, model, messages, rows, posts: () => posts };
}
test("all six customer tariffs use precisely 25% or 15% markup", () => {
  const expected = [ ["4625000", "23375000"], ["25000000", "65000000"], ["28125000", "247500000"], ["23750000", "550000000"], ["11500000", "103500000"], ["201250000", "1150000000"] ];
  M.models.forEach((m, i) => { const t = M.tariff(m.model); assert.deepEqual([t.inputAtomsPerMillion, t.outputAtomsPerMillion], expected[i]); });
});
test("cached input and supplier discounts receive the same markup with one final ceiling", () => {
  const m = M.models[2], rates = { input: m.input, output: m.output, cache: m.cache, discountBps: 2000 };
  assert.equal(M.amount(m.model, 1000, 500, 800, rates), "107500");
  assert.throws(() => M.rates(m.model, { ...rates, input: String(BigInt(m.input) + 1n) }), /exceeds/);
  assert.throws(() => M.amount(m.model, 1, 1, 2, rates));
});
test("free-only usage debits the shared daily balance once, survives restart, and earns no KOIN", async t => {
  const { f, provider, request } = setup(t); await provider.refresh();
  const j = f.ledger.reserve({ ...request("free-only"), freeOnly: true });
  assert.equal(j.funding.paidHold, "0");
  assert.throws(() => f.ledger.dispatch(j.id, f.provider), /unavailable/);
  await provider.execute(f.ledger, j.id, request("free-only").messages);
  const ready = f.ledger.job(j.id), charged = f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(charged.settlement.state, "not_required"); assert.equal(charged.managed.rewardsEligible, false);
  assert.equal(f.ledger.rewardEligible(charged, verifier), false);
  assert.deepEqual(f.ledger.pendingJobs(), []); assert.deepEqual(f.ledger.pendingSponsorship(), []); assert.deepEqual(f.ledger.settledJobs(), []);
  assert.equal(f.ledger.balance(f.owner).spent, "0");
  const left = f.ledger.creditView(f.owner, identity, j.quote.tariff.model).free.available;
  assert.equal(BigInt(left), 100000000n - BigInt(charged.receipt.usage.amount));
  f.restart(); f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(f.ledger.creditView(f.owner, identity, j.quote.tariff.model).free.available, left);
  f.time(86400000); assert.equal(f.ledger.creditView(f.owner, identity, j.quote.tariff.model).free.available, "100000000");
});
test("paid-first uses the existing purchased ledger and recovery never repeats an upstream POST", async t => {
  const { f, provider, request, posts } = setup(t); f.purchase("paid", "100000000"); await provider.refresh();
  const j = f.ledger.reserve({ ...request("paid-once"), paidFirst: true }); await provider.execute(f.ledger, j.id, request("paid-once").messages);
  const ready = f.ledger.job(j.id); f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  f.restart(); await assert.rejects(provider.execute(f.ledger, j.id, request("paid-once").messages));
  f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  assert.equal(posts(), 1); assert.equal(f.ledger.balance(f.owner).spent, ready.receipt.usage.amount);
  assert.equal(f.ledger.creditView(f.owner, identity, j.quote.tariff.model).free.available, "100000000");
});
test("stale health, missing models and price increases hide endpoints instead of inventing availability", async t => {
  const { f, provider, rows } = setup(t); await provider.refresh(); assert.equal(provider.snapshot().models.filter(m => m.ready).length, 6);
  f.time(60001); assert.equal(provider.snapshot().ready, false);
  rows[0].pricing.output = 1; rows.splice(1, 1); await provider.refresh();
  assert.equal(provider.ready(M.models[0].model), false); assert.equal(provider.ready(M.models[1].model), false);
  assert.equal(provider.snapshot().models.filter(m => m.ready).length, 4);
});
test("a supplier without prompt-cache pricing remains usable at its normal input rate", async t => {
  const { provider, rows } = setup(t);
  rows.forEach(row => { delete row.pricing.input_cache_read; }); await provider.refresh();
  assert.equal(provider.snapshot().models.filter(m => m.ready).length, 6);
  const m = M.models[2], r = provider.available.get(m.model); assert.equal(r.cache, r.input);
});
test("network and negotiated catalogs agree while the supplier key is absent and add exactly one healthy provider", async t => {
  const f = fixture(t), { provider } = setup(t), meter = new ManagedMeter(f.meter);
  const runtime = { clock: f.options.clock, config: { models: [{ tariff: f.tariff }], freePolicy }, meter,
    scheduler: { workers: new Map(), koinPrepaid: { ledger: f.ledger } } };
  const read = () => require("../lib/koin-network/network-overview").networkOverview(runtime);
  const options = { meter, target: f.target, networkOverview: read, clock: f.options.clock, managedPolicyHash: M.policyHash };
  let n = read(), c = require("../lib/koin-network/model-catalog").modelCatalog(options);
  assert.equal(n.models.length, 7); assert.equal(c.models.length, 7); assert.equal(n.readyProviders, 0);
  assert.ok(c.models.every(row => n.models.some(m => m.id === row.model)));
  runtime.managed = provider; await provider.refresh(); n = read(); c = require("../lib/koin-network/model-catalog").modelCatalog(options);
  assert.equal(n.readyProviders, 1); assert.equal(n.providers.length, 1); assert.equal(c.models.filter(m => m.available).length, 6);
  assert.equal(runtime.scheduler.workers.size, 0); assert.equal(f.ledger.jobs().length, 0);
});
test("missing usage, supplier errors and cancellation release holds without a charge", async t => {
  for (const mode of ["missing-usage", "insufficient", "abort"]) {
    const { f, provider, request } = setup(t); await provider.refresh();
    provider.fetch = async (url, opts) => {
      if (mode === "abort") { queueMicrotask(() => provider.cancel(P.hash(mode))); await new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true })); }
      if (mode === "insufficient") return new Response("do not leak test-api-key-never-log", { status: 402 });
      return Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
    };
    const j = f.ledger.reserve(request(mode)); await assert.rejects(provider.execute(f.ledger, j.id, request(mode).messages), /No credits were charged/);
    assert.equal(f.ledger.job(j.id).state, "cancelled"); assert.equal(f.ledger.creditView(f.owner, identity, j.quote.tariff.model).free.available, "100000000");
    assert.equal(f.ledger.balance(f.owner).spent, "0");
    if (mode === "insufficient") assert.equal(provider.snapshot().ready, false);
  }
});
test("a single managed provider is counted once across six models and stays out of the worker registry", async t => {
  const { provider } = setup(t); const base = { workersOnline: 2, models: [{ model: "native", providers: 2 }], workers: [] };
  const { withManagedStatus } = require("../lib/koin-network/managed-public-status");
  assert.equal(withManagedStatus(base, provider), base); await provider.refresh();
  const view = withManagedStatus(base, provider); assert.equal(view.workersOnline, 3); assert.equal(view.workers.length, 1); assert.equal(view.models.length, 7);
  assert.equal(base.workersOnline, 2); assert.deepEqual(base.workers, []);
  for (const row of view.models.filter(m => m.model !== "native")) assert.equal(row.providers, 1);
});
test("managed quotes and receipts verify in desktop, and tampered usage or signatures fail", async t => {
  const { f, provider, request } = setup(t); await provider.refresh(); const input = request("desktop");
  const j = f.ledger.reserve(input); await provider.execute(f.ledger, j.id, input.messages);
  const ready = f.ledger.job(j.id), charged = f.ledger.acknowledge(j.id, f.owner, ready.receiptHash), r = charged.receipt;
  const result = { id: j.id, choices: [{ message: { content: f.ledger.decrypt(j.id, charged.answer) } }],
    usage: { prompt_tokens: r.usage.inputTokens, completion_tokens: r.usage.outputTokens, total_tokens: r.usage.inputTokens + r.usage.outputTokens }, costUsd: Number(r.usage.amount) / 1e8,
    koin: { product: f.ledger.product, state: charged.state, target: f.ledger.jobTarget(charged), session: charged.session, quote: charged.quote, receipt: r, receiptHash: charged.receiptHash } };
  const config = { owner: f.owner, deployment: { product: f.ledger.product, verifier } }, selected = { model: input.model, messages: input.messages, maxOutput: input.maxOutput };
  assert.equal(verifyManagedAnswer(result, selected, j.id, config, f.target, f.options.clock()).choices[0].message.content, "Hello from the network");
  const bad = structuredClone(result); bad.koin.receipt.usage.amount = "1"; bad.koin.receiptHash = P.hash(JSON.stringify(bad.koin.receipt));
  assert.throws(() => verifyManagedAnswer(bad, selected, j.id, config, f.target, f.options.clock()));
  const forged = structuredClone(result); forged.koin.receipt.signature = Buffer.alloc(65).toString("base64"); forged.koin.receiptHash = P.hash(JSON.stringify(forged.koin.receipt));
  assert.throws(() => verifyManagedAnswer(forged, selected, j.id, config, f.target, f.options.clock()));
});
test("credentials are server-only, protected and never serialized", t => {
  assert.equal(secret({}), undefined); assert.throws(() => secret({ KAI_AKASHML_API_KEY: "too-short" }));
  const { provider } = setup(t); assert.equal(JSON.stringify(provider).includes("test-api-key-never-log"), false);
});
