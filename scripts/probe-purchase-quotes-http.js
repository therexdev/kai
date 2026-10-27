"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path"), http = require("node:http"), express = require("express");
const { Signer } = require("koilib"), { fixture } = require("./helpers/koin-prepaid-fixture");
const P = require("../lib/koin-network/job-protocol"), Q = require("../lib/koin-network/purchase-quote");
const Provenance = require("../lib/koin-network/purchase-provenance"), { MARKET } = require("../lib/koin-network/purchase-market");
const { PurchaseQuoteIssuer } = require("../lib/koin-network/purchase-quote-journal");
const { challengeHash } = require("../lib/wallet-credit-auth");

// Real authenticated HTTP routes, quote signatures and durable journals. The
// exchange price and finalized chain receipt are deterministic fixture inputs;
// this probe cannot contact a public RPC or spend a real wallet's funds.
async function service(t) {
  const f = fixture(t), clock = f.options.clock, signer = Signer.fromSeed("quote-http-verifier");
  const address = name => Signer.fromSeed("quote-http-" + name).getAddress();
  const deployment = { schema: 1, network: "mainnet", product: "prepaid-usd-v1", chainId: f.target.chainId, decimals: 8,
    rpc: ["https://fixture.invalid"], token: require("../lib/koin-network/payment-network").MAINNET_TOKEN,
    tokenHash: "0x1220" + P.hash("token"), credits: f.target.credits, creditsHash: f.target.creditsHash,
    rewards: address("rewards"), rewardsHash: "0x1220" + P.hash("rewards"), admin: address("admin"),
    verifier: signer.getAddress(), mining: address("mining"), operations: address("operations"),
    masterNode: require("../lib/koin-network/product").MASTER_NODE };
  const client = new (require("../lib/koin-network/chain").KoinChain)(deployment, {
    getTransactionsById() { throw Error("Uncontrolled chain access is forbidden"); },
  });
  const policy = { schema: 1, dailyQuoteAuthorizationUsdAtoms: "100000000", accountDailyQuoteAuthorizationUsdAtoms: "100000000" };
  const pricingPolicyHash = P.hash("quote-http-price-policy"), scope = { ...f.target, pricingPolicyHash, version: 1, budget: policy };
  const prices = { async readEvidence() {
    const price = { usdPerKoin: "25000000", expiresAt: clock() + 1000, maxPurchaseUsdAtoms: "10000000000", maxPurchaseKoinAtoms: "40000000000" };
    const summary = { schema: 1, market: { chainId: MARKET.chainId, protocol: MARKET.protocol, poolId: MARKET.poolId },
      referenceKind: "merchant-exchange-reference", usdPerKoinAtoms: price.usdPerKoin, marketObservedAt: clock() - 1000,
      expiresAt: price.expiresAt, windowSeconds: 60, anchorHash: "0x" + P.hash("fixture-anchor:" + clock()), pricingPolicyHash,
      referenceHash: P.hash("fixture-reference"), maxPurchaseUsdAtoms: price.maxPurchaseUsdAtoms, maxPurchaseKoinAtoms: price.maxPurchaseKoinAtoms };
    const evidence = { fixture: "HTTP allowance regression; not a production price", observedAt: clock(), summary };
    return { price, summary, evidence, evidenceHash: Provenance.evidence(evidence).hash };
  } };
  let auth, router, issuer, server, base;
  const confirmed = new Map();
  async function open() {
    auth = require("../lib/accounts").createAccounts({ stateDir: path.join(f.dir, "identity"), siteOrigin: "https://credits.fixture.invalid" });
    auth.service.configureWalletCredits({ target: f.target, schedulerUrl: "https://credits.fixture.invalid/scheduler", clock });
    issuer = new PurchaseQuoteIssuer({ directory: path.join(f.dir, "purchase-quotes"), deployment, signer, prices, policy, scope, version: 1, clock });
    router = require("../lib/koin-network/prepaid-router").createPrepaidRouter({ dataDir: path.join(f.dir, "http-credit-service"), accounts: auth.service, client, ...f.options,
      publicAccounts: true, qualify: () => true, accept: () => true,
      purchasePricePreview: () => require("../lib/koin-network/purchase-price").preview(prices, pricingPolicyHash, clock),
      purchaseQuote: (...args) => issuer.issue(...args) });
    router.purchases.inspect = async (id, owner) => {
      const result = confirmed.get(id);
      return result && result.owner === owner ? structuredClone(result) : { state: "pending" };
    };
    const app = express(); app.use(express.json({ limit: "32kb" })); app.use(auth.router);
    server = http.createServer(require("../test-server").createHandler({
      config: { mode: "mainnet-pilot", deployment, schedulerUrl: "https://credits.fixture.invalid/scheduler" },
      runtime: { prepaid: true, lastServing: clock(), scheduler: { handle: (req, res) => router.handle(req, res, () => null) } },
      secret: "a".repeat(64), authApp: app,
    }));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = "http://127.0.0.1:" + server.address().port;
  }
  async function close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    router.close(); issuer.close(); auth.service.db.close();
  }
  await open(); t.after(close);
  async function post(route, body) {
    const response = await fetch(base + (route.startsWith("/koin/") ? "/scheduler" : "") + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function connect(wallet, device) {
    const pending = await post("/auth/wallet-credit/challenge", { address: wallet.getAddress(), deviceId: P.hash(device), freeOnly: false });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    const c = pending.body.challenge, signature = Buffer.from(await wallet.signHash(challengeHash(c))).toString("base64");
    const result = await post("/auth/wallet-credit/verify", { challengeId: c.nonce, signature });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.token;
  }
  return { f, deployment, policy, scope, confirmed, post, connect,
    async health() { const response = await fetch(base + "/health"); assert.equal(response.status, 200); return response.json(); },
    get issuer() { return issuer; }, get router() { return router; },
    async restart() { await close(); await open(); } };
}

test("authenticated buyers can retry expired or unbought quotes beyond both old daily allowances, restart, then purchase once", async t => {
  const s = await service(t), { f } = s, sessionToken = await s.connect(f.buyer, "buyer-one");
  const request = (action, extra = {}) => s.post("/koin/prepaid/" + action, { sessionToken, creditWallet: f.owner, ...extra });
  assert.equal((await s.post("/koin/prepaid/quote-usd", { dollars: "1", intentId: P.hash("anonymous") })).status, 401);
  for (let i = 0; i < 5; i++) {
    const preview = await request("purchase-price"); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  }
  assert.equal(s.issuer.journal, null, "page estimates never issue or count signed purchase quotes");
  const abandoned = [];
  for (let i = 0; i < 16; i++) {
    const intentId = P.hash("unbought-or-canceled-" + i), quote = await request("quote-usd", { dollars: "1", intentId });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    await Q.verify(s.deployment, quote.body.args, { now: f.options.clock(), version: 1 });
    Provenance.verify(quote.body.args.purchase_quote, quote.body.priceDetails, { expectedPricingPolicyHash: s.scope.pricingPolicyHash });
    abandoned.push(quote.body.args.purchase_quote.id);
    if (i % 2 === 0) {
      const retry = await request("quote-usd", { dollars: "1", intentId });
      assert.deepEqual(retry.body.args, quote.body.args, "unchanged unexpired retry returns the saved signature");
    }
    f.time(1001); // Every issued offer expires without any payment transaction.
  }
  assert.equal(new Set(abandoned).size, 16);
  let status = await request("status"); assert.equal(status.status, 200);
  assert.equal(status.body.balance.purchased, "0"); assert.deepEqual(status.body.purchases, []);
  assert.equal(s.issuer.journal.db.prepare("SELECT COUNT(*) AS n FROM quotes").get().n, 16);
  const history = s.issuer.journal.db.prepare("SELECT id, signed FROM quotes ORDER BY id").all();
  // Emulate the preserved counters in an upgraded journal whose old allowance
  // was already fully used. These are historical records, not sales/credits.
  const day = Math.floor(f.options.clock() / 86400000), accountKey = JSON.parse(s.issuer.journal.db.prepare("SELECT intent FROM quotes LIMIT 1").get().intent).accountKey;
  s.issuer.journal.guard.write(s.issuer.journal.db, () => {
    s.issuer.journal.db.prepare("INSERT INTO days VALUES(?,?)").run(day, s.policy.dailyQuoteAuthorizationUsdAtoms);
    s.issuer.journal.db.prepare("INSERT INTO account_days VALUES(?,?,?)").run(day, accountKey, s.policy.accountDailyQuoteAuthorizationUsdAtoms);
  });
  await s.restart();
  status = await request("status"); assert.equal(status.status, 200, "same saved wallet session survives restart");
  assert.equal(status.body.balance.purchased, "0"); assert.deepEqual(status.body.purchases, []);
  const fresh = await request("quote-usd", { dollars: "1", intentId: P.hash("actually-buy") });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(s.issuer.journal.db.prepare("SELECT authorized FROM days WHERE day=?").get(day).authorized, "100000000", "legacy daily history is preserved, not reset or charged");
  assert.deepEqual(s.issuer.journal.db.prepare("SELECT id, signed FROM quotes WHERE id<>? ORDER BY id").all(fresh.body.args.purchase_quote.id), history,
    "unlocking purchases retains every earlier signed offer");
  const quote = await Q.verify(s.deployment, fresh.body.args, { now: f.options.clock(), version: 1 });
  const id = "0x1220" + P.hash("only-finalized-payment");
  s.confirmed.set(id, { state: "finalized", txId: id, owner: f.owner, amount: quote.credits, height: "100", blockId: "0x1220" + P.hash("fixture-final-block") });
  const purchase = await request("purchase", { txId: id }); assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  assert.equal(purchase.body.purchase.state, "confirmed");
  await s.restart();
  const repeat = await request("purchase", { txId: id }); assert.equal(repeat.status, 200);
  status = await request("status"); assert.equal(status.body.balance.purchased, "100000000");
  assert.equal(status.body.purchases.length, 1); assert.equal(status.body.purchases[0].id, id);
  const otherBuyer = Signer.fromSeed("quote-http-second-buyer"), otherToken = await s.connect(otherBuyer, "buyer-two");
  const another = await s.post("/koin/prepaid/quote-usd", { sessionToken: otherToken, creditWallet: otherBuyer.getAddress(), dollars: "1", intentId: P.hash("second-buyer") });
  assert.equal(another.status, 200, "one buyer's unused quotes cannot block another buyer's purchase");
});

test("the installed public USD health route advertises removal of daily quote allowances", async t => {
  const s = await service(t), health = await s.health();
  assert.equal(health.product, "prepaid-usd-v1");
  assert.equal(health.purchaseQuotesUnlimited, true);
  assert.equal(health.mainnetPaymentsEnabled, true);
});
