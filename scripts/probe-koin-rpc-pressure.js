"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { PinnedRpcProvider } = require("../lib/koin-network/rpc-provider");
const chainId = "pinned-fixture-chain";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = (request, result) => new Response(JSON.stringify({
  jsonrpc: "2.0", id: JSON.parse(request.body).id, result,
}));
function make(url, fetchImpl, options = {}) {
  return new PinnedRpcProvider([url], chainId, { fetchImpl, ...options });
}
test("reward-sized parallel reads across clients fit the public node's pressure limits", async () => {
  let active = 0, peak = 0; const starts = [], calls = [];
  const fetchImpl = async (_url, request) => {
    starts.push(performance.now()); calls.push(JSON.parse(request.body).method);
    active++; peak = Math.max(peak, active);
    const recent = starts.filter(at => at > performance.now() - 1000).length;
    if (active > 4 || recent > 30) { active--; return new Response("busy", { status: 503 }); }
    await pause(65);
    active--;
    return reply(request, JSON.parse(request.body).method === "chain.get_chain_id" ? { chain_id: chainId } : { ok: true });
  };
  const clients = [make("https://pressure.invalid", fetchImpl), make("https://pressure.invalid", fetchImpl)];
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => clients[i % 2].call("chain.read_contract", {})));
  assert.equal(results.length, 12); assert.ok(results.every(r => r.ok));
  assert.ok(peak <= 2); assert.equal(calls.filter(m => m === "chain.get_chain_id").length, 12);
  assert.equal(calls.filter(m => m === "chain.read_contract").length, 12);
  for (const start of starts) assert.ok(starts.filter(at => at >= start && at < start + 1000).length <= 21);
});
test("the budget includes response bodies, not only HTTP response headers", async () => {
  let active = 0, peak = 0;
  const p = make("https://body.invalid", async (_url, request) => {
    active++; peak = Math.max(peak, active);
    return { ok: true, async text() {
      await pause(90); active--;
      return JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(request.body).id, result: { chain_id: chainId } });
    } };
  });
  await Promise.all(Array.from({ length: 8 }, () => p.getChainId()));
  assert.ok(peak <= 2);
});
test("queued cancellation and deadlines never issue an HTTP request later", async () => {
  let started = 0; const release = [];
  const fetchImpl = async (_url, request) => {
    started++; await new Promise(resolve => release.push(resolve));
    return reply(request, { chain_id: chainId });
  };
  const url = "https://cancel-queue.invalid", p = make(url, fetchImpl);
  const holders = [p.getChainId(), p.getChainId()];
  while (started < 2) await pause(5);
  const controller = new AbortController();
  const cancelled = p.call("chain.submit_transaction", { broadcast: true, transaction: { id: "saved" } }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /stopped/);
  const short = make(url, fetchImpl, { timeoutMs: 30, attemptTimeoutMs: 30 });
  await assert.rejects(short.getChainId(), /temporarily unavailable/);
  release.forEach(resolve => resolve()); await Promise.all(holders); await pause(100);
  assert.equal(started, 2);
});
test("reads retain pinned fallback and broadcasts still have exactly one attempt", async () => {
  const seen = [], urls = ["https://fallback-one.invalid", "https://fallback-two.invalid"];
  const p = new PinnedRpcProvider(urls, chainId, { fetchImpl: async (url, request) => {
    const method = JSON.parse(request.body).method; seen.push({ url, method });
    if (url === urls[0]) return new Response("busy", { status: 503 });
    return reply(request, method === "chain.get_chain_id" ? { chain_id: chainId } : { ok: true });
  } });
  assert.deepEqual(await p.call("chain.get_head_info", {}), { ok: true });
  assert.deepEqual(seen.map(r => r.url), [urls[0], urls[1], urls[1]]);
  let broadcasts = 0;
  const q = new PinnedRpcProvider(["https://send-one.invalid", "https://send-two.invalid"], chainId, { fetchImpl: async (_url, request) => {
    if (JSON.parse(request.body).method === "chain.get_chain_id") return reply(request, { chain_id: chainId });
    broadcasts++; return new Response("unknown", { status: 503 });
  } });
  await assert.rejects(q.call("chain.submit_transaction", { broadcast: true }), /temporarily unavailable/);
  assert.equal(broadcasts, 1);
});
test("a wrong chain is still rejected before the requested operation", async () => {
  const seen = [], p = make("https://wrong-chain.invalid", async (_url, request) => {
    seen.push(JSON.parse(request.body).method); return reply(request, { chain_id: "other" });
  });
  await assert.rejects(p.call("chain.read_contract", {}), /chain mismatch/);
  assert.deepEqual(seen, ["chain.get_chain_id"]);
});
