"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const https = require("node:https"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRpcTransport } = require("../lib/koin-network/rpc-http");
const { RpcScheduler, readScope, requestOwner, endpointStats } = require("../lib/koin-network/rpc-scheduler");
const { PinnedRpcProvider, rpcDiagnostics } = require("../lib/koin-network/rpc-provider");
const { readGroup } = require("../lib/koin-network/read-group");
const scope = name => readScope(name, () => requestOwner(true));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function manualScheduler() {
  let now = 0, id = 0; const timers = new Map();
  const scheduler = new RpcScheduler({ now: () => now, schedule: (callback, ms) => {
    const key = ++id; timers.set(key, { at: now + ms, callback }); return key;
  } });
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].callback(); await flush();
    }
    now = end; await flush();
  };
  return { scheduler, advance, now: () => now };
}
async function occupied(f, endpoint) {
  const controllers = [new AbortController(), new AbortController()];
  const first = await f.scheduler.slot(endpoint, controllers[0].signal, scope("interactive"));
  const second = f.scheduler.slot(endpoint, controllers[1].signal, scope("interactive"));
  await f.advance(50);
  return { controllers, releases: [first, await second] };
}
test("saturated classes get a bounded weighted turn, and owners rotate within each class", async () => {
  const f = manualScheduler(), endpoint = "fairness", held = await occupied(f, endpoint), trace = [], pending = [];
  for (const [trafficClass, name, count] of [["availability", "a1", 16], ["availability", "a2", 16],
    ["interactive", "i1", 16], ["interactive", "i2", 16], ["background", "b1", 8], ["background", "b2", 8]]) {
    const owner = scope(trafficClass);
    for (let i = 0; i < count; i++) pending.push(f.scheduler.slot(endpoint, new AbortController().signal, owner).then(release => {
      trace.push({ trafficClass, name, at: f.now() }); assert.ok(f.scheduler.stats(endpoint).active <= 2); release();
    }));
  }
  assert.equal(f.scheduler.stats(endpoint).queued, 80);
  held.releases.forEach(release => release()); await f.advance(50 * 40);
  for (let i = 0; i < 27; i++) {
    const turn = trace.slice(i, i + 9).map(row => row.trafficClass);
    assert.equal(turn.filter(c => c === "availability").length, 4);
    assert.equal(turn.filter(c => c === "interactive").length, 4);
    assert.equal(turn.filter(c => c === "background").length, 1);
  }
  for (const [cls, names] of [["availability", ["a1", "a2"]], ["interactive", ["i1", "i2"]]])
    assert.deepEqual(trace.filter(row => row.trafficClass === cls).slice(0, 8).map(row => row.name), names.flatMap(name => Array(4).fill(name)));
  assert.deepEqual(trace.filter(row => row.trafficClass === "background").slice(0, 4).map(row => row.name), ["b1", "b2", "b1", "b2"]);
  assert.ok(trace.every((row, i) => !i || row.at - trace[i - 1].at >= 50));
  await f.advance(5000); await Promise.all(pending); assert.equal(f.scheduler.stats(endpoint).queued, 0);
});
test("admission bounds one owner, reserves foreground capacity and removes cancelled queues", async () => {
  const f = manualScheduler(), endpoint = "limits", held = await occupied(f, endpoint), controllers = [], pending = [];
  const enqueue = (trafficClass, count) => {
    const owner = scope(trafficClass), controller = new AbortController(); controllers.push(controller);
    for (let i = 0; i < count; i++) pending.push(f.scheduler.slot(endpoint, controller.signal, owner).then(release => { release(); throw Error("Cancelled read sent late"); }, error => error.code));
    return owner;
  };
  const interactive = enqueue("interactive", 16);
  await assert.rejects(f.scheduler.slot(endpoint, new AbortController().signal, interactive), { code: "rpc_queue_full" });
  for (let i = 0; i < 6; i++) enqueue("background", 16);
  await assert.rejects(f.scheduler.slot(endpoint, new AbortController().signal, scope("background")), { code: "rpc_queue_full" });
  assert.equal(f.scheduler.stats(endpoint).queued, 112);
  await assert.rejects(f.scheduler.slot(endpoint, new AbortController().signal, scope("interactive")), { code: "rpc_queue_full" });
  enqueue("availability", 16);
  assert.equal(f.scheduler.stats(endpoint).queued, 128);
  assert.equal(f.scheduler.stats(endpoint).classes.background.queued, 96);
  await assert.rejects(f.scheduler.slot(endpoint, new AbortController().signal, scope("interactive")), { code: "rpc_queue_full" });
  controllers.forEach(controller => controller.abort());
  assert.equal(f.scheduler.stats(endpoint).queued, 0);
  assert.ok((await Promise.all(pending)).every(code => code === "rpc_queue_stopped"));
  held.controllers.forEach(controller => controller.abort());
  assert.equal(f.scheduler.stats(endpoint).active, 2, "Aborting an active lease never pretends its socket has closed");
  held.releases.forEach(release => { release(); release(); }); await f.advance(1000);
  assert.equal(f.scheduler.stats(endpoint).active, 0);
});
test("nested read scopes preserve owner and class while ordinary calls receive distinct owners", async () => {
  const outer = await readScope("background", async () => {
    const first = requestOwner(true); await Promise.resolve();
    const nested = await readGroup(null, [() => requestOwner(true), () => readScope("availability", () => requestOwner(true))]);
    assert.ok(nested.every(value => value === first)); return first;
  });
  assert.equal(outer.trafficClass, "background");
  assert.notEqual(requestOwner(true), requestOwner(true));
  assert.equal(requestOwner(true).trafficClass, "interactive");
});
test("explicit read groups reject broadcasts before pinning; unscoped broadcasts still have one exact attempt", async () => {
  const calls = [], p = new PinnedRpcProvider(["https://write-primary.invalid", "https://write-backup.invalid"], "fixture", {
    fetchImpl: async (endpoint, request) => {
      const body = JSON.parse(request.body); calls.push({ endpoint, body });
      return body.method === "chain.get_chain_id" ? new Response(JSON.stringify({ id: body.id, jsonrpc: "2.0", result: { chain_id: "fixture" } })) : new Response("unavailable", { status: 503 });
    },
  });
  const transaction = { id: "exact-envelope", signatures: ["private"] };
  await assert.rejects(readScope("availability", () => p.call("chain.submit_transaction", { broadcast: true, transaction })), { code: "koin_rpc_read_scope" });
  assert.equal(calls.length, 0);
  await assert.rejects(p.call("chain.submit_transaction", { broadcast: true, transaction }), { code: "koin_rpc_unavailable" });
  assert.deepEqual(calls.map(row => [row.endpoint, row.body.method]), [["https://write-primary.invalid", "chain.get_chain_id"], ["https://write-primary.invalid", "chain.submit_transaction"]]);
  assert.deepEqual(calls[1].body.params.transaction, transaction);
});
test("queued foreground deadlines do not bypass occupied sockets or send after cancellation", { timeout: 5000 }, async t => {
  const endpoint = "https://fair-deadline.invalid", seen = [], closed = [];
  let start, allowClose; const twoStarted = new Promise(resolve => { start = resolve; }), closing = new Promise(resolve => { allowClose = resolve; });
  const fetchImpl = (url, request) => new Promise((_resolve, reject) => {
    seen.push(JSON.parse(request.body)); if (seen.length === 2) start();
    const aborted = async () => { await closing; closed.push(url); reject(Error("Closed")); };
    request.signal.addEventListener("abort", aborted, { once: true });
  });
  const holders = new PinnedRpcProvider([endpoint], "fixture", { timeoutMs: 2000, attemptTimeoutMs: 500, fetchImpl });
  const controller = new AbortController();
  const active = readScope("background", () => readGroup(holders, [
    () => holders.call("chain.get_chain_id", {}, { signal: controller.signal }),
    () => holders.call("chain.get_chain_id", {}, { signal: controller.signal }),
  ]));
  const activeResult = active.catch(error => error);
  t.after(async () => { controller.abort(); allowClose(); await activeResult; });
  await twoStarted;
  const urgent = new PinnedRpcProvider([endpoint], "fixture", { timeoutMs: 1000, attemptTimeoutMs: 30, fetchImpl });
  await assert.rejects(readScope("availability", () => urgent.getChainId()), error => rpcDiagnostics(error)[0].kind === "timeout");
  assert.equal(seen.length, 2); assert.equal(endpointStats(endpoint).queued, 0);
  controller.abort(); await activeResult;
  assert.equal(endpointStats(endpoint).active, 2);
  allowClose(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed.length, 2); assert.equal(endpointStats(endpoint).active, 0); assert.equal(seen.length, 2);
});
test("real TLS foreground reads get a turn after held background sockets close, without exceeding two sockets", { timeout: 10000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rpc-fairness-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const cert = fs.readFileSync(path.join(dir, "cert.pem")), sockets = new Set(), held = [], trace = [], pending = [];
  const abort = new AbortController(); let bothStarted, active = 0, peak = 0;
  const started = new Promise(resolve => { bothStarted = resolve; });
  const server = https.createServer({ cert, key: fs.readFileSync(path.join(dir, "key.pem")) }, (req, res) => {
    (async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); trace.push(req.headers["x-test-class"]);
      const reply = () => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { chain_id: "fixture" } }));
      if (trace.length <= 2) { held.push(reply); if (held.length === 2) bothStarted(); } else reply();
    })().catch(() => res.destroy());
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  t.after(async () => { abort.abort(); held.forEach(reply => reply()); for (const socket of sockets) socket.destroy();
    await Promise.allSettled(pending); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `https://127.0.0.1:${server.address().port}`;
  const fetchImpl = createRpcTransport({ request: (url, options, callback) => {
    const request = https.request(url, { ...options, ca: cert,
      headers: { ...options.headers, "x-test-class": requestOwner(true).trafficClass } }, callback);
    active++; peak = Math.max(peak, active); request.once("close", () => { active--; }); return request;
  } });
  const p = new PinnedRpcProvider([endpoint], "fixture", { fetchImpl, timeoutMs: 3000, attemptTimeoutMs: 2000 });
  const start = (trafficClass, count) => {
    const result = readScope(trafficClass, () => p.withSignal(abort.signal, () => readGroup(p, Array.from({ length: count }, () => () => p.getChainId()))));
    pending.push(result); result.catch(() => {}); return result;
  };
  const occupied = start("background", 2); await started;
  const background = start("background", 8), foreground = start("availability", 1);
  assert.equal(endpointStats(endpoint).queued, 9); assert.equal(trace.length, 2);
  held.forEach(reply => reply()); await foreground;
  assert.ok(trace.indexOf("availability") >= 2 && trace.indexOf("availability") <= 3, "Foreground is dispatched before the queued background batch drains");
  await Promise.all([occupied, background]);
  assert.equal(trace.length, 11); assert.ok(peak <= 2); assert.equal(active, 0); assert.equal(endpointStats(endpoint).active, 0);
});
