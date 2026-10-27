"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto"), express = require("express");
const { Signer } = require("koilib"), { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol");
const { challengeHash } = require("../lib/device-free-auth"), F = require("../lib/koin-network/funded-protocol");
const pair = () => { const k = crypto.generateKeyPairSync("ed25519"); return { ...k, encoded: k.publicKey.export({ type: "spki", format: "der" }).toString("base64") }; };
async function service(t) {
  const f = fixture(t), auth = require("../lib/accounts").createAccounts({ stateDir: path.join(f.dir, "auth"), siteOrigin: "https://credits.fixture.invalid" });
  auth.service.configureWalletCredits({ target: f.target, schedulerUrl: "https://credits.fixture.invalid/scheduler", clock: f.options.clock });
  const address = s => Signer.fromSeed("free-router-" + s).getAddress(), quotes = [];
  const client = new (require("../lib/koin-network/chain").KoinChain)({ schema: 1, network: "mainnet", product: "prepaid-usd-v1", chainId: f.target.chainId,
    decimals: 8, rpc: ["https://fixture.invalid"], token: require("../lib/koin-network/payment-network").MAINNET_TOKEN, tokenHash: "0x1220" + P.hash("token"), credits: f.target.credits,
    creditsHash: f.target.creditsHash, rewards: address("rewards"), rewardsHash: "0x1220" + P.hash("rewards"), admin: address("admin"), verifier: address("verifier"),
    mining: address("mining"), operations: address("operations"), masterNode: require("../lib/koin-network/product").MASTER_NODE }, {});
  const options = { dataDir: path.join(f.dir, "http"), accounts: auth.service, client, ...f.options, publicAccounts: true,
    freePolicy: { version: 1, accountDaily: "1000", networkDaily: "2000", originDaily: "1500", accountConcurrent: 1, eligibleModels: ["fixture"] },
    qualify: () => true, accept: ({ output }) => !!output.trim(), purchaseQuote: async (...args) => { quotes.push(args); throw Error("Unexpected purchase quote"); } };
  let router = require("../lib/koin-network/prepaid-router").createPrepaidRouter(options);
  const worker = { address: f.provider, proof: "signed", models: ["fixture"], capabilities: { koinMainnetPilotJobs: 1 } };
  const app = express(); app.use(express.json({ limit: "32kb" })); app.use(auth.router);
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/auth/") || req.url.startsWith("/account")) return app(req, res);
    if (req.url === "/consume/chat/completions") { const chunks = []; for await (const chunk of req) chunks.push(chunk); return router.work.chat(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    if (await router.handle(req, res, req => new URL(req.url, "http://x").searchParams.get("token") === "fixture-worker" ? worker : null)) return;
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); router.close(); auth.service.db.close(); });
  const request = async (route, body, token, headers = {}) => { const r = await fetch(base + route, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, cookie: r.headers.get("set-cookie"), body: await r.json() }; };
  const connect = async k => { const pending = await request("/auth/device-free/challenge", { publicKey: k.encoded }); assert.equal(pending.status, 200); const c = pending.body.challenge;
    return request("/auth/device-free/verify", { challengeId: c.nonce, signature: crypto.sign(null, challengeHash(c), k.privateKey).toString("base64") }); };
  return { f, auth, get router() { return router; }, request, connect, worker, quotes,
    restartLedger() { router.close(); router = require("../lib/koin-network/prepaid-router").createPrepaidRouter(options); } };
}
test("fresh installation proof obtains real scoped free credits and completes signed HTTP chat without a wallet, signup or keyring", async t => {
  const s = await service(t), k = pair(), caps = await s.request("/auth/device-free/capabilities"); assert.equal(caps.body.capabilities.deviceFreeCredits, 1);
  assert.equal((await s.request("/koin/prepaid/status", {})).status, 401);
  assert.equal(s.router.ledger.db.prepare("SELECT COUNT(*) AS n FROM free_grants").get().n, 0);
  const connected = await s.connect(k); assert.equal(connected.status, 200); assert.equal(connected.cookie, null);
  const sessionToken = connected.body.token, creditWallet = null, accountId = connected.body.account.id, owner = "account-" + P.hash("verified-account:" + accountId);
  const run = (action, extra = {}) => s.request("/koin/prepaid/" + action, { sessionToken, creditWallet, ...extra });
  const session = await s.request("/auth/session", undefined, sessionToken); assert.equal(session.body.scope, "device-free"); assert.deepEqual(session.body.account.wallets, []);
  const status = await run("status"); assert.equal(status.body.owner, owner); assert.equal(status.body.credits.free.available, "1000"); assert.equal(status.body.balance.purchased, "0");
  const capability = await run("capabilities"); assert.equal(capability.body.capabilities.creditPriority, false); assert.equal(capability.body.capabilities.advancedRuns, false);
  const estimate = await run("estimate", { model: "fixture", messages: [{ role: "user", content: "hello" }], max_tokens: 16 }); assert.equal(estimate.body.estimate.maxPaid, "0"); assert.equal(estimate.body.estimate.freeOnly, true);
  const requestId = P.hash("automatic-free-chat"), waiting = s.request("/consume/chat/completions", { billing: "koin-prepaid-usd-v1", sessionToken, creditWallet, requestId, model: "fixture", messages: [{ role: "user", content: "hello" }], max_tokens: 16 });
  let job; for (let n = 0; n < 100 && !job; n++) { job = await s.router.work.next(s.worker); if (!job) await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(job); const output = "hello back", signature = Buffer.from(await s.f.worker.signHash(F.fundedResultHash(s.f.target, job, output))).toString("base64");
  const accepted = await s.request("/koin/funded/mainnet-pilot/result?token=fixture-worker", { jobId: job.id, output, signature }); assert.equal(accepted.status, 200);
  const answer = await waiting; assert.equal(answer.status, 200); assert.equal(answer.body.completion.choices[0].message.content, output);
  const used = await run("status"); assert.ok(BigInt(used.body.credits.free.available) < 1000n); assert.deepEqual(used.body.usage, []); assert.deepEqual(used.body.purchases, []);
  const row = s.router.ledger.job(requestId); assert.equal(row.funding.paidUsed, "0"); assert.equal(row.funding.freeOnly, true);
  s.restartLedger(); const again = await s.connect(k); assert.equal(again.body.account.id, accountId);
  const after = await run("status", { sessionToken: again.body.token }); assert.deepEqual(after.body.credits.free, used.body.credits.free);
  assert.equal(s.router.ledger.db.prepare("SELECT COUNT(*) AS n FROM free_grants").get().n, 1);
  const recovered = await run("result", { sessionToken: again.body.token, requestId }); assert.equal(recovered.body.completion.choices[0].message.content, output);
  assert.equal(s.router.ledger.job(requestId).funding.freeUsed, row.funding.freeUsed);
  for (const table of ["accounts", "wallets", "sessions", "spend_grants"]) assert.equal(s.auth.service.db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n, 0);
});
test("device-free sessions cannot buy, spend paid credit, open runs, impersonate a wallet or administer an account", async t => {
  const s = await service(t), connected = await s.connect(pair()), sessionToken = connected.body.token;
  const run = (action, extra = {}) => s.request("/koin/prepaid/" + action, { sessionToken, creditWallet: null, ...extra });
  for (const [action, data] of [["quote", { amount: "1" }], ["quote-usd", { dollars: "1" }], ["purchase", { txId: "0x1220" + P.hash("tx") }],
    ["run-open", { runId: P.hash("run"), model: "fixture", mode: "research", maxTotal: "1" }], ["run-status", { runId: P.hash("run") }], ["run-stop", { runId: P.hash("run") }]])
    assert.equal((await run(action, data)).status, 400, action);
  for (const data of [{ freeOnly: false }, { paidFirst: true }, { creditWallet: s.f.owner }]) {
    const estimate = await run("estimate", { model: "fixture", messages: [{ role: "user", content: "paid attempt" }], max_tokens: 16, ...data }); assert.equal(estimate.status, 400);
  }
  const paid = await s.request("/consume/chat/completions", { billing: "koin-prepaid-usd-v1", sessionToken, creditWallet: null, requestId: P.hash("paid-attempt"), model: "fixture",
    messages: [{ role: "user", content: "hello" }], max_tokens: 16, maxPaid: "1" }); assert.equal(paid.status, 400);
  assert.equal(s.quotes.length, 0); assert.equal(s.router.ledger.jobs().length, 0);
  assert.equal((await s.request("/account/api", undefined, sessionToken)).status, 401);
  assert.equal((await s.request("/account/wallets", { address: s.f.owner, ts: Date.now(), signature: "invalid" }, sessionToken)).status, 401);
  assert.equal(s.auth.service.sessionAccount(sessionToken), null); assert.equal(s.auth.service.walletCredits.sessionAccount(sessionToken), null);
  await s.request("/auth/device-free/logout", {}, sessionToken); assert.equal((await run("status")).status, 401);
});
test("guessed request IDs and forged origin headers cannot recover another guest or paid account or bypass the shared free ceiling", async t => {
  const s = await service(t), a = (await s.connect(pair())).body, b = (await s.connect(pair())).body, identity = id => ({ accountId: P.hash("verified-account:" + id), origin: P.hash("origin:127.0.0.1") });
  const owner = "account-" + identity(a.account.id).accountId, id = P.hash("private-guest-job");
  s.router.ledger.reserve({ id, owner, identity: identity(a.account.id), ownership: { accountId: a.account.id, wallets: [] }, freeOnly: true, model: "fixture", version: 1, messages: [{ role: "user", content: "private" }], maxOutput: 16 });
  for (const action of ["result", "cancel", "acknowledge"]) {
    const r = await s.request("/koin/prepaid/" + action, { sessionToken: b.token, creditWallet: null, requestId: id, ...(action === "acknowledge" ? { receiptHash: P.hash("receipt") } : {}) });
    assert.equal(r.status, 400); assert.match(r.body.error, /another wallet/);
  }
  const guessedChat = await s.request("/consume/chat/completions", { billing: "koin-prepaid-usd-v1", sessionToken: b.token, creditWallet: null, requestId: id,
    model: "fixture", messages: [{ role: "user", content: "guess existing request" }], max_tokens: 16 });
  assert.equal(guessedChat.status, 400); assert.match(guessedChat.body.error, /another wallet/);
  for (const route of ["/koin/prepaid/estimate", "/consume/chat/completions"]) {
    const attempt = await s.request(route, { sessionToken: b.token, creditWallet: null, model: "fixture", messages: [{ role: "user", content: "run attempt" }], max_tokens: 16,
      runId: P.hash("another-run"), ...(route.includes("consume") ? { billing: "koin-prepaid-usd-v1", requestId: P.hash("run-chat") } : {}) });
    assert.equal(attempt.status, 400); assert.match(attempt.body.error, /individual free chats/);
  }
  const paidId = P.hash("private-paid-job"), paidIdentity = identity("paid-fixture");
  s.router.ledger.queuePurchase("0x1220" + P.hash("paid-credit"), s.f.owner); s.router.ledger.confirmPurchase("0x1220" + P.hash("paid-credit"), { state: "finalized", txId: "0x1220" + P.hash("paid-credit"), owner: s.f.owner, amount: "1000" });
  s.router.ledger.reserve({ id: paidId, owner: s.f.owner, identity: paidIdentity, ownership: { accountId: "paid-fixture", wallets: [s.f.owner] }, paidFirst: true, model: "fixture", version: 1, messages: [{ role: "user", content: "private paid" }], maxOutput: 16 });
  assert.equal((await s.request("/koin/prepaid/result", { sessionToken: b.token, creditWallet: null, requestId: paidId })).status, 400);
  s.router.ledger.cancel(id, owner); s.router.ledger.cancel(paidId, s.f.owner);
  // Existing conservative proxy-origin policy remains authoritative. A header
  // cannot move this caller into a fresh origin bucket.
  s.router.ledger.write(() => s.router.ledger.db.prepare("INSERT INTO free_origins VALUES(?,?,?)").run(identity(a.account.id).origin, Math.floor(s.f.options.clock() / 86400000), "1499"));
  for (const session of [a, b]) {
    const r = await s.request("/koin/prepaid/status", { sessionToken: session.token, creditWallet: null }, undefined, { "x-forwarded-for": crypto.randomBytes(4).join(".") });
    assert.equal(r.body.credits.free.available, "1"); assert.equal(r.body.balance.purchased, "0");
  }
  s.router.ledger.free.isAvailable = () => false;
  const paused = await s.request("/koin/prepaid/status", { sessionToken: a.token, creditWallet: null }); assert.equal(paused.body.credits.free.available, "0"); assert.equal(paused.body.credits.free.state, "unavailable");
});
