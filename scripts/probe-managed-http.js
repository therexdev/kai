"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), path = require("node:path"), { Signer } = require("koilib");
const { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol"), M = require("../lib/koin-network/managed-protocol");
const { ManagedProvider, ManagedMeter } = require("../lib/koin-network/managed-provider");
test("all six models use normal authenticated HTTP credits, negotiated catalogs, signed receipts and one provider", async t => {
  const f = fixture(t), signer = Signer.fromSeed("managed-http-verifier"), verifier = signer.getAddress(), meter = new ManagedMeter(f.meter);
  let calls = 0;
  const provider = new ManagedProvider({ key: "test-managed-http-secret", signer, verifier, domain: f.target.domain, clock: f.options.clock,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/models")) return Response.json({ data: M.models.map(m => ({ id: m.upstream, pricing: { input: Number(m.input) / 1e14, output: Number(m.output) / 1e14, input_cache_read: Number(m.cache) / 1e14 } })) });
      calls++; const body = JSON.parse(options.body); assert.ok(M.models.some(m => m.upstream === body.model));
      return Response.json({ id: "hosted-" + calls, model: body.model, choices: [{ message: { content: "Verified answer " + calls }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 50 } } });
    } });
  await provider.refresh();
  const accounts = { sessionAccount: token => token === "verified-test-session" ? { id: "verified-customer" } : null,
    accountView: () => ({ wallets: [{ address: f.owner }] }) };
  const freePolicy = { version: 1, accountDaily: "100000000", networkDaily: "300000000", originDaily: "200000000", accountConcurrent: 4, eligibleModels: M.models.map(m => m.model) };
  const address = n => Signer.fromSeed("managed-http-" + n).getAddress();
  const client = new (require("../lib/koin-network/chain").KoinChain)({ schema: 1, network: "mainnet", product: "prepaid-usd-v1", chainId: f.target.chainId,
    decimals: 8, rpc: ["https://fixture.invalid"], token: require("../lib/koin-network/payment-network").MAINNET_TOKEN, tokenHash: "0x1220" + P.hash("token"),
    credits: f.target.credits, creditsHash: f.target.creditsHash, rewards: address("rewards"), rewardsHash: "0x1220" + P.hash("rewards"),
    admin: address("admin"), verifier, mining: address("mining"), operations: address("operations"), masterNode: require("../lib/koin-network/product").MASTER_NODE }, {});
  const overview = () => ({ observedAt: f.options.clock(), validUntil: f.options.clock() + 15000, state: "available", providers: [provider.snapshot()], readyProviders: 1,
    models: meter.tariffs().map(tariff => ({ id: tariff.model, available: provider.ready(tariff.model), providers: provider.ready(tariff.model) ? 1 : 0, freeEligible: !!M.find(tariff.model) })) });
  const router = require("../lib/koin-network/prepaid-router").createPrepaidRouter({ ...f.options, dataDir: path.join(f.dir, "http"),
    meter, accounts, client, publicAccounts: true, freePolicy, managed: provider, networkOverview: overview, qualify: () => false, accept: () => false });
  const server = http.createServer((req, res) => req.url === "/consume/chat/completions" ? router.work.chat(req, res, undefined) : router.handle(req, res));
  // Use the production chat router with its ordinary JSON envelope, as the
  // scheduler/test-server do after authenticating the selected credit product.
  server.removeAllListeners("request"); server.on("request", async (req, res) => {
    if (req.url !== "/consume/chat/completions") return router.handle(req, res);
    const chunks = []; for await (const part of req) chunks.push(part);
    return router.work.chat(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); router.close(); });
  const base = "http://127.0.0.1:" + server.address().port;
  const post = async (route, body = {}, headers = {}) => {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ sessionToken: "verified-test-session", ...body }) });
    return { response, value: await response.json() };
  };
  const legacy = await post("/koin/prepaid/models"); assert.equal(legacy.value.catalog.models.length, 1, "old clients keep the exact native catalog");
  const current = await post("/koin/prepaid/models", {}, { "x-kai-managed-catalog": M.policyHash });
  assert.equal(current.value.catalog.models.length, 7); assert.equal(current.value.catalog.models.filter(m => m.available).length, 6);
  const network = await post("/koin/prepaid/network"); assert.equal(network.value.network.readyProviders, 1);
  for (const m of M.models) {
    const input = { model: m.model, messages: [{ role: "user", content: "Hello" }], max_tokens: 256 }, id = P.hash("http-" + m.model);
    const estimate = await post("/koin/prepaid/estimate", { ...input, freeOnly: true }); assert.equal(estimate.value.estimate.allowed, true);
    const completion = await post("/consume/chat/completions", { ...input, billing: "koin-prepaid-usd-v1", requestId: id, freeOnly: true });
    assert.equal(completion.response.status, 200, JSON.stringify(completion.value));
    const answer = completion.value.completion;
    assert.equal(answer.koin.receipt.managed.rewardsEligible, false); assert.equal(answer.koin.receipt.usage.amount, M.amount(m.model, 100, 40, 50, { input: m.input, output: m.output, cache: m.cache, discountBps: 0 }));
    assert.equal(M.verifyAnswer(answer, { ...input, maxOutput: 256 }, id, { owner: f.owner, deployment: { product: "prepaid-usd-v1", verifier } }, router.ledger.target, f.options.clock()).servedModel, m.model);
    await post("/koin/prepaid/result", { requestId: id }); await post("/koin/prepaid/acknowledge", { requestId: id, receiptHash: answer.koin.receiptHash });
  }
  assert.equal(calls, 6); assert.deepEqual(router.ledger.pendingJobs(), []); assert.deepEqual(router.ledger.pendingSponsorship(), []);
  assert.equal(router.ledger.balance(f.owner).spent, "0");
  const denied = await post("/consume/chat/completions", { sessionToken: "wrong", billing: "koin-prepaid-usd-v1", model: M.models[0].model, messages: [{ role: "user", content: "Hello" }], max_tokens: 256, requestId: P.hash("unauthorized") });
  assert.equal(denied.response.status, 401); assert.equal(calls, 6);
});
