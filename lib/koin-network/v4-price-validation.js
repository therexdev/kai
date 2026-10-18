"use strict";
// Purchase-only validation. The history reader must obtain canonical v4
// StateView observations and both-direction Quoter simulations, never v3
// observe(). References: https://developers.uniswap.org/docs/protocols/v4/deployments
// https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IStateView.sol
// https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol
const { MARKET } = require("./purchase-price"), { uint } = require("./policy");
const SCALE = 10n ** 24n, Q192 = 1n << 192n, USD = 100000000n;
const HASH = /^0x[0-9a-f]{64}$/;
function integer(n, min, max, label) {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw Error("Invalid " + label);
  return n;
}
function positive(n, label) {
  if (typeof n !== "string" || !/^[1-9]\d{0,77}$/.test(n)) throw Error("Positive canonical " + label + " required");
  const v = BigInt(n); if (v >= 1n << 256n) throw Error(label + " outside uint256"); return v;
}
function config(value) {
  const fields = "maxBlockGapSeconds,maxDeviationBps,maxParityAgeMs,maxParityDeviationBps,maxPriceAgeMs,maxQuoteMs,maxSlippageBps,maxUsdtAgeMs,maxUsdtDeviationBps,minLiquidity,minProbeUsdtAtoms,paritySource,usdtSource,version,windowSeconds";
  if (!value || Object.keys(value).sort().join() !== fields) throw Error("Explicit reviewed v4 pricing policy required");
  const p = structuredClone(value);
  integer(p.version, 1, 0x7fffffff, "pricing policy version");
  integer(p.windowSeconds, 60, 86400, "time window");
  integer(p.maxBlockGapSeconds, 1, p.windowSeconds, "block gap");
  for (const k of ["maxPriceAgeMs", "maxUsdtAgeMs", "maxParityAgeMs", "maxQuoteMs"]) integer(p[k], 1, 86400000, k);
  if (p.maxQuoteMs > 300000) throw Error("Purchase quote lifetime exceeds protocol bound");
  for (const k of ["maxDeviationBps", "maxSlippageBps", "maxUsdtDeviationBps", "maxParityDeviationBps"]) integer(p[k], 0, 9999, k);
  positive(p.minLiquidity, "liquidity"); positive(p.minProbeUsdtAtoms, "depth probe");
  for (const k of ["usdtSource", "paritySource"]) if (typeof p[k] !== "string" || !p[k].trim() || p[k].length > 200) throw Error("Pinned " + k + " required");
  return Object.freeze(p);
}
function deviation(value, reference, bps, label) {
  if (reference <= 0n || (value > reference ? value - reference : reference - value) * 10000n > reference * BigInt(bps)) throw Error(label + " exceeds reviewed deviation");
}
function price(sqrtPriceX96) {
  if (typeof sqrtPriceX96 !== "string" || !/^[1-9]\d{0,48}$/.test(sqrtPriceX96)) throw Error("Canonical v4 square-root price required");
  const s = BigInt(sqrtPriceX96);
  if (s >= 1n << 160n) throw Error("v4 price outside uint160");
  // currency0=vKOIN (8 decimals), currency1=USDT (6 decimals).
  // Keep 24 decimal places until the final USD-atom conversion.
  const n = s * s * 100n * SCALE / Q192;
  if (!n) throw Error("Pool price below supported precision");
  return n;
}
function fresh(row, source, maxAge, now, label) {
  if (!row || row.source !== source || !HASH.test(row.evidenceHash)) throw Error("Reviewed " + label + " evidence required");
  integer(row.observedAt, 1, now, label + " observation time");
  integer(row.validUntil, now + 1, Number.MAX_SAFE_INTEGER, label + " expiry");
  if (now - row.observedAt > maxAge) throw Error(label + " is stale");
}
function validate({ policy, history, usdt, parity, now }) {
  const p = config(policy); integer(now, 1, Number.MAX_SAFE_INTEGER, "current time");
  if (!history || history.chainId !== MARKET.chainId || history.poolId !== MARKET.poolId || history.protocol !== MARKET.protocol ||
      history.currency0?.toLowerCase() !== MARKET.wrappedToken.toLowerCase() || history.currency1?.toLowerCase() !== MARKET.quoteToken.toLowerCase() ||
      history.decimals0 !== 8 || history.decimals1 !== 6 || history.fee !== MARKET.fee || history.tickSpacing !== 200 || history.hooks !== "0x" + "0".repeat(40)) throw Error("Approved Ethereum v4 market required");
  const rows = history.blocks;
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 8192 || history.canonical !== true || !HASH.test(history.anchorHash)) throw Error("Complete canonical v4 history required");
  let total = 0n, elapsed = 0;
  const end = rows.at(-1), start = end.timestamp - p.windowSeconds;
  integer(end.timestamp, 1, Math.floor(now / 1000), "anchor timestamp");
  if (now - end.timestamp * 1000 > p.maxPriceAgeMs || rows[0].timestamp > start || rows[1].timestamp <= start || end.hash !== history.anchorHash) throw Error("Fresh full-window history required");
  const prices = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; integer(r.number, 1, Number.MAX_SAFE_INTEGER, "block number"); integer(r.timestamp, 1, end.timestamp, "block timestamp");
    if (!HASH.test(r.hash) || !HASH.test(r.parentHash) || r.canonical !== true || r.stateBlockHash !== r.hash || r.depthBlockHash !== r.hash) throw Error("Canonical state and depth must share the block hash");
    if (i && (r.number !== rows[i - 1].number + 1 || r.parentHash !== rows[i - 1].hash || r.timestamp <= rows[i - 1].timestamp || r.timestamp - rows[i - 1].timestamp > p.maxBlockGapSeconds)) throw Error("History gap, fork or nonmonotonic time");
    if (positive(r.liquidity, "active liquidity") >= 1n << 128n || positive(r.liquidity, "active liquidity") < positive(p.minLiquidity, "minimum liquidity")) throw Error("Insufficient pool depth");
    const spot = price(r.sqrtPriceX96), probe = positive(r.probeUsdtAtoms, "USDT depth probe"), buy = positive(r.buyVkoinAtoms, "buy depth"), sellIn = positive(r.sellVkoinAtoms, "sell probe"), sell = positive(r.sellUsdtAtoms, "sell depth");
    if (probe < positive(p.minProbeUsdtAtoms, "minimum depth probe")) throw Error("Depth probe below reviewed minimum");
    // Include the actual 1% fee in executable bid/ask checks. An observation
    // cannot claim depth from virtual reserves while a tick boundary is empty.
    const expectedBuy = probe * 100n * SCALE * 990000n / (spot * 1000000n);
    const expectedSell = sellIn * spot * 990000n / (100n * SCALE * 1000000n);
    if (sellIn < probe * 100n * SCALE / spot) throw Error("Sell probe below reviewed notional");
    deviation(buy, expectedBuy, p.maxSlippageBps, "Buy depth"); deviation(sell, expectedSell, p.maxSlippageBps, "Sell depth");
    prices.push(spot);
    if (i < rows.length - 1) { const seconds = rows[i + 1].timestamp - Math.max(start, r.timestamp); if (seconds <= 0) throw Error("Invalid history interval"); total += spot * BigInt(seconds); elapsed += seconds; }
  }
  if (elapsed !== p.windowSeconds) throw Error("Incomplete averaging window");
  const average = total / BigInt(elapsed);
  for (const spot of prices) deviation(spot, average, p.maxDeviationBps, "Pool price");
  fresh(usdt, p.usdtSource, p.maxUsdtAgeMs, now, "USDT/USD"); fresh(parity, p.paritySource, p.maxParityAgeMs, now, "wrapped/native parity");
  const stable = positive(usdt.usdAtoms, "USDT/USD price"), ratio = positive(parity.wrappedPerNativeAtoms, "wrapped/native ratio");
  deviation(stable, USD, p.maxUsdtDeviationBps, "USDT/USD"); deviation(ratio, USD, p.maxParityDeviationBps, "Wrapped/native parity");
  if (parity.state !== "verified" || parity.nativeToken !== "KOIN" || parity.wrappedToken?.toLowerCase() !== MARKET.wrappedToken.toLowerCase()) throw Error("Explicit verified native/wrapped parity required");
  const usdPerKoin = uint(average * stable * ratio / (SCALE * USD)); if (!usdPerKoin) throw Error("Purchase price below USD precision");
  const expiresAt = Math.min(now + p.maxQuoteMs, end.timestamp * 1000 + p.maxPriceAgeMs, usdt.validUntil, usdt.observedAt + p.maxUsdtAgeMs, parity.validUntil, parity.observedAt + p.maxParityAgeMs);
  if (expiresAt <= now) throw Error("Pricing evidence expires before purchase review");
  return { usdPerKoin: String(usdPerKoin), observedAt: end.timestamp * 1000, expiresAt, policyVersion: p.version, anchorHash: end.hash,
    windowSeconds: elapsed, sources: [{ source: "ethereum:uniswap-v4", poolId: MARKET.poolId, anchorHash: end.hash }, { source: usdt.source, evidenceHash: usdt.evidenceHash }, { source: parity.source, evidenceHash: parity.evidenceHash }] };
}
module.exports = { config, price, validate, SCALE };
