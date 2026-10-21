"use strict";
// Purchase-only validation. The history reader must obtain canonical v4
// StateView observations and both-direction Quoter simulations, never v3
// observe(). References: https://developers.uniswap.org/docs/protocols/v4/deployments
// https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IStateView.sol
// https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol
const { MARKET } = require("./purchase-price"), { uint } = require("./policy");
const crypto = require("node:crypto"), { utils } = require("koilib");
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
const PARITY_POLICY_FIELDS = "maxBlockGapSeconds,maxDeviationBps,maxParityAgeMs,maxParityDeviationBps,maxPriceAgeMs,maxQuoteMs,maxSlippageBps,maxUsdtAgeMs,maxUsdtDeviationBps,minLiquidity,minProbeUsdtAtoms,paritySource,usdtSource,version,windowSeconds";
const REFERENCE_POLICY_FIELDS = PARITY_POLICY_FIELDS.split(",").filter(k => !["maxParityAgeMs", "maxParityDeviationBps", "paritySource"].includes(k)).join(",");
function config(value, mode = "auto") {
  const fields = value && Object.keys(value).sort().join();
  if (!["auto", "parity", "reference"].includes(mode) || !value ||
      !(mode !== "reference" && fields === PARITY_POLICY_FIELDS || mode !== "parity" && fields === REFERENCE_POLICY_FIELDS)) throw Error("Explicit reviewed v4 pricing policy required");
  const parityMode = fields === PARITY_POLICY_FIELDS;
  const p = structuredClone(value);
  integer(p.version, 1, 0x7fffffff, "pricing policy version");
  integer(p.windowSeconds, 60, 86400, "time window");
  integer(p.maxBlockGapSeconds, 1, p.windowSeconds, "block gap");
  for (const k of ["maxPriceAgeMs", "maxUsdtAgeMs", "maxQuoteMs", ...(parityMode ? ["maxParityAgeMs"] : [])]) integer(p[k], 1, 86400000, k);
  if (p.maxQuoteMs > 300000) throw Error("Purchase quote lifetime exceeds protocol bound");
  for (const k of ["maxDeviationBps", "maxSlippageBps", "maxUsdtDeviationBps", ...(parityMode ? ["maxParityDeviationBps"] : [])]) integer(p[k], 0, 9999, k);
  positive(p.minLiquidity, "liquidity"); positive(p.minProbeUsdtAtoms, "depth probe");
  for (const k of ["usdtSource", ...(parityMode ? ["paritySource"] : [])]) if (typeof p[k] !== "string" || !p[k].trim() || p[k].length > 200) throw Error("Pinned " + k + " required");
  return Object.freeze(p);
}
const REFERENCE_FIELDS = ["kind", "nativeChainId", "nativeToken", "wrappedChainId", "wrappedToken", "wrappedPerNativeAtoms"];
function reference(value, deployment) {
  if (!value || Object.keys(value).sort().join() !== [...REFERENCE_FIELDS].sort().join() ||
      value.kind !== "merchant-exchange-reference" || typeof value.nativeChainId !== "string" ||
      Buffer.from(value.nativeChainId, "base64url").length !== 34 ||
      Buffer.from(value.nativeChainId, "base64url").subarray(0, 2).toString("hex") !== "1220" ||
      utils.encodeBase64url(Buffer.from(value.nativeChainId, "base64url")) !== value.nativeChainId ||
      typeof value.nativeToken !== "string" || !utils.isChecksumAddress(value.nativeToken) ||
      value.wrappedChainId !== MARKET.chainId || value.wrappedToken !== MARKET.wrappedToken ||
      value.wrappedPerNativeAtoms !== "100000000") throw Error("Explicit one-to-one merchant exchange reference required");
  if (deployment !== undefined && (!deployment || value.nativeChainId !== deployment.chainId || value.nativeToken !== deployment.token)) throw Error("Merchant reference does not match the native deployment");
  return Object.freeze(structuredClone(value));
}
function referenceHash(value, policy) {
  const r = reference(value), p = config(policy, "reference");
  // This commits to the chosen commercial convention, not evidence of bridge
  // backing, redemption, or a native KOIN market price.
  return "0x" + crypto.createHash("sha256").update("KAI-MERCHANT-EXCHANGE-REFERENCE-V1\0").update(JSON.stringify([
    REFERENCE_FIELDS.map(k => [k, r[k]]), Object.keys(p).sort().map(k => [k, p[k]]),
    Object.keys(MARKET).sort().map(k => [k, MARKET[k]])
  ])).digest("hex");
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
function validate({ policy, history, usdt, parity, reference: merchantReference, deployment, now }) {
  const referenceMode = merchantReference !== undefined;
  if (referenceMode && (parity !== undefined || !deployment)) throw Error("Merchant reference requires its native deployment and cannot include parity evidence");
  const r = referenceMode ? reference(merchantReference, deployment) : null;
  const p = config(policy, referenceMode ? "reference" : "parity"); integer(now, 1, Number.MAX_SAFE_INTEGER, "current time");
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
  fresh(usdt, p.usdtSource, p.maxUsdtAgeMs, now, "USDT/USD");
  const stable = positive(usdt.usdAtoms, "USDT/USD price");
  deviation(stable, USD, p.maxUsdtDeviationBps, "USDT/USD");
  let ratio = USD;
  if (!referenceMode) {
    fresh(parity, p.paritySource, p.maxParityAgeMs, now, "wrapped/native parity");
    ratio = positive(parity.wrappedPerNativeAtoms, "wrapped/native ratio");
    deviation(ratio, USD, p.maxParityDeviationBps, "Wrapped/native parity");
    if (parity.state !== "verified" || parity.nativeToken !== "KOIN" || parity.wrappedToken?.toLowerCase() !== MARKET.wrappedToken.toLowerCase()) throw Error("Explicit verified native/wrapped parity required");
  }
  const usdPerKoin = uint(average * stable * ratio / (SCALE * USD)); if (!usdPerKoin) throw Error("Purchase price below USD precision");
  // The approved minimum depth probe is the conservative per-purchase notional
  // ceiling. Use the highest unrounded window price to bound native units:
  // the same notional tested fewer units at that block than at the average.
  // Flooring USD atoms must not enlarge depth at precision-sensitive prices.
  // The USD pack ceiling is the actual credit value of that native ceiling.
  const maximumSpot = prices.reduce((maximum, spot) => spot > maximum ? spot : maximum, 0n);
  const maxPurchaseKoinAtoms = uint(positive(p.minProbeUsdtAtoms, "depth probe") * 100n * SCALE * USD / (maximumSpot * ratio));
  const maxPurchaseUsdAtoms = uint(maxPurchaseKoinAtoms * usdPerKoin / USD);
  if (!maxPurchaseKoinAtoms || !maxPurchaseUsdAtoms) throw Error("Purchase depth below USD precision");
  const expiresAt = Math.min(now + p.maxQuoteMs, end.timestamp * 1000 + p.maxPriceAgeMs, usdt.validUntil, usdt.observedAt + p.maxUsdtAgeMs,
    ...(referenceMode ? [] : [parity.validUntil, parity.observedAt + p.maxParityAgeMs]));
  if (expiresAt <= now) throw Error("Pricing evidence expires before purchase review");
  const referenceSource = referenceMode ? { source: "merchant:vkoin-exchange-reference", policyHash: referenceHash(r, p),
    policyVersion: p.version, ...r, redemptionVerified: false } : { source: parity.source, evidenceHash: parity.evidenceHash };
  return { usdPerKoin: String(usdPerKoin), maxPurchaseKoinAtoms: String(maxPurchaseKoinAtoms), maxPurchaseUsdAtoms: String(maxPurchaseUsdAtoms), observedAt: end.timestamp * 1000, expiresAt, policyVersion: p.version, anchorHash: end.hash,
    windowSeconds: elapsed, sources: [{ source: "ethereum:uniswap-v4", poolId: MARKET.poolId, anchorHash: end.hash }, { source: usdt.source, evidenceHash: usdt.evidenceHash }, referenceSource] };
}
module.exports = { config, reference, referenceHash, price, validate, SCALE };
