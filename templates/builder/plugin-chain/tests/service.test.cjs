"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create, decodeCount } = require("../plugin/service/index"), chain = require("../plugin/chain.json");
const address = "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju"; // Fixture address only; no RPC requests leave this test.
function fixture(wrongChain = false) {
  const controller = new AbortController(), data = {}, calls = [];
  let provided, removed = false;
  const api = { version: 1, plugin: { id: "test.counter" }, signal: controller.signal,
    settings: { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } },
    services: { provide(name, service) { assert.equal(name, "test.counter.counter"); provided = service; return () => { removed = true; }; } },
    network: { async fetch(url, options) {
      assert.equal(url, chain.rpc); options.signal.throwIfAborted();
      const request = JSON.parse(options.body); calls.push(request);
      const result = request.method === "chain.get_chain_id" ? { chain_id: wrongChain ? "wrong" : chain.chainId } : { result: "CAc" };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    } },
  };
  const service = create(api);
  return { service, controller, calls, provided, removed: () => removed };
}
test("counter reads require a configured address and a matching chain", async () => {
  const f = fixture();
  await assert.rejects(f.service.call("counter.read", {}), /deploy/); assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.call("counter.configure", { address: "invalid" }), /valid/);
  await f.service.call("counter.configure", { address });
  assert.equal((await f.service.call("counter.read", {})).count, 7);
  assert.deepEqual(f.calls.map(r => r.method), ["chain.get_chain_id", "chain.read_contract"]);
  assert.equal(f.calls[1].params.entry_point, 1014409297);
  assert.throws(() => f.provided.call("read", {}, { remote: true, signal: f.controller.signal }), /local/);
  f.service.dispose(); assert.equal(f.removed(), true);
  await assert.rejects(f.service.call("counter.read", {}), /stopped/);
  const wrong = fixture(true); await wrong.service.call("counter.configure", { address });
  await assert.rejects(wrong.service.call("counter.read", {}), /different chain/);
  assert.equal(wrong.calls.length, 1); wrong.service.dispose();
});
test("malformed or overflowing counter data is not reported as a successful read", () => {
  assert.equal(decodeCount(""), 0); assert.equal(decodeCount("CAc"), 7);
  assert.equal(decodeCount(Buffer.from([8,255,255,255,255,15]).toString("base64url")), 4294967295);
  for (const value of [null, "!", "CgE", "CIA", Buffer.from([8,255,255,255,255,31]).toString("base64url")]) assert.throws(() => decodeCount(value));
});
