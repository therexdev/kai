"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path");
const { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol");
test("prepaid purchase is credited exactly once; pending or failed purchases leave existing credits usable", async t => {
  const f = fixture(t), id = f.purchase(); f.purchase();
  assert.equal(f.ledger.balance(f.owner).purchased, "1000");
  f.ledger.queuePurchase("0x1220" + P.hash("pending"), f.owner);
  f.ledger.reserve(f.request("chat")); assert.ok(BigInt(f.ledger.balance(f.owner).available) > 0n);
  assert.throws(() => f.ledger.queuePurchase(id, f.provider), /another account/);
  assert.throws(() => f.ledger.confirmPurchase("0x1220" + P.hash("pending"), { state: "reversible", txId: id, amount: "10" }), /Finalized/);
});
test("saving an answer does not charge; receipt acknowledgement charges once and releases the unused quote", async t => {
  const f = fixture(t); f.purchase(); const j = f.ledger.reserve(f.request("chat")), ready = await f.complete(j.id);
  assert.equal(f.ledger.balance(f.owner).spent, "0"); assert.equal(f.ledger.balance(f.owner).held, ready.receipt.usage.amount);
  f.ledger.acknowledge(j.id, f.owner, ready.receiptHash); f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  const balance = f.ledger.balance(f.owner); assert.equal(balance.spent, ready.receipt.usage.amount); assert.equal(balance.held, "0");
  assert.equal(BigInt(balance.available) + BigInt(balance.spent), 1000n);
  assert.equal(f.ledger.pendingJobs().length, 1);
  assert.throws(() => f.ledger.acknowledge(j.id, f.provider, ready.receiptHash), /another account/);
});
test("timeouts, cancellation and service restart release unfinished work without waiting for chain settlement", async t => {
  const f = fixture(t); f.purchase();
  for (const state of ["queued", "running", "ready"]) {
    const j = f.ledger.reserve(f.request(state));
    if (state === "running") f.ledger.dispatch(j.id, f.provider);
    if (state === "ready") await f.complete(j.id);
    f.time(3001); assert.equal(f.ledger.balance(f.owner).available, "1000"); assert.equal(f.ledger.job(j.id).state, "cancelled");
  }
  const job = f.ledger.reserve(f.request("restart")); f.ledger.dispatch(job.id, f.provider); f.restart();
  assert.equal(f.ledger.balance(f.owner).available, "1000"); assert.equal(f.ledger.job(job.id).state, "cancelled");
  const next = f.ledger.reserve(f.request("cancel")); f.ledger.cancel(next.id, f.owner);
  assert.equal(f.ledger.balance(f.owner).available, "1000");
});
test("charged answers survive a restart encrypted; stuck settlements cannot prevent the next chat", async t => {
  const f = fixture(t); f.purchase(); const j = f.ledger.reserve(f.request("one")), ready = await f.complete(j.id);
  f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  f.ledger.settlement(j.id, { state: "needs_review", attempts: 3 }); f.restart();
  const replay = f.ledger.job(j.id, f.owner); assert.equal(f.ledger.decrypt(j.id, replay.answer), "Private answer");
  f.ledger.acknowledge(j.id, f.owner, ready.receiptHash);
  f.ledger.reserve(f.request("two")); assert.equal(f.ledger.balance(f.owner).spent, ready.receipt.usage.amount);
  for (const name of fs.readdirSync(f.dir)) { const bytes = fs.readFileSync(path.join(f.dir, name)); assert.ok(!bytes.includes(Buffer.from("Private answer"))); assert.ok(!bytes.includes(Buffer.from("Private question"))); }
});
test("concurrent requests cannot overspend; duplicate IDs cannot change terms or redispatch", async t => {
  const f = fixture(t); f.purchase("limited", "80"); const a = f.ledger.reserve(f.request("one"));
  assert.throws(() => f.ledger.reserve(f.request("two")), /Not enough credits/);
  assert.deepEqual(f.ledger.reserve(f.request("one")), a);
  assert.throws(() => f.ledger.reserve({ ...f.request("one"), maxOutput: 15 }), /another message/);
  f.ledger.dispatch(a.id, f.provider); assert.throws(() => f.ledger.dispatch(a.id, f.provider), /unavailable/);
});
test("late or invalid provider results cannot charge a cancelled request", async t => {
  const f = fixture(t); f.purchase(); const j = f.ledger.reserve(f.request("one")); f.ledger.dispatch(j.id, f.provider);
  assert.throws(() => f.ledger.complete(j.id, { output: "bad", signature: Buffer.alloc(65).toString("base64") }, true));
  f.ledger.cancel(j.id, f.owner); assert.throws(() => f.ledger.complete(j.id, {}, true), /expired/);
  assert.equal(f.ledger.balance(f.owner).available, "1000");
});
test("normal HTTP chat, signed provider, account balance and delivery acknowledgement use prepaid credits end to end", async t => {
  const f = fixture(t), { KoinChain } = require("../lib/koin-network/chain"), { Scheduler } = require("../lib/scheduler"), { Signer } = require("koilib");
  const address = n => Signer.fromSeed("prepaid-" + n).getAddress();
  const deployment = { schema: 1, network: "mainnet", product: "prepaid-v1", chainId: f.target.chainId, decimals: 8, rpc: ["https://fixture.invalid"],
    token: require("../lib/koin-network/payment-network").MAINNET_TOKEN, credits: f.target.credits, creditsHash: f.target.creditsHash,
    rewards: address("rewards"), admin: address("admin"), verifier: address("verifier"), mining: address("mining"), operations: address("operations"),
    tokenHash: "0x1220" + P.hash("token"), rewardsHash: "0x1220" + P.hash("rewards") };
  const client = new KoinChain(deployment, {}), accounts = { sessionAccount: token => token === "customer" ? { id: "customer" } : null,
    accountView: () => ({ wallets: [{ address: f.owner }] }) };
  const scheduler = new Scheduler({ dataDir: path.join(f.dir, "http"), accounts, koinPrepaid: { client, ...f.options, qualify: () => true, accept: ({ output }) => !!output } });
  t.after(() => scheduler.close());
  const port = await scheduler.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`, router = scheduler.koinPrepaid;
  const post = async (route, b) => { const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken: "customer", ...b }) }); return { status: r.status, value: await r.json() }; };
  const txId = "0x1220" + P.hash("http-buy"); await post("/koin/prepaid/purchase", { txId });
  router.ledger.confirmPurchase(txId, { state: "finalized", txId, owner: f.owner, amount: "1000" });
  const requestId = P.hash("http-chat"), body = { billing: "koin-prepaid-v1", requestId, model: "fixture", messages: [{ role: "user", content: "hello" }], max_tokens: 16 };
  const pending = post("/consume/chat/completions", body);
  for (let i = 0; i < 100 && !router.ledger.job(requestId); i++) await new Promise(r => setTimeout(r, 10));
  const wire = require("../lib/koin-network/payment-network").protocol(f.target), worker = { address: f.provider, proof: "signed", models: ["fixture"], capabilities: { [wire.capability]: 1 } };
  scheduler.workers.set("provider-token", worker);
  const dispatched = await fetch(base + "/worker/next-job?token=provider-token").then(r => r.json());
  const job = dispatched.job, output = "PONG";
  assert.equal(job.id, requestId); assert.ok(!JSON.stringify(job).includes("customer"));
  const signature = Buffer.from(await f.worker.signHash(require("../lib/koin-network/funded-protocol").fundedResultHash(f.target, job, output))).toString("base64");
  const result = await post(wire.prefix + "result?token=provider-token", { jobId: requestId, output, signature }); assert.equal(result.status, 200, JSON.stringify(result));
  const answer = await pending; assert.equal(answer.status, 200, JSON.stringify(answer)); assert.equal(answer.value.completion.choices[0].message.content, "PONG");
  const receiptHash = answer.value.completion.koin.receiptHash;
  const before = await post("/koin/prepaid/status", {}); assert.notEqual(before.value.balance.spent, "0");
  const cancelled = await post("/koin/prepaid/cancel", { requestId });
  assert.equal(cancelled.value.state, "charged", "Reading an answer then cancelling cannot evade payment");
  assert.equal(cancelled.value.balance.spent, before.value.balance.spent);
  const recovered = await post("/koin/prepaid/result", { requestId });
  assert.equal(recovered.value.completion.koin.receiptHash, receiptHash);
  assert.equal((await post("/koin/prepaid/status", {})).value.balance.spent, before.value.balance.spent, "Recovery never charges twice");
  assert.equal((await post("/koin/prepaid/acknowledge", { requestId, receiptHash })).value.state, "charged");
  const after = await post("/koin/prepaid/status", {}); assert.notEqual(after.value.balance.spent, "0"); assert.equal(after.value.balance.held, "0");
  assert.equal((await post("/koin/prepaid/acknowledge", { requestId, receiptHash })).value.balance.spent, after.value.balance.spent);
  const replay = await post("/consume/chat/completions", body); assert.equal(replay.value.completion.id, requestId);
  const denied = await post("/koin/prepaid/status", { sessionToken: "stranger" }); assert.equal(denied.status, 401);
});
