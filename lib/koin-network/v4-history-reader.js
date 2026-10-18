"use strict";
const crypto = require("node:crypto"), { MARKET } = require("./purchase-price"), V = require("./v4-price-validation");
// Ethereum mainnet addresses from the official v4 deployment registry.
const CONTRACTS = Object.freeze({ manager: "0x000000000004444c5dc75cb358380d2e3de08a90", view: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227", quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203" });
const SELECTOR = Object.freeze({ slot: "0xc815641c", liquidity: "0xfa6793d5", manager: "0xdc4c90d3", decimals: "0x313ce567", round: "0xfeaf968c", quote: "0xaa9d21cb" });
const HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
function word(n) { n = BigInt(n); if (n < 0n || n >= 1n << 256n) throw Error("ABI word outside uint256"); return n.toString(16).padStart(64, "0"); }
function words(value, count) {
  if (typeof value !== "string" || !new RegExp("^0x[0-9a-fA-F]{" + count * 64 + "}$").test(value)) throw Error("Unexpected Ethereum ABI response");
  return Array.from({ length: count }, (_, i) => BigInt("0x" + value.slice(2 + i * 64, 66 + i * 64)));
}
function quantity(value) {
  if (typeof value !== "string" || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value)) throw Error("Canonical Ethereum quantity required");
  const n = Number(BigInt(value)); if (!Number.isSafeInteger(n) || n < 0) throw Error("Ethereum quantity outside safe range"); return n;
}
function block(raw) {
  if (!raw || !HASH.test(raw.hash) || !HASH.test(raw.parentHash)) throw Error("Ethereum block hash required");
  return { number: quantity(raw.number), timestamp: quantity(raw.timestamp), hash: raw.hash, parentHash: raw.parentHash };
}
function quoteData(zeroForOne, amount) {
  amount = BigInt(amount); if (amount <= 0n || amount >= 1n << 128n) throw Error("v4 depth probe outside uint128");
  // One dynamic tuple: PoolKey (five words), direction, input, bytes offset,
  // followed by empty hookData. This is v4 quoteExactInputSingle, not v3 ABI.
  return SELECTOR.quote + [32n, BigInt(MARKET.wrappedToken), BigInt(MARKET.quoteToken), 10000n, 200n, 0n, zeroForOne ? 1n : 0n, amount, 256n, 0n].map(word).join("");
}
const evidenceHash = value => "0x" + crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
class V4HistoryReader {
  constructor({ rpcUrl, mode, fetchImpl = fetch, clock = Date.now, timeoutMs = 8000 }) {
    const url = new URL(rpcUrl), local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(mode === "isolated-rehearsal" && local && url.protocol === "http:"))) throw Error("HTTPS archive RPC required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error("Bounded RPC timeout required");
    Object.assign(this, { url: url.href, fetch: fetchImpl, clock, timeoutMs }); this.nextId = 0;
  }
  async rpc(method, params, signal) {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_call", "eth_getCode"].includes(method)) throw Error("Read-only Ethereum method required");
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    deadline.throwIfAborted(); const id = ++this.nextId;
    const response = await this.fetch(this.url, { method: "POST", redirect: "error", signal: deadline, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (!response.ok) throw Error("Archive RPC unavailable");
    const chunks = []; let bytes = 0;
    for await (const part of response.body) { deadline.throwIfAborted(); bytes += part.length; if (bytes > 2097152) throw Error("Archive RPC response too large"); chunks.push(part); }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (data.jsonrpc !== "2.0" || data.id !== id || data.error || !Object.hasOwn(data, "result")) throw Error("Archive RPC rejected canonical history request");
    return data.result;
  }
  call(to, data, hash, signal) { if (!HASH.test(hash)) throw Error("Canonical block hash required"); return this.rpc("eth_call", [{ to, data }, { blockHash: hash, requireCanonical: true }], signal); }
  async market(hash, signal) {
    const values = await Promise.all([this.call(CONTRACTS.view, SELECTOR.manager, hash, signal), this.call(CONTRACTS.quoter, SELECTOR.manager, hash, signal),
      this.call(MARKET.wrappedToken, SELECTOR.decimals, hash, signal), this.call(MARKET.quoteToken, SELECTOR.decimals, hash, signal)]);
    if (words(values[0], 1)[0] !== BigInt(CONTRACTS.manager) || words(values[1], 1)[0] !== BigInt(CONTRACTS.manager) || words(values[2], 1)[0] !== 8n || words(values[3], 1)[0] !== 6n) throw Error("v4 deployment or token decimals mismatch");
  }
  async observation(b, probeUsdtAtoms, signal) {
    const pool = MARKET.poolId.slice(2), [slot, liquidity] = await Promise.all([this.call(CONTRACTS.view, SELECTOR.slot + pool, b.hash, signal), this.call(CONTRACTS.view, SELECTOR.liquidity + pool, b.hash, signal)]);
    const state = words(slot, 4), active = words(liquidity, 1)[0];
    if (state[0] <= 0n || state[0] >= 1n << 160n || state[3] !== 10000n || active <= 0n || active >= 1n << 128n) throw Error("Unexpected v4 pool state");
    const spot = V.price(String(state[0])), sellInput = (BigInt(probeUsdtAtoms) * 100n * V.SCALE + spot - 1n) / spot;
    const [buy, sell] = await Promise.all([this.call(CONTRACTS.quoter, quoteData(false, probeUsdtAtoms), b.hash, signal), this.call(CONTRACTS.quoter, quoteData(true, sellInput), b.hash, signal)]);
    return { ...b, canonical: true, stateBlockHash: b.hash, depthBlockHash: b.hash, sqrtPriceX96: String(state[0]), liquidity: String(active),
      probeUsdtAtoms, buyVkoinAtoms: String(words(buy, 2)[0]), sellVkoinAtoms: String(sellInput), sellUsdtAtoms: String(words(sell, 2)[0]) };
  }
  async window(policy, signal) {
    const p = V.config(policy), deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    if (await this.rpc("eth_chainId", [], deadline) !== "0x1") throw Error("Ethereum mainnet history required");
    const end = block(await this.rpc("eth_getBlockByNumber", ["finalized", false], deadline));
    if (end.timestamp * 1000 > this.clock() || this.clock() - end.timestamp * 1000 > p.maxPriceAgeMs) throw Error("Finalized Ethereum anchor is stale");
    await this.market(end.hash, deadline);
    const blocks = [end], start = end.timestamp - p.windowSeconds;
    while (blocks.at(-1).timestamp > start) {
      if (blocks.length >= 8192) throw Error("History exceeds bounded window");
      const last = blocks.at(-1), previous = block(await this.rpc("eth_getBlockByHash", [last.parentHash, false], deadline));
      if (previous.hash !== last.parentHash || previous.number !== last.number - 1 || previous.timestamp >= last.timestamp) throw Error("Archive history fork or gap");
      blocks.push(previous);
    }
    blocks.reverse(); const observations = [];
    for (let i = 0; i < blocks.length; i += 4) observations.push(...await Promise.all(blocks.slice(i, i + 4).map(b => this.observation(b, p.minProbeUsdtAtoms, deadline))));
    await this.canonical(end, deadline);
    return { chainId: 1, protocol: "uniswap-v4", poolId: MARKET.poolId, currency0: MARKET.wrappedToken, currency1: MARKET.quoteToken,
      decimals0: 8, decimals1: 6, fee: 10000, tickSpacing: 200, hooks: "0x" + "0".repeat(40), canonical: true, anchorHash: end.hash, blocks: observations };
  }
  async canonical(anchor, signal) {
    const current = block(await this.rpc("eth_getBlockByNumber", ["0x" + anchor.number.toString(16), false], signal));
    if (current.hash !== anchor.hash || current.timestamp !== anchor.timestamp) throw Error("Ethereum anchor reorganized");
  }
  async usdt({ feed, source, policy, anchor, signal }) {
    if (typeof feed !== "string" || !ADDRESS.test(feed) || source !== "ethereum:chainlink:" + feed) throw Error("Explicit reviewed USDT/USD feed required");
    const p = V.config(policy), [decimals, round] = await Promise.all([this.call(feed, SELECTOR.decimals, anchor.hash, signal), this.call(feed, SELECTOR.round, anchor.hash, signal)]);
    const d = words(decimals, 1)[0], r = words(round, 5);
    if (d > 18n || r[0] === 0n || r[1] === 0n || r[1] >= 1n << 255n || r[2] === 0n || r[3] < r[2] || r[3] > BigInt(anchor.timestamp) || r[4] < r[0]) throw Error("Invalid USDT/USD oracle round");
    const observedAt = Number(r[3]) * 1000;
    if (!Number.isSafeInteger(observedAt)) throw Error("Invalid USDT/USD round timestamp");
    const usdAtoms = d <= 8n ? r[1] * 10n ** (8n - d) : r[1] / 10n ** (d - 8n);
    return { source, evidenceHash: evidenceHash({ feed, anchorHash: anchor.hash, round }), usdAtoms: String(usdAtoms), observedAt, validUntil: observedAt + p.maxUsdtAgeMs };
  }
}
module.exports = { V4HistoryReader, CONTRACTS, SELECTOR, quoteData, words, evidenceHash };
