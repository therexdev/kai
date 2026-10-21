"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { V4HistoryReader, CONTRACTS, SELECTOR } = require("../lib/koin-network/v4-history-reader"), { validate } = require("../lib/koin-network/v4-price-validation"), { MARKET } = require("../lib/koin-network/purchase-price");
const hex = n => "0x" + n.toString(16), hash = n => "0x" + n.toString(16).padStart(64, "0"), abi = values => "0x" + values.map(n => BigInt(n).toString(16).padStart(64, "0")).join("");
async function fixture(t) {
  const now = 1800000000000, end = now / 1000, feed = "0x" + "3".repeat(40), calls = [], flags = {};
  const policy = { version: 1, windowSeconds: 60, maxBlockGapSeconds: 12, maxPriceAgeMs: 30000, maxQuoteMs: 20000,
    maxDeviationBps: 100, maxSlippageBps: 100, maxUsdtAgeMs: 20000, maxUsdtDeviationBps: 100, maxParityAgeMs: 20000, maxParityDeviationBps: 100,
    minLiquidity: "1000000000", minProbeUsdtAtoms: "1000000", usdtSource: "ethereum:chainlink:" + feed, paritySource: "isolated:reviewed-parity" };
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const q = JSON.parse(body); calls.push(q); let result;
    if (q.method === "eth_chainId") result = flags.wrongChain ? "0x2" : "0x1";
    else if (/^eth_getBlockBy/.test(q.method)) {
      const n = q.params[0] === "finalized" ? 7 : Number(BigInt(q.params[0]));
      result = { number: hex(n), timestamp: hex(end - 70 + n * 10), hash: hash(flags.reorg && q.method === "eth_getBlockByNumber" && q.params[0] !== "finalized" ? 999 : n), parentHash: hash(n - 1) };
    } else if (q.method === "eth_call") {
      const [{ to, data }, anchor] = q.params;
      assert.equal(anchor.requireCanonical, true); assert.match(anchor.blockHash, /^0x[0-9a-f]{64}$/);
      const selector = data.slice(0, 10);
      if (selector === SELECTOR.manager) result = abi([CONTRACTS.manager]);
      else if (selector === SELECTOR.decimals) result = abi([to === MARKET.quoteToken ? 6 : 8]);
      else if (selector === SELECTOR.slot) { assert.equal(data.slice(10), MARKET.poolId.slice(2)); result = abi([1n << 96n, 0, 0, 10000]); }
      else if (selector === SELECTOR.liquidity) result = abi([10n ** 20n]);
      else if (selector === SELECTOR.quote) {
        const w = Array.from({ length: 10 }, (_, i) => BigInt("0x" + data.slice(10 + i * 64, 74 + i * 64)));
        assert.equal(w[0], 32n); assert.equal(w[1], BigInt(MARKET.wrappedToken)); assert.equal(w[2], BigInt(MARKET.quoteToken));
        assert.equal(w[3], 10000n); assert.equal(w[4], 200n); assert.equal(w[5], 0n); assert.ok(w[6] === 0n || w[6] === 1n); assert.equal(w[8], 256n); assert.equal(w[9], 0n);
        result = abi([w[7] * 99n / 100n, 100000]);
      } else if (selector === SELECTOR.round) result = abi([1, 100000000, end - 10, end - 10, flags.oldRound ? 0 : 1]);
      else throw Error("Unexpected call selector");
    } else throw Error("A non-read method was attempted");
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const reader = new V4HistoryReader({ rpcUrl: "http://127.0.0.1:" + server.address().port, mode: "isolated-rehearsal", clock: () => now });
  return { now, feed, policy, reader, calls, flags };
}
test("real loopback archive transport reads every canonical v4 block and executable bid/ask depth", async t => {
  const f = await fixture(t), history = await f.reader.window(f.policy), anchor = history.blocks.at(-1);
  const usdt = await f.reader.usdt({ feed: f.feed, source: f.policy.usdtSource, policy: f.policy, anchor });
  const parity = { source: f.policy.paritySource, evidenceHash: hash(100), observedAt: f.now - 1000, validUntil: f.now + 10000,
    wrappedPerNativeAtoms: "100000000", state: "verified", nativeToken: "KOIN", wrappedToken: MARKET.wrappedToken };
  const quote = validate({ policy: f.policy, history, usdt, parity, now: f.now });
  assert.deepEqual(require("../lib/koin-network/v4-history-reader").usdtObservation(usdt.observation, { feed: f.feed, source: f.policy.usdtSource, policy: f.policy, anchor }), usdt);
  const altered = structuredClone(usdt.observation); altered.decimals = abi([7]);
  const changed = require("../lib/koin-network/v4-history-reader").usdtObservation(altered, { feed: f.feed, source: f.policy.usdtSource, policy: f.policy, anchor });
  assert.notEqual(changed.evidenceHash, usdt.evidenceHash); assert.notEqual(changed.usdAtoms, usdt.usdAtoms);
  assert.equal(quote.usdPerKoin, "10000000000"); assert.equal(history.blocks.length, 7);
  assert.equal(f.calls.filter(c => c.method === "eth_call" && c.params[0].data.startsWith(SELECTOR.quote)).length, 14);
  assert.equal(f.calls.some(c => /send|sign|observe/i.test(c.method)), false);
});
test("archive reader refuses a reorg, wrong chain, and incomplete stablecoin oracle round", async t => {
  const f = await fixture(t); f.flags.wrongChain = true; await assert.rejects(f.reader.window(f.policy), /mainnet/);
  f.flags.wrongChain = false; f.flags.reorg = true; await assert.rejects(f.reader.window(f.policy), /reorganized/);
  f.flags.reorg = false; const h = await f.reader.window(f.policy); f.flags.oldRound = true;
  await assert.rejects(f.reader.usdt({ feed: f.feed, source: f.policy.usdtSource, policy: f.policy, anchor: h.blocks.at(-1) }), /oracle round/);
});
test("archive requests cannot sign or send, follow redirects, or silently use an insecure remote", async () => {
  assert.throws(() => new V4HistoryReader({ rpcUrl: "http://remote.example" }), /HTTPS/);
  const r = new V4HistoryReader({ rpcUrl: "https://archive.example", fetchImpl: async (_url, request) => { assert.equal(request.redirect, "error"); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: "0x1" })); } });
  await assert.rejects(r.rpc("eth_sendRawTransaction", []), /Read-only/);
  await assert.rejects(r.rpc("eth_chainId", []), /rejected/);
});
