"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), http = require("node:http"), express = require("express");
const { Signer } = require("koilib"), { fixture } = require("./helpers/koin-prepaid-fixture");
const P = require("../lib/koin-network/job-protocol"), F = require("../lib/koin-network/funded-protocol"), { challengeHash } = require("../lib/wallet-credit-auth");

async function service(t) {
  const f = fixture(t), auth = require("../lib/accounts").createAccounts({ stateDir: path.join(f.dir, "identity"), siteOrigin: "https://credits.fixture.invalid" });
  auth.service.configureWalletCredits({ target: f.target, schedulerUrl: "https://credits.fixture.invalid/scheduler", clock: f.options.clock });
  const address = name => Signer.fromSeed("wallet-router-" + name).getAddress(), quotes = [];
  const client = new (require("../lib/koin-network/chain").KoinChain)({ schema: 1, network: "mainnet", product: "prepaid-usd-v1", chainId: f.target.chainId,
    decimals: 8, rpc: ["https://fixture.invalid"], token: require("../lib/koin-network/payment-network").MAINNET_TOKEN, tokenHash: "0x1220" + P.hash("token"),
    credits: f.target.credits, creditsHash: f.target.creditsHash, rewards: address("rewards"), rewardsHash: "0x1220" + P.hash("rewards"),
    admin: address("admin"), verifier: address("verifier"), mining: address("mining"), operations: address("operations"), masterNode: require("../lib/koin-network/product").MASTER_NODE }, {});
  const router = require("../lib/koin-network/prepaid-router").createPrepaidRouter({ dataDir: path.join(f.dir, "http-credit-service"), accounts: auth.service, client, ...f.options,
    publicAccounts: true, freePolicy: { version: 1, accountDaily: "1000", networkDaily: "2000", originDaily: "1500", accountConcurrent: 2, eligibleModels: ["fixture"] },
    qualify: () => true, accept: ({ output }) => !!output.trim(), purchaseQuote: async (...args) => { quotes.push(args); return { args: { account: args[0], amount: "100000000" } }; } });
  const app = express(); app.use(express.json({ limit: "32kb" })); app.use(auth.router);
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/auth/") || req.url.startsWith("/account/")) return app(req, res);
    if (req.url === "/consume/chat/completions") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      return router.work.chat(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    if (await router.handle(req, res, () => null)) return;
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); router.close(); auth.service.db.close(); });
  const base = "http://127.0.0.1:" + server.address().port;
  async function post(route, body) {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function connect(wallet, device = "one", freeOnly = false) {
    const pending = await post("/auth/wallet-credit/challenge", { address: wallet.getAddress(), deviceId: P.hash(device), freeOnly });
    assert.equal(pending.status, 200);
    const c = pending.body.challenge, signature = Buffer.from(await wallet.signHash(challengeHash(c))).toString("base64");
    return post("/auth/wallet-credit/verify", { challengeId: c.nonce, signature });
  }
  function link(account, wallet) { auth.service.db.prepare("INSERT INTO wallets(address,account_id,label,linked_at) VALUES(?,?,NULL,?)").run(wallet.getAddress(), account.id, f.options.clock()); }
  return { f, auth, router, post, connect, link, quotes, base };
}

test("wallet-only HTTP credits are scoped to the proved wallet and preserve one free allowance across devices", async t => {
  const s = await service(t), { f, router, auth } = s, buyer = f.buyer, second = Signer.fromSeed("wallet-router-second");
  const account = auth.service._newAccount({ email: "existing@example.test" }); s.link(account, buyer); s.link(account, second);
  const generic = auth.service._issueSession(account.id, "existing full account");
  assert.equal((await s.post("/koin/prepaid/status", {})).status, 401);
  assert.equal(router.ledger.db.prepare("SELECT COUNT(*) AS n FROM free_grants").get().n, 0, "anonymous visits cannot create a free grant");
  const connected = await s.connect(buyer); assert.equal(connected.status, 200);
  const sessionToken = connected.body.token, creditWallet = f.owner, request = (action, extra = {}) => s.post("/koin/prepaid/" + action, { sessionToken, creditWallet, ...extra });
  assert.equal(connected.body.account.id, account.id);
  assert.equal(router.ledger.db.prepare("SELECT COUNT(*) AS n FROM free_grants").get().n, 0, "connection establishes identity without minting a grant");
  const ownId = "0x1220" + P.hash("own-purchase"), otherId = "0x1220" + P.hash("other-purchase");
  for (const [txId, owner, amount] of [[ownId, creditWallet, "500"], [otherId, second.getAddress(), "999"]]) {
    router.ledger.queuePurchase(txId, owner); router.ledger.confirmPurchase(txId, { state: "finalized", txId, owner, amount });
  }
  const status = await request("status"); assert.equal(status.status, 200); assert.equal(status.body.balance.purchased, "500");
  assert.equal(status.body.credits.free.available, "1000"); assert.deepEqual(status.body.purchases.map(p => p.id), [ownId]);
  for (const value of [null, second.getAddress(), "invalid"]) {
    const denied = await request("status", { creditWallet: value }); assert.equal(denied.status, 400); assert.match(denied.body.error, /authorized wallet/);
  }
  const missingSelection = await s.post("/koin/prepaid/status", { sessionToken }); assert.equal(missingSelection.status, 400);
  const quote = await request("quote-usd", { dollars: "1", intentId: P.hash("buy-one") }); assert.equal(quote.status, 200);
  assert.equal(s.quotes.length, 1); assert.equal(s.quotes[0][0], creditWallet); assert.equal(s.quotes[0][3], P.hash("verified-account:" + account.id));
  assert.equal((await request("quote-usd", { dollars: "1", intentId: P.hash("bad-buy"), creditWallet: second.getAddress() })).status, 400);
  assert.equal(s.quotes.length, 1, "a scoped session never reaches the quote issuer for another wallet");
  const model = "fixture", messages = [{ role: "user", content: "hello" }], estimate = await request("estimate", { model, messages, max_tokens: 16, freeOnly: true });
  assert.equal(estimate.status, 200); assert.equal(estimate.body.estimate.allowed, true); assert.equal(estimate.body.estimate.maxPaid, "0");
  // Preserve the old account's grant identity and independently owned balances.
  const identity = { accountId: P.hash("verified-account:" + account.id), origin: P.hash("origin:127.0.0.1") }, ownJob = P.hash("own-reply");
  router.ledger.reserve({ id: ownJob, owner: creditWallet, identity, ownership: { accountId: account.id, wallets: [creditWallet, second.getAddress()] }, model, version: 1, messages, maxOutput: 16 });
  const job = router.ledger.dispatch(ownJob, f.provider), output = "answer";
  router.ledger.complete(ownJob, { output, signature: Buffer.from(await f.worker.signHash(F.fundedResultHash(f.target, job, output))).toString("base64") }, true);
  const answer = await request("result", { requestId: ownJob }); assert.equal(answer.status, 200); assert.equal(answer.body.completion.choices[0].message.content, output);
  const after = await request("status"); assert.ok(BigInt(after.body.credits.free.available) < 1000n);
  const again = await s.connect(buyer, "two"); assert.equal(again.body.account.id, account.id);
  const otherDevice = await request("status", { sessionToken: again.body.token }); assert.equal(otherDevice.body.credits.free.available, after.body.credits.free.available);
  assert.equal(router.ledger.db.prepare("SELECT COUNT(*) AS n FROM free_grants").get().n, 1);
  const fullOther = await s.post("/koin/prepaid/status", { sessionToken: generic, creditWallet: second.getAddress() });
  assert.equal(fullOther.body.balance.purchased, "999"); assert.equal(fullOther.body.credits.free.available, after.body.credits.free.available);
});

test("wallet-scoped HTTP sessions cannot read or stop same-account jobs and runs paid by another wallet", async t => {
  const s = await service(t), { f, auth, router } = s, second = Signer.fromSeed("wallet-router-other-buyer");
  const account = auth.service._newAccount({ email: "multiple@example.test" }); s.link(account, f.buyer); s.link(account, second);
  const connected = await s.connect(f.buyer), sessionToken = connected.body.token, creditWallet = f.owner;
  const request = (action, extra = {}) => s.post("/koin/prepaid/" + action, { sessionToken, creditWallet, ...extra });
  const identity = { accountId: P.hash("verified-account:" + account.id), origin: P.hash("origin:127.0.0.1") }, runId = P.hash("other-wallet-run"), id = P.hash("other-wallet-job");
  router.ledger.runs.open({ id: runId, owner: second.getAddress(), identity, model: "fixture", mode: "research", maxTotal: "1000", freeOnly: true });
  router.ledger.reserve({ id, owner: second.getAddress(), identity, ownership: { accountId: account.id, wallets: [creditWallet, second.getAddress()] }, runId,
    model: "fixture", version: 1, messages: [{ role: "user", content: "private other-wallet prompt" }], maxOutput: 16, freeOnly: true });
  for (const action of ["result", "cancel", "acknowledge"]) {
    const denied = await request(action, { requestId: id, ...(action === "acknowledge" ? { receiptHash: P.hash("not-used") } : {}) });
    assert.equal(denied.status, 400); assert.match(denied.body.error, /another wallet/);
  }
  for (const action of ["run-status", "run-stop"]) {
    const denied = await request(action, { runId }); assert.equal(denied.status, 400); assert.match(denied.body.error, /another wallet/);
  }
  assert.equal(router.ledger.job(id).state, "queued"); assert.equal(router.ledger.runs.get(runId, identity).state, "open");
  auth.service.unlinkWallet(account, creditWallet);
  assert.equal((await request("status")).status, 401);
  const reconnect = await s.connect(f.buyer, "after-unlink"); assert.equal(reconnect.status, 409); assert.match(reconnect.body.error, /account link changed/);
  assert.equal(auth.service.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1, "unlink cannot silently create another credit identity");
});

test("free-only wallet sessions cannot quote, purchase, reserve paid budgets or debit purchased credits", async t => {
  const s = await service(t), { f, router } = s;
  const connected = await s.connect(f.buyer, "pi-session", true); assert.equal(connected.status, 200); assert.equal(connected.body.freeOnly, true);
  const sessionToken = connected.body.token, creditWallet = f.owner;
  const request = (action, extra = {}) => s.post("/koin/prepaid/" + action, { sessionToken, creditWallet, ...extra });
  const txId = "0x1220" + P.hash("saved-purchased-balance"); router.ledger.queuePurchase(txId, creditWallet);
  router.ledger.confirmPurchase(txId, { state: "finalized", txId, owner: creditWallet, amount: "500" });
  for (const [action, body] of [["quote-usd", { dollars: "1", intentId: P.hash("quote") }], ["quote", { amount: "100000000", intentId: P.hash("quote-koin") }], ["purchase", { txId }]]) {
    const denied = await request(action, body); assert.equal(denied.status, 400); assert.match(denied.body.error, /free.*only/i);
  }
  assert.equal(s.quotes.length, 0);
  const model = "fixture", messages = [{ role: "user", content: "free question" }], terms = { model, messages, max_tokens: 16 };
  for (const extra of [{ freeOnly: false }, { freeOnly: true, paidFirst: true }]) {
    const denied = await request("estimate", { ...terms, ...extra }); assert.equal(denied.status, 400); assert.match(denied.body.error, /free.*only/i);
    const run = await request("run-open", { model, runId: P.hash(JSON.stringify(extra)), mode: "research", maxTotal: "1000", ...extra });
    assert.equal(run.status, 400); assert.match(run.body.error, /free.*only/i);
  }
  const base = { sessionToken, creditWallet, billing: "koin-prepaid-usd-v1", ...terms, requestId: P.hash("free-answer"), freeOnly: true, maxPaid: "0" };
  for (const extra of [{ freeOnly: false }, { paidFirst: true }, { maxPaid: "1" }]) {
    const denied = await s.post("/consume/chat/completions", { ...base, ...extra }); assert.equal(denied.status, 400); assert.match(denied.body.error, /free.*only/i);
  }
  assert.equal(router.ledger.jobs().length, 0, "denied requests do not reserve either credit balance");
  const estimate = await request("estimate", { ...terms, freeOnly: true }); assert.equal(estimate.status, 200); assert.equal(estimate.body.estimate.maxPaid, "0");
  const answer = s.post("/consume/chat/completions", base);
  for (let i = 0; i < 100 && !router.ledger.job(base.requestId); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const wire = require("../lib/koin-network/payment-network").protocol(f.target), worker = { address: f.provider, proof: "signed", models: [model], capabilities: { [wire.capability]: 1 } };
  const job = await router.work.next(worker); assert.equal(job.id, base.requestId);
  const output = "free answer", signature = Buffer.from(await f.worker.signHash(F.fundedResultHash(f.target, job, output))).toString("base64");
  router.ledger.complete(job.id, { output, signature }, true);
  const completed = await answer; assert.equal(completed.status, 200); assert.equal(completed.body.completion.choices[0].message.content, output);
  assert.equal(router.ledger.balance(creditWallet).available, "500"); assert.equal(router.ledger.balance(creditWallet).spent, "0");
  assert.ok(BigInt((await request("status")).body.credits.free.available) < 1000n);

  // A prior paid-capable connection may have left an undelivered paid answer.
  // Reading or acknowledging it is a debit, so a free-only token must not do it.
  const paidId = P.hash("saved-paid-answer"), identity = { accountId: P.hash("verified-account:" + connected.body.account.id), origin: P.hash("origin:127.0.0.1") };
  router.ledger.reserve({ id: paidId, owner: creditWallet, identity, ownership: { accountId: connected.body.account.id, wallets: [creditWallet] },
    model, version: 1, messages, maxOutput: 16, paidFirst: true });
  const paidJob = router.ledger.dispatch(paidId, f.provider), paidOutput = "paid answer";
  const paidReady = router.ledger.complete(paidId, { output: paidOutput, signature: Buffer.from(await f.worker.signHash(F.fundedResultHash(f.target, paidJob, paidOutput))).toString("base64") }, true);
  for (const action of ["result", "acknowledge"]) {
    const denied = await request(action, { requestId: paidId, ...(action === "acknowledge" ? { receiptHash: paidReady.receiptHash } : {}) });
    assert.equal(denied.status, 400); assert.match(denied.body.error, /free.*only/i);
  }
  const retry = await s.post("/consume/chat/completions", { ...base, requestId: paidId });
  assert.equal(retry.status, 400); assert.match(retry.body.error, /free.*only/i);
  assert.equal(router.ledger.job(paidId).state, "ready"); assert.equal(router.ledger.balance(creditWallet).spent, "0");
  assert.equal((await request("cancel", { requestId: paidId })).status, 200, "free-only session may release an unpaid hold");
  assert.equal(router.ledger.balance(creditWallet).available, "500");
  const chargedId = P.hash("already-paid-answer");
  router.ledger.reserve({ id: chargedId, owner: creditWallet, identity, ownership: { accountId: connected.body.account.id, wallets: [creditWallet] },
    model, version: 1, messages, maxOutput: 16, paidFirst: true });
  const chargedJob = router.ledger.dispatch(chargedId, f.provider);
  const chargedReady = router.ledger.complete(chargedId, { output: paidOutput, signature: Buffer.from(await f.worker.signHash(F.fundedResultHash(f.target, chargedJob, paidOutput))).toString("base64") }, true);
  router.ledger.acknowledge(chargedId, creditWallet, chargedReady.receiptHash); // prior paid-capable client completed its debit
  const spent = router.ledger.balance(creditWallet).spent; assert.ok(BigInt(spent) > 0n);
  const alreadyPaid = await request("result", { requestId: chargedId });
  assert.equal(alreadyPaid.status, 200); assert.equal(alreadyPaid.body.completion.choices[0].message.content, paidOutput);
  assert.equal(router.ledger.balance(creditWallet).spent, spent, "recovery of an already paid answer cannot create another debit");
});
