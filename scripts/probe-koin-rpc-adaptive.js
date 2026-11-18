"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { RpcScheduler, readScope } = require("../lib/koin-network/rpc-scheduler");
const { PinnedRpcProvider, rpcDiagnostics } = require("../lib/koin-network/rpc-provider");
const { SharedPins } = require("../lib/koin-network/rpc-shared-pin");
const Gateway = require("../lib/koin-network/rpc-gateway-diagnostics");
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
    for (let n = 0; !done && n < 200; n++) await advance(50);
    assert.ok(done, "A bounded mock operation must settle without a real timer");
    if (error) throw error; return value;
  };
  return { scheduler, advance, settle, now: () => now,
    provider: (urls, fetchImpl, options = {}) => new PinnedRpcProvider(urls, CHAIN, { scheduler, fetchImpl, ...options }) };
}

test("overlapping owner reads share one pin, but every financial observation is fresh", async () => {
  const f = clock(), calls = [], url = "https://shared-pin.invalid";
  const p = f.provider([url], async (_url, request) => {
    const body = JSON.parse(request.body); calls.push(body);
    return response(request, body.method === "chain.get_chain_id" ? { chain_id: CHAIN } : { observation: calls.length });
  });
  const methods = ["chain.get_account_rc", "chain.get_account_nonce", "chain.read_contract", "chain.get_head_info",
    "transaction_store.get_transactions_by_id"];
  for (let round = 0; round < 2; round++) {
    const results = await f.settle(readScope("background", () => Promise.all(methods.map(method => p.call(method, {})))));
    assert.equal(new Set(results.map(r => r.observation)).size, methods.length);
    assert.equal(calls.filter(c => c.method === "chain.get_chain_id").length, round + 1);
    for (const method of methods) assert.equal(calls.filter(c => c.method === method).length, round + 1);
  }
  await f.settle(Promise.all([p.getChainId(), p.getChainId()]));
  assert.equal(calls.filter(c => c.method === "chain.get_chain_id").length, 4, "Independent owners do not share");
  assert.equal(f.scheduler.stats(url).active, 0);
});

test("sharing never spans providers, chain pin lifetimes, or transaction simulations", async () => {
  const f = clock(), url = "https://pin-isolation.invalid", calls = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body); calls.push(body.method);
    return response(request, body.method === "chain.get_chain_id" ? { chain_id: CHAIN } : { ok: true });
  };
  const a = f.provider([url], fetchImpl), b = f.provider([url], fetchImpl);
  await f.settle(readScope("background", async () => {
    await Promise.all([a.getChainId(), b.getChainId()]);
    await a.getChainId();
    await Promise.all([a.call("chain.submit_transaction", { broadcast: false }), a.call("chain.submit_transaction", { broadcast: false })]);
  }));
  assert.equal(calls.filter(m => m === "chain.get_chain_id").length, 5);
  assert.equal(calls.filter(m => m === "chain.submit_transaction").length, 2);
});

test("wrong shared chain stops all operations; failed primary pins are rechecked on backup", async () => {
  for (const wrong of [true, false]) {
    const f = clock(), urls = ["https://pin-primary.invalid", "https://pin-backup.invalid"], calls = [];
    const p = f.provider(urls, async (url, request) => {
      const body = JSON.parse(request.body); calls.push([url, body.method]);
      if (url === urls[0] && !wrong) return new Response("", { status: 503 });
      return response(request, body.method === "chain.get_chain_id" ? { chain_id: wrong ? "wrong" : CHAIN } : { ok: true });
    });
    const work = readScope("background", () => Promise.allSettled(Array.from({ length: 4 }, () => p.call("chain.read_contract", {}))));
    const results = await f.settle(work);
    assert.equal(calls.filter(([url]) => url === urls[0]).length, 1);
    if (wrong) {
      assert.ok(results.every(r => r.status === "rejected" && r.reason.code === "koin_rpc_chain_mismatch"));
      assert.equal(calls.length, 1);
    } else {
      assert.ok(results.every(r => r.status === "fulfilled"));
      assert.equal(calls.filter(([url, method]) => url === urls[1] && method === "chain.get_chain_id").length, 1);
      assert.equal(calls.filter(([, method]) => method === "chain.read_contract").length, 4);
    }
  }
});

test("cancelling the originating subscriber keeps the shared physical pin alive for its sibling", async () => {
  const f = clock(), url = "https://pin-cancel.invalid", controller = new AbortController();
  let finishPin, pinSignal; const calls = [];
  const p = f.provider([url], async (_url, request) => {
    const body = JSON.parse(request.body); calls.push(body.method);
    if (body.method === "chain.get_chain_id") {
      pinSignal = request.signal; await new Promise(resolve => { finishPin = resolve; });
    }
    return response(request, body.method === "chain.get_chain_id" ? { chain_id: CHAIN } : { ok: true });
  });
  const pair = readScope("background", () => [
    p.call("chain.read_contract", {}, { signal: controller.signal }).catch(e => e),
    p.call("chain.read_contract", {}),
  ]);
  await flush(); controller.abort();
  assert.equal((await pair[0]).code, "koin_rpc_stopped");
  assert.equal(pinSignal.aborted, false); assert.equal(f.scheduler.stats(url).active, 1);
  finishPin(); assert.deepEqual(await f.settle(pair[1]), { ok: true });
  assert.deepEqual(calls, ["chain.get_chain_id", "chain.read_contract"]);
  assert.equal(f.scheduler.stats(url).active, 0);
});

test("all subscribers cancelling holds the socket slot until close and sends no late operation", async () => {
  const f = clock(), url = "https://pin-all-cancel.invalid", controller = new AbortController();
  let close, pinSignal, calls = 0;
  const p = f.provider([url], async (_url, request) => {
    calls++; pinSignal = request.signal;
    return new Promise((_resolve, reject) => { close = () => reject(Error("closed")); });
  });
  const work = readScope("background", () => Promise.allSettled([1, 2, 3].map(() =>
    p.call("chain.read_contract", {}, { signal: controller.signal }))));
  await flush(); controller.abort();
  assert.ok((await work).every(r => r.status === "rejected" && r.reason.code === "koin_rpc_stopped"));
  assert.equal(pinSignal.aborted, true); assert.equal(f.scheduler.stats(url).active, 1);
  close(); await flush(); await f.advance(1000);
  assert.equal(calls, 1); assert.equal(f.scheduler.stats(url).active, 0); assert.equal(f.scheduler.stats(url).queued, 0);
});

test("a queued shared pin survives its original caller cancelling without closing that caller's lease early", async () => {
  const f = clock(), url = "https://queued-shared-pin.invalid", controller = new AbortController(), releases = [];
  let calls = 0;
  const p = f.provider([url], async (_url, request) => {
    const body = JSON.parse(request.body); calls++;
    if (calls <= 2) await new Promise(resolve => releases.push(resolve));
    return response(request, body.method === "chain.get_chain_id" ? { chain_id: CHAIN } : { ok: true });
  });
  const holders = [p.getChainId(), p.getChainId()]; await flush(); await f.advance(50);
  assert.equal(releases.length, 2);
  const pair = readScope("background", () => [
    p.call("chain.read_contract", {}, { signal: controller.signal }).catch(e => e), p.call("chain.read_contract", {}),
  ]);
  await flush(); assert.equal(f.scheduler.stats(url).queued, 1);
  controller.abort(); assert.equal((await pair[0]).code, "koin_rpc_stopped");
  assert.equal(f.scheduler.stats(url).queued, 1);
  releases.forEach(resolve => resolve()); await f.settle(Promise.all(holders));
  assert.deepEqual(await f.settle(pair[1]), { ok: true });
  assert.equal(calls, 4); assert.equal(f.scheduler.stats(url).active, 0);
});

test("shared pin subscribers stay bounded and receive detached values and errors", async () => {
  const pins = new SharedPins(), owner = {}, controller = new AbortController(); let finish;
  const start = () => new Promise(resolve => { finish = resolve; });
  const join = () => pins.join(owner, "endpoint", controller.signal, start, () => Error("stopped"), e => new Error(e.message));
  const joined = Array.from({ length: 16 }, join);
  assert.throws(join, { code: "rpc_queue_full" }); await flush(); finish({ chain_id: CHAIN, nested: {} });
  const results = await Promise.all(joined.map(p => p.result)); results[0].nested.changed = true;
  assert.equal(results[1].nested.changed, undefined);
  let fail;
  const bad = () => pins.join(owner, "endpoint", controller.signal, () => new Promise((_r, reject) => { fail = reject; }),
    () => Error("stopped"), e => new Error(e.message));
  const a = bad().result.catch(e => e), b = bad().result.catch(e => e); await flush(); fail(Error("same failure"));
  assert.notEqual(await a, await b);
});

test("recovery keeps slower pacing and requires both sustained time and successes before speeding up", async () => {
  const f = clock(), url = "https://adaptive.invalid", s = f.scheduler;
  const first = s.attempt(url), concurrent = s.attempt(url); first.throttle(1000); concurrent.throttle(2000);
  assert.equal(s.stats(url).requestIntervalMs, 200);
  await f.advance(2000); const probe = s.attempt(url); probe.success(); probe.close();
  const succeed = () => { const lease = s.attempt(url); lease.success(); lease.success(); lease.close(); };
  for (let n = 0; n < 30; n++) succeed();
  assert.equal(s.stats(url).requestIntervalMs, 200, "A burst of successes is insufficient");
  await f.advance(30000); succeed(); assert.equal(s.stats(url).requestIntervalMs, 160);
  await f.advance(30000); for (let n = 0; n < 19; n++) succeed();
  assert.equal(s.stats(url).requestIntervalMs, 160, "Time alone and duplicate successes are insufficient");
  succeed(); assert.equal(s.stats(url).requestIntervalMs, 128);
  for (let n = 0; n < 10; n++) {
    const lease = s.attempt(url); lease.throttle(null); lease.close();
    await f.advance(s.stats(url).cooldownRemainingMs);
  }
  assert.equal(s.stats(url).requestIntervalMs, 1000);
  const recovered = s.attempt(url); recovered.success(); recovered.close();
  for (let n = 0; n < 20; n++) { await f.advance(30000); for (let i = 0; i < 20; i++) succeed(); }
  assert.equal(s.stats(url).requestIntervalMs, 50, "Recovery never exceeds the original rate");
  first.close(); concurrent.close();
});

test("adaptive interval spaces real scheduler starts after successful recovery", async () => {
  const f = clock(), url = "https://adaptive-spacing.invalid", calls = []; let throttle = true;
  const p = f.provider([url], async (_url, request) => {
    calls.push(f.now()); const body = JSON.parse(request.body);
    return throttle ? new Response("", { status: 429 }) : response(request, body.method === "chain.get_chain_id" ? { chain_id: CHAIN } : {});
  });
  await assert.rejects(f.settle(p.getChainId())); throttle = false; await f.advance(1000);
  await f.settle(p.call("chain.get_head_info", {}));
  await f.settle(p.call("chain.get_head_info", {}));
  assert.deepEqual(calls.slice(1), [1000, 1200, 1400, 1600]);
});

test("only exact gateway error categories enter diagnostics, never arbitrary upstream text", async () => {
  const cases = [[-32005, "RPC rate limit", "rate_limit"], [-32005, "API busy", "busy"],
    [-32001, "Local Mainnet RPC is not ready", "node_not_ready"],
    [-32002, "Local RPC unavailable or response exceeded limits", "node_unavailable"],
    [-32002, "RPC request cancelled", "cancelled"],
    [-32002, "Contract metadata unavailable; retry or use another RPC", "metadata_unavailable"]];
  for (const [code, message, reason] of cases) {
    const f = clock(), url = "https://gateway-diagnostic.invalid/private?secret=hidden";
    const p = f.provider([url], async (_url, request) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(request.body).id,
      error: { code, message, data: "private-signature" } }), { status: 503, headers: { "Content-Type": "application/json" } }));
    const error = await f.settle(p.getChainId().catch(e => e)); const [row] = rpcDiagnostics(error);
    assert.equal(row.gatewayReason, reason); assert.equal(row.rpcCode, code); assert.equal(row.requestIntervalMs, 200);
    assert.equal(row.endpoint, "https://gateway-diagnostic.invalid");
    assert.doesNotMatch(JSON.stringify(row), /private|secret|hidden|Local|RPC rate/);
  }
  const good = { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "RPC rate limit" } };
  for (const bad of ["{", "private".repeat(2000), JSON.stringify({ ...good, id: 2 }), JSON.stringify({ ...good, result: {} }),
    JSON.stringify({ ...good, error: { code: -1, message: good.error.message } }),
    JSON.stringify({ ...good, error: { code: -32005, message: "RPC rate limit private-signature" } })]) assert.deepEqual(Gateway.classify(bad, 1), {});
  assert.equal(Gateway.classify(JSON.stringify({ ...good, id: null }), 1).gatewayReason, "rate_limit");
});

test("injected gateway streams are bounded, reject locked bodies safely, and await cancellation", async () => {
  let finishCancel, cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193)); },
    cancel() { cancelled = true; return new Promise(resolve => { finishCancel = resolve; }); } });
  const response = new Response(stream, { status: 503, headers: { "Content-Type": "application/json" } });
  let settled = false;
  const pending = Gateway.read(response, 1, new AbortController().signal).then(value => { settled = true; return value; });
  await flush(); assert.equal(cancelled, true); assert.equal(settled, false);
  finishCancel(); assert.deepEqual(await pending, {});
  const locked = new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }), reader = locked.body.getReader();
  assert.deepEqual(await Gateway.read(locked, 1), {}); await reader.cancel(); reader.releaseLock();
});
