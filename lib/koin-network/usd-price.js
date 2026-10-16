"use strict";
// Purchase-only oracle. A missing/stale market quote never blocks existing credits.
// Sources and tolerances are fixed here and reviewed with the deployment source.
const { uint } = require("./policy");
const MAX_AGE_MS = 600000, MAX_SPREAD_BPS = 1000;
const SOURCES = Object.freeze({
  coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=koinos&vs_currencies=usd&include_last_updated_at=true&precision=full",
  coinpaprika: "https://api.coinpaprika.com/v1/tickers/koin-koinos?quotes=USD",
});
function priceAtoms(value) {
  // Market JSON uses decimal numbers; convert its decimal representation exactly,
  // never multiply a floating point price by the customer's KOIN balance.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw Error("Positive market price required");
  const [mantissa, exp = "0"] = String(value).toLowerCase().split("e"), [whole, fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction), shift = 8 + Number(exp) - fraction.length;
  if (Math.abs(shift) > 100) throw Error("Market price outside range");
  const n = uint(shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift));
  if (!n) throw Error("Market price below precision"); return n;
}
function combine(rows, now) {
  if (!Number.isSafeInteger(now) || now <= 0 || rows.length !== 2 || new Set(rows.map(r => r.source)).size !== 2 ||
      rows.some(r => !Object.hasOwn(SOURCES, r.source) || !Number.isSafeInteger(r.at) || r.at > now + 30000 || now - r.at > MAX_AGE_MS))
    throw Error("Fresh KOIN/USD prices are temporarily unavailable. Existing credits are still usable.");
  const prices = rows.map(r => priceAtoms(r.price)).sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  if ((prices[1] - prices[0]) * 10000n > prices[0] * BigInt(MAX_SPREAD_BPS)) throw Error("KOIN price sources disagree. Please try your purchase later.");
  return { usdPerKoin: String((prices[0] + prices[1]) / 2n), observedAt: now, sources: rows.map(r => ({ source: r.source, at: r.at, usdPerKoin: String(priceAtoms(r.price)) })) };
}
class UsdPrice {
  constructor({ fetchImpl = fetch, clock = Date.now, coingeckoKey = process.env.KAI_COINGECKO_DEMO_KEY } = {}) {
    this.fetch = fetchImpl; this.clock = clock; this.key = coingeckoKey;
  }
  async read() {
    const now = this.clock();
    if (this.cached && now >= this.cached.observedAt && now - this.cached.observedAt < 30000 &&
        this.cached.sources.every(r => now - r.at <= MAX_AGE_MS)) return structuredClone(this.cached);
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const rows = await Promise.all(Object.entries(SOURCES).map(async ([source, url]) => {
        const signal = AbortSignal.timeout(8000), response = await this.fetch(url, { signal, redirect: "error",
          headers: source === "coingecko" && this.key ? { "x-cg-demo-api-key": this.key } : {} });
        if (!response.ok) throw Error("KOIN/USD pricing is temporarily unavailable. No payment was started.");
        const parts = []; let size = 0;
        for await (const chunk of response.body) { signal.throwIfAborted(); size += chunk.length; if (size > 65536) throw Error("Market response too large"); parts.push(chunk); }
        const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (source === "coingecko") return { source, at: body.koinos?.last_updated_at * 1000, price: body.koinos?.usd };
        if (body.id !== "koin-koinos" || body.symbol !== "KOIN") throw Error("Unexpected market asset");
        return { source, at: Date.parse(body.last_updated), price: body.quotes?.USD?.price };
      }));
      return this.cached = combine(rows, this.clock());
    })();
    try { return structuredClone(await this.pending); } finally { this.pending = null; }
  }
}
module.exports = { UsdPrice, combine, priceAtoms, SOURCES, MAX_AGE_MS, MAX_SPREAD_BPS };
