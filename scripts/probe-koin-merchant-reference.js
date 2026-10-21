"use strict";
// Synthetic archive observations exercise the explicit merchant convention.
// Nothing signs a parity claim, accesses a wallet, or reaches a live RPC.
const test = require("node:test"), assert = require("node:assert/strict"), { Signer } = require("koilib");
const V = require("../lib/koin-network/v4-price-validation"), { configuration, V4PurchaseOracle } = require("../lib/koin-network/v4-purchase-oracle");
const { MARKET, purchasePrice, assertPurchaseSize } = require("../lib/koin-network/purchase-price");
const { MAINNET_CHAIN, MAINNET_TOKEN } = require("../lib/koin-network/payment-network");
const hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
function fixture() {
  const now = 1800000000000, feed = "0x" + "3".repeat(40);
  const deployment = { product: "prepaid-usd-v1", chainId: MAINNET_CHAIN, token: MAINNET_TOKEN };
  const reference = { kind: "merchant-exchange-reference", nativeChainId: deployment.chainId, nativeToken: deployment.token,
    wrappedChainId: 1, wrappedToken: MARKET.wrappedToken, wrappedPerNativeAtoms: "100000000" };
  const policy = { version: 2, windowSeconds: 60, maxBlockGapSeconds: 12, maxPriceAgeMs: 30000, maxQuoteMs: 20000,
    maxDeviationBps: 100, maxSlippageBps: 100, maxUsdtAgeMs: 20000, maxUsdtDeviationBps: 100,
    minLiquidity: "1000000000", minProbeUsdtAtoms: "1000000", usdtSource: "ethereum:chainlink:" + feed };
  const config = { schema: 2, rpcUrls: ["https://archive-a.invalid", "https://archive-b.invalid"], usdtFeed: feed, reference, policy };
  const blocks = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, hash: hash(i + 1), parentHash: hash(i), timestamp: now / 1000 - 60 + i * 10,
    canonical: true, stateBlockHash: hash(i + 1), depthBlockHash: hash(i + 1), sqrtPriceX96: String(1n << 96n), liquidity: "1000000000000",
    probeUsdtAtoms: "1000000", buyVkoinAtoms: "990000", sellVkoinAtoms: "1000000", sellUsdtAtoms: "990000" }));
  const history = { chainId: 1, protocol: "uniswap-v4", poolId: MARKET.poolId, currency0: MARKET.wrappedToken, currency1: MARKET.quoteToken,
    decimals0: 8, decimals1: 6, fee: 10000, tickSpacing: 200, hooks: "0x" + "0".repeat(40), canonical: true, anchorHash: hash(7), blocks };
  const usdt = { source: policy.usdtSource, evidenceHash: hash(100), observedAt: now - 1000, validUntil: now + 15000, usdAtoms: "100000000" };
  return { now, config, reference, policy, deployment, history, usdt };
}
function oracleFixture(t) {
  const f = fixture(), clock = { now: f.now };
  const oracle = new V4PurchaseOracle({ config: f.config, deployment: f.deployment, clock: () => clock.now,
    fetchImpl: async () => { throw Error("No live network in this test"); } });
  oracle.parity = () => { throw Error("Merchant mode must never read or manufacture parity evidence"); };
  oracle.readers = [0, 1].map(() => ({ window: async () => structuredClone(f.history), usdt: async () => structuredClone(f.usdt), canonical: async () => {} }));
  t.after(async () => { oracle.close(); await oracle.pending?.catch(() => {}); });
  return { ...f, oracle, clock };
}
test("merchant reference is explicit, native-bound, and compatible with the existing mainnet chain encoding", () => {
  const f = fixture(); assert.deepEqual(configuration(f.config, f.deployment).reference, f.reference);
  const other = Signer.fromSeed("isolated-other-reference-token").getAddress();
  for (const change of [c => c.schema = 1, c => delete c.reference, c => c.paritySigner = other,
    c => c.reference.redemption = "available", c => c.reference.kind = "verified-parity", c => c.reference.wrappedPerNativeAtoms = "100000001",
    c => c.reference.nativeChainId = "not-a-chain", c => c.reference.wrappedChainId = 2, c => c.reference.wrappedToken = MARKET.quoteToken,
    c => c.policy.maxParityAgeMs = 20000, c => c.rpcUrls[1] = c.rpcUrls[0]]) {
    const c = structuredClone(f.config); change(c); assert.throws(() => configuration(c, f.deployment));
  }
  assert.throws(() => configuration(f.config, { ...f.deployment, token: other }), /native deployment/);
  assert.throws(() => V.validate({ ...f, deployment: undefined }), /native deployment/);
  assert.throws(() => V.validate({ ...f, parity: {} }), /cannot include parity/);
  assert.throws(() => V.validate({ ...f, reference: undefined }), /reviewed/);
});
test("merchant reference converts the actual pool and stablecoin observations without asserting redemption", () => {
  const f = fixture(), q = V.validate(f);
  assert.equal(q.usdPerKoin, "10000000000"); assert.equal(q.maxPurchaseUsdAtoms, "100000000"); assert.equal(q.maxPurchaseKoinAtoms, "1000000");
  assert.equal(q.expiresAt, f.now + 15000, "expiry is bounded by real market/feed evidence without an invented parity timer");
  const provenance = q.sources.at(-1);
  assert.equal(provenance.source, "merchant:vkoin-exchange-reference"); assert.equal(provenance.redemptionVerified, false);
  assert.equal(provenance.policyVersion, 2); assert.match(provenance.policyHash, /^0x[0-9a-f]{64}$/);
  assert.ok(!Object.hasOwn(provenance, "evidenceHash")); assert.ok(!Object.hasOwn(provenance, "signature"));
  const reordered = Object.fromEntries(Object.entries(f.policy).reverse());
  assert.equal(V.referenceHash(f.reference, reordered), provenance.policyHash, "commitment is stable under JSON key order");
  assert.notEqual(V.referenceHash(f.reference, { ...f.policy, version: 3 }), provenance.policyHash);
  assert.notEqual(V.referenceHash(f.reference, { ...f.policy, maxSlippageBps: 99 }), provenance.policyHash);
  f.usdt.usdAtoms = "99900000";
  assert.equal(V.validate(f).usdPerKoin, "9990000000"); assert.equal(V.validate(f).maxPurchaseUsdAtoms, "99900000");
});
test("merchant mode retains canonical history, every-block bid/ask depth, stablecoin and expiry guards", () => {
  for (const change of [f => f.history.blocks.splice(2, 1), f => f.history.blocks[2].parentHash = hash(999),
    f => f.history.blocks[2].depthBlockHash = hash(999), f => f.history.blocks[2].buyVkoinAtoms = "1",
    f => f.history.blocks[2].sellUsdtAtoms = "1", f => f.history.blocks[2].liquidity = "1", f => f.history.blocks[2].probeUsdtAtoms = "1",
    f => f.history.poolId = hash(999), f => f.usdt.usdAtoms = "90000000", f => f.usdt.validUntil = f.now,
    f => f.usdt.observedAt -= 21000, f => f.usdt.source = "unreviewed", f => f.now += 31000]) {
    const f = fixture(); change(f); assert.throws(() => V.validate(f));
  }
});
test("merchant oracle needs matching archives, clears stale or reorganized caches, and never consults a parity file", async t => {
  const f = oracleFixture(t); await assert.rejects(f.oracle.read(), /warming/); await f.oracle.refresh();
  assert.equal((await f.oracle.read()).usdPerKoin, "10000000000");
  f.oracle.readers[1].canonical = async () => { throw Error("reorganized"); };
  await assert.rejects(f.oracle.read(), /reorganized/); await f.oracle.pending?.catch(() => {}); assert.equal(f.oracle.cache, null);
  f.oracle.readers[1].canonical = async () => {}; f.oracle.readers[1].window = async () => ({ ...f.history, anchorHash: hash(999) });
  await assert.rejects(f.oracle.refresh(), /disagree/); assert.equal(f.oracle.cache, null);
  f.oracle.readers[1].window = async () => structuredClone(f.history); await f.oracle.refresh();
  f.clock.now += 16000; await assert.rejects(f.oracle.read()); await f.oracle.pending?.catch(() => {}); assert.equal(f.oracle.cache, null);
  const unavailable = purchasePrice({ mode: "mainnet-pilot", deployment: f.deployment });
  await assert.rejects(unavailable.read(), e => e.code === "PURCHASE_PRICE_UNAVAILABLE", "schema2 is never activated by a default");
});
test("purchase size cannot exceed the executable USD notional, even by one native atom or rounded quote", () => {
  const q = V.validate(fixture()); // synthetic $100/KOIN, $1 depth => 0.01 KOIN.
  assert.doesNotThrow(() => assertPurchaseSize(q, "1000000"));
  assert.throws(() => assertPurchaseSize(q, "1000001"), e => e.code === "PURCHASE_DEPTH_EXCEEDED");
  assert.throws(() => assertPurchaseSize(q, "1000000000"), e => e.code === "PURCHASE_DEPTH_EXCEEDED");
  assert.throws(() => assertPurchaseSize({ usdPerKoin: q.usdPerKoin }, "1"), /depth.*unavailable/);
  assert.doesNotThrow(() => assertPurchaseSize({ usdPerKoin: q.usdPerKoin }, "1", { isolated: true }));
  assert.throws(() => assertPurchaseSize({ usdPerKoin: "1", maxPurchaseUsdAtoms: "1", maxPurchaseKoinAtoms: "100000000" }, "100000001"), e => e.code === "PURCHASE_DEPTH_EXCEEDED");
  const f = fixture(); f.usdt.usdAtoms = "99900000"; const depeggedWithinPolicy = V.validate(f);
  assert.equal(depeggedWithinPolicy.maxPurchaseUsdAtoms, "99900000");
  const amount = require("../lib/koin-network/purchase-quote").nativeForDollars("1", depeggedWithinPolicy.usdPerKoin);
  assert.throws(() => assertPurchaseSize(depeggedWithinPolicy, amount), e => e.code === "PURCHASE_DEPTH_EXCEEDED");
});

test("depth uses the unrounded exchange price and exposes a pack ceiling that accommodates native rounding", () => {
  function atSquareRoot(sqrt) {
    const f = fixture(), spot = V.price(String(sqrt)), probe = 1000000n;
    for (const row of f.history.blocks) {
      row.sqrtPriceX96 = String(sqrt);
      row.buyVkoinAtoms = String(probe * 100n * V.SCALE * 990000n / (spot * 1000000n));
      row.sellVkoinAtoms = String((probe * 100n * V.SCALE + spot - 1n) / spot);
      row.sellUsdtAtoms = String(BigInt(row.sellVkoinAtoms) * spot * 990000n / (100n * V.SCALE * 1000000n));
    }
    return V.validate(f);
  }
  // About $0.037 per KOIN. Native rounding cannot falsely advertise a $1
  // pack when the precise executable $1 native limit is slightly lower.
  const q = atSquareRoot(1523983631873073519507169280n);
  const nativeForDollars = require("../lib/koin-network/purchase-quote").nativeForDollars;
  assert.doesNotThrow(() => assertPurchaseSize(q, nativeForDollars("0.99", q.usdPerKoin)));
  assert.throws(() => assertPurchaseSize(q, nativeForDollars("1", q.usdPerKoin)), e => e.code === "PURCHASE_DEPTH_EXCEEDED");
  assert.ok(BigInt(q.maxPurchaseUsdAtoms) < 100000000n);
  assert.doesNotThrow(() => assertPurchaseSize(q, q.maxPurchaseKoinAtoms));
  assert.throws(() => assertPurchaseSize(q, String(BigInt(q.maxPurchaseKoinAtoms) + 1n)), e => e.code === "PURCHASE_DEPTH_EXCEEDED");
  // Near one USD atom per KOIN, flooring the quoted price can otherwise
  // overstate native depth materially rather than by a rounding fraction.
  const tiny = atSquareRoot(970000000000000000000000n);
  assert.equal(tiny.usdPerKoin, "1");
  assert.ok(BigInt(tiny.maxPurchaseKoinAtoms) < 7000000000000000n);
  assert.throws(() => assertPurchaseSize(tiny, nativeForDollars("1", tiny.usdPerKoin)), e => e.code === "PURCHASE_DEPTH_EXCEEDED");
  assert.doesNotThrow(() => assertPurchaseSize(tiny, tiny.maxPurchaseKoinAtoms));
});

test("a higher spot within the allowed window reduces the native ceiling to units actually tested at every block", () => {
  const f = fixture(), row = f.history.blocks.at(-1), probe = BigInt(row.probeUsdtAtoms);
  row.sqrtPriceX96 = String((1n << 96n) * 1001n / 1000n);
  const spot = V.price(row.sqrtPriceX96);
  row.buyVkoinAtoms = String(probe * 100n * V.SCALE * 990000n / (spot * 1000000n));
  row.sellVkoinAtoms = String((probe * 100n * V.SCALE + spot - 1n) / spot);
  row.sellUsdtAtoms = String(BigInt(row.sellVkoinAtoms) * spot * 990000n / (100n * V.SCALE * 1000000n));
  const q = V.validate(f);
  assert.equal(q.usdPerKoin, "10000000000", "the final anchor has no elapsed time and must not replace the window price");
  assert.ok(BigInt(q.maxPurchaseKoinAtoms) < 1000000n, "the average-price depth limit would exceed the higher-price block's probe");
  for (const r of f.history.blocks) assert.ok(BigInt(q.maxPurchaseKoinAtoms) <= BigInt(r.sellVkoinAtoms));
  assert.doesNotThrow(() => assertPurchaseSize(q, q.maxPurchaseKoinAtoms));
  assert.throws(() => assertPurchaseSize(q, "1000000"), e => e.code === "PURCHASE_DEPTH_EXCEEDED");
});
