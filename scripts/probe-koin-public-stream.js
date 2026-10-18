"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), http = require("node:http"), express = require("express"), { Signer } = require("koilib");
const { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol"), F = require("../lib/koin-network/funded-protocol");
test("verified public signup reaches real metered HTTP streaming without a wallet and retains partial reply on Stop", async t => {
  const f = fixture(t), mails = [], auth = require("../lib/accounts").createAccounts({ stateDir: path.join(f.dir, "identity"), siteOrigin: "https://fixture.invalid", sendMail: async mail => mails.push(mail) });
  const app = express(); app.use(express.json({ limit: "32kb" })); app.use(auth.router);
  const address = n => Signer.fromSeed("public-stream-" + n).getAddress(), wire = require("../lib/koin-network/payment-network").protocol(f.target);
  const client = new (require("../lib/koin-network/chain").KoinChain)({ schema: 1, network: "mainnet", product: "prepaid-usd-v1", chainId: f.target.chainId,
    decimals: 8, rpc: ["https://fixture.invalid"], token: require("../lib/koin-network/payment-network").MAINNET_TOKEN, tokenHash: "0x1220" + P.hash("token"),
    credits: f.target.credits, creditsHash: f.target.creditsHash, rewards: address("rewards"), rewardsHash: "0x1220" + P.hash("rewards"),
    admin: address("admin"), verifier: address("verifier"), mining: address("mining"), operations: address("operations"), masterNode: require("../lib/koin-network/product").MASTER_NODE }, {});
  const worker = { address: f.provider, proof: "signed", models: ["fixture"], capabilities: { [wire.capability]: 1, koinMeteredStreaming: 1 } };
  const router = require("../lib/koin-network/prepaid-router").createPrepaidRouter({ dataDir: path.join(f.dir, "service"), accounts: auth.service, client, ...f.options,
    publicAccounts: true, freePolicy: { version: 1, accountDaily: "1000", networkDaily: "2000", originDaily: "1500", accountConcurrent: 2, eligibleModels: ["fixture"] },
    qualify: () => true, accept: ({ output }) => !!output.trim() });
  // Exercise the production scheduler's admission boundary as well as the
  // actual router, with only its unrelated worker roster supplied by fixture.
  const scheduler = Object.assign(Object.create(require("../lib/scheduler").Scheduler.prototype), { koinPrepaid: router, pending: new Map(), workers: new Map(), queue: [], _auth: () => worker });
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/auth/")) return app(req, res);
    await scheduler.handle(req, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); router.close(); auth.service.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, raw = (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await raw("/auth/email/start", { email: "new@example.com" });
  const code = mails[0].text.match(/\b(\d{6})\b/)[1], login = await raw("/auth/email/verify", { email: "new@example.com", code });
  const account = (await login.json()).account; assert.equal(account.wallets.length, 0);
  const sessionToken = /kai_session=([^;]+)/.exec(login.headers.get("set-cookie"))[1];
  const post = async (route, body = {}) => { const response = await raw(route, { sessionToken, ...body }); return { status: response.status, value: await response.json() }; };
  const initial = await post("/koin/prepaid/status"); assert.equal(initial.value.credits.available, "1000"); assert.equal(initial.value.balance.purchased, "0");
  for (const [route, body] of [["quote-usd", { dollars: "1" }], ["quote", { amount: "100000000" }]]) {
    const unavailable = await post("/koin/prepaid/" + route, body);
    assert.equal(unavailable.status, 400); assert.match(unavailable.value.error, /Free credits do not require a wallet/);
  }
  const messages = [{ role: "user", content: "Hi" }], model = "fixture", max_tokens = 16;
  for (const billing of [undefined, "koin-shadow", "koin-prepaid-v1"]) {
    const blocked = await post("/consume/chat/completions", { messages, model, max_tokens, ...(billing ? { billing } : {}) });
    assert.equal(blocked.status, 409); assert.equal(blocked.value.error.type, "credit_account_required");
    assert.equal(router.ledger.jobs().length, 0, "legacy allowance cannot create an unmetered request");
  }
  const estimate = await post("/koin/prepaid/estimate", { messages, model, max_tokens, freeOnly: true });
  assert.equal(estimate.value.estimate.maxPaid, "0"); assert.equal(estimate.value.estimate.allowed, true);
  const requestId = P.hash("public-stream"), response = await raw("/consume/chat/completions", { sessionToken, billing: "koin-prepaid-usd-v1", requestId, messages, model, max_tokens, freeOnly: true, maxPaid: "0", stream: true });
  assert.match(response.headers.get("content-type"), /event-stream/);
  const job = await router.work.next(worker); assert.equal(job.id, requestId); assert.equal(job.stream, true);
  const output = "Hello", signature = Buffer.from(await f.worker.signHash(F.fundedChunkHash(f.target, job, output, 1))).toString("base64");
  const chunk = await post(wire.prefix + "chunk", { jobId: job.id, output, sequence: 1, signature }); assert.equal(chunk.status, 200, JSON.stringify(chunk));
  const reader = response.body.getReader(), first = await reader.read(), frame = Buffer.from(first.value).toString();
  assert.match(frame, /Hello/); assert.match(frame, /streaming/); assert.ok(!frame.includes("[DONE]"), "prefix arrives before completion");
  const stop = await post("/koin/prepaid/cancel", { requestId }); assert.equal(stop.value.state, "charged");
  const recover = await post("/koin/prepaid/result", { requestId }); assert.equal(recover.value.completion.choices[0].message.content, output);
  const after = await post("/koin/prepaid/status"); assert.equal(after.value.balance.spent, "0");
  assert.ok(BigInt(after.value.credits.free.available) < 1000n); assert.equal(after.value.purchases.length, 0);
  assert.equal((await post(wire.prefix + "chunk", { jobId: job.id, output: "Hello later", sequence: 2, signature })).status, 400);
  const last = await post("/koin/prepaid/status"); assert.equal(last.value.credits.available, after.value.credits.available);
  while (!(await reader.read()).done) {};
  // Linking more wallets cannot multiply this verified account's free grant
  // or combine the separately attributed purchased balances.
  const originalView = auth.service.accountView.bind(auth.service);
  auth.service.accountView = a => ({ ...originalView(a), wallets: [{ address: f.owner }, { address: f.provider }] });
  const id = "0x1220" + P.hash("second-wallet-purchase"); router.ledger.queuePurchase(id, f.provider);
  router.ledger.confirmPurchase(id, { state: "finalized", txId: id, owner: f.provider, amount: "500" });
  assert.equal((await post("/koin/prepaid/status")).status, 400, "multiple wallets require explicit selection");
  const selected = await post("/koin/prepaid/status", { creditWallet: f.provider });
  assert.equal(selected.value.balance.purchased, "500"); assert.equal(selected.value.credits.free.available, last.value.credits.free.available);
  const firstWallet = await post("/koin/prepaid/status", { creditWallet: f.owner }); assert.equal(firstWallet.value.balance.purchased, "0");
  assert.equal((await post("/koin/prepaid/status", { creditWallet: address("unlinked") })).status, 400);
  const walletless = await post("/koin/prepaid/status", { creditWallet: null }); assert.equal(walletless.value.credits.free.available, last.value.credits.free.available);
  const recoveredWithSelection = await post("/koin/prepaid/result", { requestId, creditWallet: f.provider });
  assert.equal(recoveredWithSelection.value.completion.choices[0].message.content, output);
  assert.equal((await post("/koin/prepaid/status", { creditWallet: f.provider })).value.balance.spent, "0", "recovering an earlier free answer never debits the selected wallet");
  assert.equal((await post("/koin/prepaid/capabilities", { creditWallet: f.owner })).value.capabilities.advancedRuns, true);
  const runId = P.hash("public-research-run"), terms = { creditWallet: f.owner, runId, mode: "research", model, maxTotal: estimate.value.estimate.maxCharge, freeOnly: true };
  assert.equal((await post("/koin/prepaid/run-open", terms)).value.run.state, "open");
  const runRequest = { billing: "koin-prepaid-usd-v1", creditWallet: f.owner, runId, requestId: P.hash("run-subcall"), messages, model, max_tokens, freeOnly: true, maxPaid: "0", stream: false };
  const runAnswer = post("/consume/chat/completions", runRequest);
  for (let i = 0; i < 100 && !router.ledger.job(runRequest.requestId); i++) await new Promise(r => setTimeout(r, 5));
  const overBudget = await post("/consume/chat/completions", { ...runRequest, requestId: P.hash("concurrent-run-subcall") });
  assert.equal(overBudget.status, 400); assert.match(overBudget.value.error, /Total run budget/);
  const runJob = await router.work.next(worker), finalText = "Done";
  const signed = Buffer.from(await f.worker.signHash(F.fundedResultHash(f.target, runJob, finalText))).toString("base64");
  assert.equal((await post(wire.prefix + "result", { jobId: runJob.id, output: finalText, signature: signed })).status, 200);
  assert.equal((await runAnswer).value.completion.choices[0].message.content, finalText);
  const runState = await post("/koin/prepaid/run-status", { creditWallet: f.owner, runId }); assert.ok(BigInt(runState.value.run.spent) > 0n);
  const stoppedRun = await post("/koin/prepaid/run-stop", { creditWallet: f.owner, runId }); assert.equal(stoppedRun.value.run.spent, runState.value.run.spent);
  assert.equal((await post("/consume/chat/completions", runRequest)).value.completion.choices[0].message.content, finalText, "repeated delivered subcall remains recoverable after Stop");
});
