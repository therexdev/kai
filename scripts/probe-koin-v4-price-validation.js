"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { validate, config, price, SCALE } = require("../lib/koin-network/v4-price-validation"), { MARKET } = require("../lib/koin-network/purchase-price");
const hash = n => "0x" + n.toString(16).padStart(64, "0");
function fixture() {
  // Synthetic prices and policy for local validation only; not launch settings.
  const now = 1800000000000, end = now / 1000;
  const policy = { version: 1, windowSeconds: 60, maxBlockGapSeconds: 12, maxPriceAgeMs: 30000, maxQuoteMs: 20000,
    maxDeviationBps: 100, maxSlippageBps: 100, maxUsdtAgeMs: 20000, maxUsdtDeviationBps: 100, maxParityAgeMs: 20000, maxParityDeviationBps: 100,
    minLiquidity: "1000000000", minProbeUsdtAtoms: "1000000", usdtSource: "isolated:USDT", paritySource: "isolated:parity" };
  const blocks = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, hash: hash(i + 1), parentHash: hash(i), timestamp: end - 60 + i * 10,
    canonical: true, stateBlockHash: hash(i + 1), depthBlockHash: hash(i + 1), sqrtPriceX96: String(1n << 96n), liquidity: "1000000000000",
    probeUsdtAtoms: "1000000", buyVkoinAtoms: "990000", sellVkoinAtoms: "1000000", sellUsdtAtoms: "990000" }));
  return { now, policy, history: { chainId: 1, protocol: "uniswap-v4", poolId: MARKET.poolId, currency0: MARKET.wrappedToken, currency1: MARKET.quoteToken,
    decimals0: 8, decimals1: 6, fee: 10000, tickSpacing: 200, hooks: "0x" + "0".repeat(40), canonical: true, anchorHash: hash(7), blocks },
    usdt: { source: "isolated:USDT", evidenceHash: hash(20), observedAt: now - 1000, validUntil: now + 15000, usdAtoms: "100000000" },
    parity: { source: "isolated:parity", evidenceHash: hash(21), observedAt: now - 1000, validUntil: now + 10000,
      wrappedPerNativeAtoms: "100000000", state: "verified", nativeToken: "KOIN", wrappedToken: MARKET.wrappedToken } };
}
test("v4 arithmetic time-weighted conversion uses exact decimals and earliest evidence expiry", () => {
  const f = fixture(), q = validate(f); assert.equal(price(String(1n << 96n)), 100n * SCALE);
  assert.equal(q.usdPerKoin, "10000000000"); assert.equal(q.expiresAt, f.now + 10000); assert.equal(q.anchorHash, hash(7)); assert.equal(q.windowSeconds, 60);
  f.usdt.usdAtoms = "99900000"; f.parity.wrappedPerNativeAtoms = "100100000";
  assert.equal(validate(f).usdPerKoin, "9999990000", "fresh USDT and explicit parity each affect the exact price");
});
test("pricing needs a complete reviewed policy and the exact v4 market", () => {
  assert.throws(() => config({}), /reviewed/);
  for (const change of [f => f.policy.windowSeconds = 0, f => delete f.policy.paritySource, f => f.history.protocol = "uniswap-v3", f => f.history.poolId = hash(9), f => f.history.decimals0 = 18, f => f.history.fee = 3000]) {
    const f = fixture(); change(f); assert.throws(() => validate(f));
  }
});
test("missing history, reorgs, stale anchors and mixed-block depth cannot become a quote", () => {
  for (const change of [f => f.history.blocks.shift(), f => f.history.blocks.splice(2, 1), f => f.history.blocks[3].parentHash = hash(99),
    f => f.history.blocks[2].depthBlockHash = hash(99), f => f.history.blocks[2].canonical = false,
    f => f.history.anchorHash = hash(99), f => f.history.blocks[3].timestamp--, f => f.now += 31000]) {
    const f = fixture(); change(f);
    // A one-second timestamp adjustment is still canonical and within the gap
    // limit; it changes weights but is not itself invalid.
    if (f.history.blocks[3]?.timestamp === fixture().history.blocks[3].timestamp - 1) assert.equal(validate(f).usdPerKoin, "10000000000");
    else assert.throws(() => validate(f));
  }
});
test("both-direction executable depth is required throughout the averaging window", () => {
  for (const change of [r => r.liquidity = "1", r => r.probeUsdtAtoms = "100", r => r.buyVkoinAtoms = "1", r => r.sellUsdtAtoms = "1", r => r.sellVkoinAtoms = "1"]) {
    const f = fixture(); change(f.history.blocks[2]); assert.throws(() => validate(f), /depth|probe|liquidity/i);
  }
  const f = fixture(); f.history.blocks[3].sqrtPriceX96 = String((1n << 96n) * 2n);
  f.history.blocks[3].buyVkoinAtoms = "247500"; f.history.blocks[3].sellUsdtAtoms = "3960000";
  assert.throws(() => validate(f), /Pool price.*deviation/);
});
test("stablecoin depeg, missing or expired parity, and unreviewed sources stop only the quote", () => {
  for (const change of [f => f.usdt.usdAtoms = "90000000", f => f.usdt.observedAt -= 30000, f => f.usdt.source = "spot-assumption",
    f => f.parity = null, f => f.parity.state = "assumed", f => f.parity.validUntil = f.now, f => f.parity.wrappedPerNativeAtoms = "90000000",
    f => f.parity.wrappedToken = "native", f => f.usdt.usdAtoms = 100000000]) {
    const f = fixture(); change(f); assert.throws(() => validate(f));
  }
});
