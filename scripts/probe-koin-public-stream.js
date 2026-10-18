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
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/auth/")) return app(req, res);
    if (req.url === "/consume/chat/completions") { const parts = []; for await (const p of req) parts.push(p); return router.work.chat(req, res, JSON.parse(Buffer.concat(parts))); }
    if (!await router.handle(req, res, () => worker)) { res.writeHead(404); res.end(); }
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
  const messages = [{ role: "user", content: "Hi" }], model = "fixture", max_tokens = 16;
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
});
