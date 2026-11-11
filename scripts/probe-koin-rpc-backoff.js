"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { RpcScheduler, requestOwner } = require("../lib/koin-network/rpc-scheduler");
const { PinnedRpcProvider, rpcDiagnostics } = require("../lib/koin-network/rpc-provider");
const { createRpcTransport } = require("../lib/koin-network/rpc-http");
const { retryAfterMs, retryDelayMs, backoffMs } = require("../lib/koin-network/rpc-backoff");
const CHAIN = "backoff-fixture-chain";
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const response = (request, result) => new Response(JSON.stringify({
  jsonrpc: "2.0", id: JSON.parse(request.body).id, result,
}));
function clock() {
  let now = 0, timerId = 0; const timers = new Map();
  const scheduler = new RpcScheduler({ now: () => now, random: () => 0, schedule: (callback, ms) => {
    const id = ++timerId; timers.set(id, { at: now + ms, callback }); return id;
  } });
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      const first = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      now = first[1].at; timers.delete(first[0]); first[1].callback(); await flush();
    }
    now = end; await flush();
  };
  const settle = async promise => {
    let done = false, value, error;
    promise.then(result => { value = result; done = true; }, reason => { error = reason; done = true; });
    await flush();
    for (let n = 0; !done && n < 40; n++) await advance(50);
    assert.ok(done, "A bounded mock operation must settle without a real timer");
    if (error) throw error; return value;
  };
  return { scheduler, advance, settle, now: () => now,
    provider: (urls, fetchImpl, options = {}) => new PinnedRpcProvider(urls, CHAIN, { scheduler, fetchImpl, ...options }) };
}

test("Retry-After accepts bounded seconds and strict HTTP dates without retaining upstream values", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  assert.equal(retryAfterMs("60", now), 60000);
  assert.equal(retryAfterMs(" 0 ", now), 0);
  assert.equal(retryAfterMs("9999999999", now), 300000);
  assert.equal(retryAfterMs("Tue, 10 Nov 2026 00:02:00 GMT", now), 120000);
  assert.equal(retryAfterMs("Tue, 10 Nov 2026 01:00:00 GMT", now), 300000);
  for (const value of [undefined, null, 60, ["60"], "-1", "1.5", "60, 120", "1e3", "x".repeat(129),
    "Tue, 10 Nov 2026 00:00:00 GMT", "Tue, 10 Nov 2026 00:99:00 GMT", "Mon, 10 Nov 2026 00:01:00 GMT"])
    assert.equal(retryAfterMs(value, now), null);
  assert.equal(retryDelayMs({ retryAfterMs: 300001 }), null);
  assert.equal(retryDelayMs({ headers: { get() { throw Error("secret header"); } } }), null);
  assert.equal(backoffMs(1, () => 0), 1000);
  assert.equal(backoffMs(2, () => 0), 2000);
  assert.equal(backoffMs(3, () => 1), 5000);
  assert.equal(backoffMs(32, () => 1), 30000);
  assert.equal(backoffMs(1, () => NaN), 1000);
});

test("429 cooldown is shared by clients, skips directly to pinned backup, and exposes only numeric diagnostics", async () => {
  const f = clock(), primary = "https://shared-backoff.invalid", backup = "https://shared-backup.invalid", calls = [];
  const fetchImpl = async (url, request) => {
    const method = JSON.parse(request.body).method; calls.push({ url, method });
    if (url === primary) return new Response("private upstream error", { status: 429, headers: { "Retry-After": "60" } });
    return response(request, method === "chain.get_chain_id" ? { chain_id: CHAIN } : { ok: true });
  };
  const first = f.provider([primary, backup], fetchImpl);
  assert.deepEqual(await f.settle(first.call("chain.get_head_info", {})), { ok: true });
  assert.equal(first.readGeneration, 1);
  assert.deepEqual(await f.settle(f.provider([primary, backup], fetchImpl).call("chain.get_head_info", {})), { ok: true });
  assert.equal(calls.filter(row => row.url === primary).length, 1);
  const error = await f.settle(f.provider([primary], fetchImpl).getChainId().catch(error => error));
  const [detail] = rpcDiagnostics(error);
  assert.equal(detail.kind, "cooldown"); assert.ok(detail.cooldownRemainingMs > 59000);
  assert.equal(detail.httpStatus, undefined);
  assert.ok(!JSON.stringify(detail).includes("private"));
  assert.equal(f.scheduler.stats(primary).active, 0); assert.equal(f.scheduler.stats(primary).queued, 0);
});

test("both unavailable endpoints remain quiet across new calls without blocking fallback or starting a retry loop", async () => {
  const f = clock(), urls = ["https://both-one.invalid", "https://both-two.invalid"], calls = [];
  const fetchImpl = async url => { calls.push(url); return new Response("", { status: url === urls[0] ? 429 : 503 }); };
  await assert.rejects(f.settle(f.provider(urls, fetchImpl).getChainId()), /temporarily unavailable/);
  const before = f.now();
  const error = await f.settle(f.provider(urls, fetchImpl).getChainId().catch(error => error));
  assert.equal(f.now(), before); assert.deepEqual(calls, urls);
  assert.deepEqual(rpcDiagnostics(error).map(row => row.kind), ["cooldown", "cooldown"]);
});

test("an outage rejects queued traffic while real leases stay occupied and late success cannot clear cooldown", async () => {
  const f = clock(), endpoint = "https://queued-outage.invalid", signal = new AbortController().signal;
  const a = f.scheduler.attempt(endpoint), b = f.scheduler.attempt(endpoint);
  const one = await f.scheduler.slot(endpoint, signal, requestOwner(true), a);
  const twoPromise = f.scheduler.slot(endpoint, signal, requestOwner(true), b);
  await f.advance(50); const two = await twoPromise;
  const waiting = Array.from({ length: 8 }, () => {
    const lease = f.scheduler.attempt(endpoint);
    return f.scheduler.slot(endpoint, signal, requestOwner(true), lease).then(() => { throw Error("Queued request was dispatched"); }, error => { lease.close(); return error.code; });
  });
  assert.equal(f.scheduler.stats(endpoint).queued, 8);
  a.throttle(60000); b.success();
  assert.deepEqual(await Promise.all(waiting), Array(8).fill("rpc_endpoint_cooldown"));
  assert.equal(f.scheduler.stats(endpoint).active, 2);
  assert.equal(f.scheduler.stats(endpoint).cooldownRemainingMs, 60000);
  a.close(); b.close(); one(); two();
  await f.advance(59999);
  assert.throws(() => f.scheduler.attempt(endpoint), { code: "rpc_endpoint_cooldown" });
  await f.advance(1);
  const recovery = f.scheduler.attempt(endpoint);
  assert.throws(() => f.scheduler.attempt(endpoint), { code: "rpc_endpoint_cooldown" });
  recovery.success(); recovery.close();
  const normal = f.scheduler.attempt(endpoint); normal.close();
  assert.equal(f.scheduler.stats(endpoint).cooldownRemainingMs, 0);
});

test("late concurrent Retry-After extends the incident without doubling its exponent or reopening a recovered incident", async () => {
  const f = clock(), endpoint = "https://late-throttle.invalid";
  const a = f.scheduler.attempt(endpoint), b = f.scheduler.attempt(endpoint), c = f.scheduler.attempt(endpoint);
  a.throttle(1000); await f.advance(100); b.throttle(60000);
  assert.equal(f.scheduler.stats(endpoint).cooldownRemainingMs, 60000);
  c.success(); assert.equal(f.scheduler.stats(endpoint).cooldownRemainingMs, 60000);
  await f.advance(60000); const probe = f.scheduler.attempt(endpoint); probe.throttle(null); probe.close();
  assert.equal(f.scheduler.stats(endpoint).cooldownRemainingMs, 2000, "A concurrent error did not double the exponent");
  await f.advance(2000); const recovered = f.scheduler.attempt(endpoint); recovered.success(); recovered.close();
  c.throttle(300000); assert.equal(f.scheduler.stats(endpoint).cooldownRemainingMs, 0);
  const next = f.scheduler.attempt(endpoint); next.throttle(null); next.close();
  b.throttle(300000); assert.equal(f.scheduler.stats(endpoint).cooldownRemainingMs, 1000, "Old incident cannot extend a newer outage");
  a.close(); b.close(); c.close();
});

test("recovery spans chain pinning and operation: chain-id success cannot reset repeated operation failures", async () => {
  const f = clock(), url = "https://operation-backoff.invalid", calls = []; let healthy = false;
  const fetchImpl = async (_url, request) => {
    const method = JSON.parse(request.body).method; calls.push(method);
    if (method === "chain.get_chain_id") return response(request, { chain_id: CHAIN });
    return healthy ? response(request, { ok: true }) : new Response("", { status: 503 });
  };
  const p = f.provider([url], fetchImpl);
  for (const expected of [1000, 2000, 4000]) {
    await assert.rejects(f.settle(p.call("chain.get_head_info", {})), /temporarily unavailable/);
    assert.equal(f.scheduler.stats(url).cooldownRemainingMs, expected);
    const before = calls.length;
    await assert.rejects(f.settle(p.call("chain.get_head_info", {})), /temporarily unavailable/);
    assert.equal(calls.length, before);
    await f.advance(expected);
  }
  healthy = true;
  assert.deepEqual(await f.settle(p.call("chain.get_head_info", {})), { ok: true });
  assert.equal(f.scheduler.stats(url).cooldownRemainingMs, 0); assert.equal(f.scheduler.stats(url).recovering, false);
  healthy = false;
  await assert.rejects(f.settle(p.call("chain.get_head_info", {})), /temporarily unavailable/);
  assert.equal(f.scheduler.stats(url).cooldownRemainingMs, 1000);
});

test("only one full recovery attempt runs while other clients immediately use a backup", async () => {
  const f = clock(), url = "https://single-probe.invalid", backup = "https://single-probe-backup.invalid";
  let failed = true, releaseOperation; const calls = [];
  const fetchImpl = async (endpoint, request) => {
    const method = JSON.parse(request.body).method; calls.push({ endpoint, method });
    if (endpoint === url && failed) return new Response("", { status: 503 });
    if (endpoint === url && method !== "chain.get_chain_id") await new Promise(resolve => { releaseOperation = resolve; });
    return response(request, method === "chain.get_chain_id" ? { chain_id: CHAIN } : { ok: true });
  };
  const p = f.provider([url], fetchImpl);
  await assert.rejects(f.settle(p.getChainId()), /temporarily unavailable/);
  failed = false; await f.advance(1000);
  const recovery = p.call("chain.get_head_info", {}); await flush(); await f.advance(50);
  assert.equal(typeof releaseOperation, "function");
  assert.equal(f.scheduler.stats(url).recovering, true);
  assert.deepEqual(await f.settle(f.provider([url, backup], fetchImpl).call("chain.get_head_info", {})), { ok: true });
  assert.equal(calls.filter(row => row.endpoint === url).length, 3);
  releaseOperation(); assert.deepEqual(await f.settle(recovery), { ok: true });
  assert.equal(f.scheduler.stats(url).recovering, false);
});

test("wrong-chain recovery fails closed without clearing cooldown or reaching the requested operation", async () => {
  const f = clock(), url = "https://wrong-recovery.invalid", calls = []; let throttled = true;
  const p = f.provider([url], async (_url, request) => {
    calls.push(JSON.parse(request.body).method);
    return throttled ? new Response("", { status: 429 }) : response(request, { chain_id: "other-chain" });
  });
  await assert.rejects(f.settle(p.getChainId()), /temporarily unavailable/);
  throttled = false; await f.advance(1000);
  await assert.rejects(f.settle(p.call("chain.read_contract", {})), /chain mismatch/);
  assert.equal(f.scheduler.stats(url).cooldownRemainingMs, 2000);
  assert.deepEqual(calls, ["chain.get_chain_id", "chain.get_chain_id"]);
});

test("cooldown never duplicates a broadcast and cancelled recovery stays reserved until its socket closes", async () => {
  const f = clock(), url = "https://write-cooldown.invalid", backup = "https://write-unused.invalid", calls = [];
  let mode = "throttle", closeSocket;
  const fetchImpl = async (endpoint, request) => {
    const body = JSON.parse(request.body); calls.push({ endpoint, body });
    if (mode === "stall") return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => { closeSocket = () => reject(Error("Socket closed")); }, { once: true });
    });
    return body.method === "chain.get_chain_id" ? response(request, { chain_id: CHAIN }) : new Response("", { status: 503 });
  };
  const p = f.provider([url, backup], fetchImpl), transaction = { id: "saved-envelope", signatures: ["private-fixture"] };
  await assert.rejects(f.settle(p.call("chain.submit_transaction", { broadcast: true, transaction })), /temporarily unavailable/);
  const before = calls.length;
  await assert.rejects(f.settle(p.call("chain.submit_transaction", { broadcast: true, transaction })), /temporarily unavailable/);
  assert.equal(calls.length, before);
  assert.equal(calls.filter(row => row.body.method === "chain.submit_transaction").length, 1);
  assert.ok(calls.every(row => row.endpoint === url));
  await f.advance(1000); mode = "stall";
  const controller = new AbortController();
  const cancelled = p.call("chain.submit_transaction", { broadcast: true, transaction }, { signal: controller.signal }).catch(error => error);
  await flush(); controller.abort();
  assert.equal((await cancelled).code, "koin_rpc_stopped");
  assert.equal(f.scheduler.stats(url).active, 1); assert.equal(f.scheduler.stats(url).recovering, true);
  assert.throws(() => f.scheduler.attempt(url), { code: "rpc_endpoint_cooldown" });
  closeSocket(); await flush();
  assert.equal(f.scheduler.stats(url).active, 0); assert.equal(f.scheduler.stats(url).recovering, false);
  assert.equal(f.scheduler.stats(url).cooldownRemainingMs, 2000);
  assert.equal(calls.filter(row => row.body.method === "chain.submit_transaction").length, 1);
});

test("production transport keeps only sanitized Retry-After and settles an unfinished error body after close", async () => {
  let socketClosed = false;
  const fetchImpl = createRpcTransport({ request: (_url, _options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => queueMicrotask(() => { socketClosed = true; req.emit("close"); });
    req.end = () => {
      const res = new EventEmitter(); res.statusCode = 503; res.headers = { "retry-after": "60", "x-private": "must-not-escape" };
      res.destroy = () => {};
      callback(res);
    };
    return req;
  } });
  const result = await fetchImpl("https://headers.invalid", { method: "POST", redirect: "error", body: "{}", signal: new AbortController().signal });
  assert.equal(socketClosed, true); assert.equal(result.retryAfterMs, 60000); assert.equal(result.headers, undefined);
  assert.ok(!JSON.stringify(result).includes("must-not-escape"));
});
