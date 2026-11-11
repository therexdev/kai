"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const Stream = require("../lib/koin-network/credit-stream");
function response() {
  return Object.assign(new EventEmitter(), { frames: [], writableLength: 0, destroyed: false, writableEnded: false,
    write(text) { this.frames.push(text); }, destroy() { this.destroyed = true; this.emit("close"); } });
}
test("opted-in streams send immediate and periodic comments and release timers after finish or disconnect", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const event of ["finish", "close"]) {
    const res = response(), stop = Stream.keepalive({ headers: { [Stream.header]: Stream.capability } }, res);
    assert.deepEqual(res.frames, [": kai-keepalive\n\n"]);
    t.mock.timers.tick(Stream.intervalMs - 1); assert.equal(res.frames.length, 1);
    t.mock.timers.tick(1); assert.equal(res.frames.length, 2);
    res.emit(event); t.mock.timers.tick(Stream.intervalMs * 3); assert.equal(res.frames.length, 2);
    assert.equal(res.listenerCount("close"), 0); assert.equal(res.listenerCount("finish"), 0); stop();
  }
});
test("older clients receive no comments and keep-alives cannot buffer indefinitely for a slow reader", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const headers of [{}, { [Stream.header]: "unknown" }]) {
    const res = response(); Stream.keepalive({ headers }, res); t.mock.timers.tick(30000); assert.deepEqual(res.frames, []);
  }
  const res = response(); Stream.keepalive({ headers: { [Stream.header]: Stream.capability } }, res);
  res.writableLength = 2000001; t.mock.timers.tick(Stream.intervalMs);
  assert.equal(res.destroyed, true); t.mock.timers.tick(Stream.intervalMs); assert.equal(res.frames.length, 1);
});
test("a failed keep-alive write closes the connection without an unhandled timer exception", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const res = response(); Stream.keepalive({ headers: { [Stream.header]: Stream.capability } }, res);
  res.write = () => { throw Error("Socket unavailable"); }; t.mock.timers.tick(Stream.intervalMs);
  assert.equal(res.destroyed, true); assert.equal(res.listenerCount("close"), 0);
});

test("the real credit router keeps a quiet request alive through an idle proxy and bills only its signed answer", { timeout: 50000 }, async t => {
  const http = require("node:http"), path = require("node:path"), { fixture } = require("./helpers/koin-prepaid-fixture");
  const { Scheduler } = require("../lib/scheduler"), { KoinChain } = require("../lib/koin-network/chain"), { Signer } = require("koilib");
  const P = require("../lib/koin-network/job-protocol"), F = require("../lib/koin-network/funded-protocol"), { protocol, MAINNET_TOKEN } = require("../lib/koin-network/payment-network");
  const f = fixture(t), address = n => Signer.fromSeed("stream-heartbeat-" + n).getAddress();
  const client = new KoinChain({ schema: 1, network: "mainnet", product: "prepaid-v1", chainId: f.target.chainId, decimals: 8, rpc: ["https://fixture.invalid"],
    token: MAINNET_TOKEN, credits: f.target.credits, creditsHash: f.target.creditsHash, rewards: address("rewards"),
    admin: address("admin"), verifier: address("verifier"), mining: address("mining"), operations: address("operations"),
    tokenHash: "0x1220" + P.hash("token"), rewardsHash: "0x1220" + P.hash("rewards") }, {});
  const accounts = { sessionAccount: token => token === "fixture" ? { id: "customer" } : null, accountView: () => ({ wallets: [{ address: f.owner }] }) };
  const scheduler = new Scheduler({ dataDir: path.join(f.dir, "http"), accounts, koinPrepaid: { client, ...f.options, qualify: () => true, accept: () => true } });
  t.after(() => scheduler.close());
  const port = await scheduler.listen(0, "127.0.0.1"), router = scheduler.koinPrepaid, wire = protocol(f.target);
  const health = require("../test-server").createHandler({ runtime: { prepaid: true, scheduler },
    config: { mode: "mainnet-pilot", deployment: client.d, schedulerUrl: "https://fixture.invalid/scheduler" }, secret: "fixture" });
  let observedHealth;
  await health({ url: "/health", method: "GET" }, { setHeader() {}, writeHead(code) { assert.equal(code, 200); }, end(body) { observedHealth = JSON.parse(body); } });
  assert.equal(observedHealth.streamKeepaliveVersion, 1, "health reads the actual router capability, not the runtime's prepaid boolean");
  const id = "0x1220" + P.hash("heartbeat-fixture-purchase"); router.ledger.queuePurchase(id, f.owner);
  router.ledger.confirmPurchase(id, { state: "finalized", txId: id, owner: f.owner, amount: "1000" });
  const post = async (route, b) => {
    const res = await fetch(`http://127.0.0.1:${port}` + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken: "fixture", ...b }) });
    return res.json();
  };
  let idleCuts = 0;
  const proxy = http.createServer((req, res) => {
    let timer;
    const upstream = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers }, origin => {
      res.writeHead(origin.statusCode, origin.headers);
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { idleCuts++; origin.destroy(); res.destroy(); }, 20000); };
      arm(); origin.on("data", chunk => { arm(); res.write(chunk); }); origin.on("end", () => { clearTimeout(timer); res.end(); });
      origin.on("error", () => res.destroy());
    });
    upstream.on("error", () => res.destroy()); req.pipe(upstream);
    res.on("close", () => { clearTimeout(timer); upstream.destroy(); });
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const requestId = P.hash("idle-request"), request = { sessionToken: "fixture", billing: "koin-prepaid-v1", requestId, model: "fixture", messages: [{ role: "user", content: "Hello" }], max_tokens: 16, stream: true };
  const pending = await fetch(`http://127.0.0.1:${proxy.address().port}/consume/chat/completions`, { method: "POST", headers: { "content-type": "application/json", [Stream.header]: Stream.capability }, body: JSON.stringify(request), signal: AbortSignal.timeout(45000) });
  const reader = pending.body.getReader(); let text = "";
  // Two full idle periods would exceed this proxy's limit without heartbeats.
  while ((text.match(/: kai-keepalive/g) || []).length < 3) { const part = await reader.read(); assert.equal(part.done, false); text += Buffer.from(part.value).toString(); }
  assert.equal(router.ledger.balance(f.owner).spent, "0"); assert.equal(idleCuts, 0);
  const worker = { address: f.provider, proof: "signed", models: ["fixture"], capabilities: { [wire.capability]: 1, koinMeteredStreaming: 1 } };
  const job = await router.work.next(worker); assert.equal(job.id, requestId);
  scheduler.workers.set("provider", worker);
  const output = "Complete", signature = Buffer.from(await f.worker.signHash(F.fundedResultHash(f.target, job, output))).toString("base64");
  assert.equal((await post(wire.prefix + "result?token=provider", { jobId: job.id, output, signature })).accepted, true);
  for (;;) { const part = await reader.read(); if (part.done) break; text += Buffer.from(part.value).toString(); }
  assert.match(text, /Complete/); assert.match(text, /\[DONE\]/); assert.equal(idleCuts, 0);
  const spent = router.ledger.balance(f.owner).spent; assert.ok(BigInt(spent) > 0n);
  assert.equal((await post("/koin/prepaid/result", { requestId })).completion.choices[0].message.content, output);
  assert.equal(router.ledger.balance(f.owner).spent, spent); assert.equal(router.streamKeepaliveVersion, 1);
});
