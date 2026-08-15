"use strict";

const fs = require("fs");
const path = require("path");

/*
 * Koinos AI §51 price oracle — mounted into the koinosai.com website
 * (mirrored from therexdev/kaiapp server/oracle.js — keep in sync).
 * The mechanism the spec queues as
 * "oracle inputs, smoothing, epochs, and circuit breakers".
 *
 * Design (alpha):
 *   inputs    — N independent HTTP JSON sources (e.g. a KoinDX pool quote,
 *               an operator-attested price file). Each source is
 *               {url, path} where path dot-walks the JSON to a number.
 *               With no sources configured the oracle is an ANCHOR: it
 *               holds the fixed KAI_REF_USD and never moves — which is
 *               bit-for-bit the pre-oracle behavior.
 *   aggregate — median across sources that answered (a single bad or
 *               manipulated feed cannot move the median of three).
 *   smoothing — EMA toward the median (alpha per refresh), so one epoch
 *               never reprices on a spike.
 *   breakers  — per-refresh step clamp (±maxStepPct) and hard floor/ceil
 *               bounds; if every source fails the price HOLDS (stale-hold)
 *               rather than snapping back to the anchor.
 *   epochs    — the scheduler snapshots the oracle at each epoch close, so
 *               one epoch settles at exactly one price (see scheduler.js).
 *   restart   — the last smoothed price persists to disk; a scheduler
 *               restart resumes it instead of jumping to the anchor.
 */

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

class PriceOracle {
  constructor({ anchorUsd, sources, alpha, maxStepPct, floorUsd, ceilUsd, statePath, timeoutMs } = {}) {
    this.anchorUsd = num(anchorUsd, 0.01);
    this.sources = (Array.isArray(sources) ? sources : []).filter((s) => s && s.url);
    this.alpha = Math.min(1, Math.max(0.01, num(alpha, 0.25)));
    this.maxStepPct = Math.max(0.1, num(maxStepPct, 10));
    this.floorUsd = num(floorUsd, this.anchorUsd / 10);
    this.ceilUsd = num(ceilUsd, this.anchorUsd * 10);
    this.timeoutMs = num(timeoutMs, 5000);
    this.statePath = statePath || null;
    this.usd = this.anchorUsd;
    this.updatedAt = null;
    this.status = "anchor"; // anchor | live | stale-hold
    this.lastMedian = null;
    if (this.statePath && this.sources.length) {
      try {
        const st = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        if (Number.isFinite(st.usd) && st.usd > 0) {
          this.usd = this._bound(st.usd);
          this.updatedAt = st.updatedAt || null;
          this.status = "stale-hold"; // persisted, not yet re-confirmed live
        }
      } catch {
        /* fresh state */
      }
    }
  }

  _bound(usd) {
    return Math.min(this.ceilUsd, Math.max(this.floorUsd, usd));
  }

  /** The integer conversion pair every billing path uses. Derived from one
   *  usd figure so a snapshot is always internally consistent. */
  static convert(usd) {
    const microPerKai = BigInt(Math.max(1, Math.round(usd * 1e6)));
    const satPerMicro = BigInt(Math.max(1, Math.round(1e8 / Number(microPerKai))));
    return { microPerKai, satPerMicro };
  }

  /** Current state as an epoch-pinnable price snapshot. */
  snapshot() {
    return { usd: this.usd, status: this.status, updatedAt: this.updatedAt, ...PriceOracle.convert(this.usd) };
  }

  /** Public description for /pricing — enough to audit the mechanism. */
  describe() {
    return {
      status: this.status,
      usd: this.usd,
      updatedAt: this.updatedAt,
      sources: this.sources.length,
      lastMedian: this.lastMedian,
      smoothing: { alpha: this.alpha, maxStepPct: this.maxStepPct, floorUsd: this.floorUsd, ceilUsd: this.ceilUsd },
    };
  }

  async _readSource(src) {
    const ctl = AbortSignal.timeout(this.timeoutMs);
    const r = await fetch(src.url, { signal: ctl, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`http ${r.status}`);
    let v = await r.json();
    for (const key of String(src.path || "").split(".").filter(Boolean)) v = v?.[key];
    const usd = Number(v);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error("no numeric price at path");
    return usd;
  }

  /** Poll sources and advance the smoothed price one step. Never throws;
   *  with no sources it is a no-op anchor. Returns snapshot(). */
  async refresh() {
    if (!this.sources.length) return this.snapshot();
    const reads = await Promise.allSettled(this.sources.map((s) => this._readSource(s)));
    const prices = reads.filter((r) => r.status === "fulfilled").map((r) => r.value).sort((a, b) => a - b);
    if (!prices.length) {
      this.status = "stale-hold"; // hold the last good price, never snap back
      return this.snapshot();
    }
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    this.lastMedian = median;
    const smoothed = this.alpha * median + (1 - this.alpha) * this.usd;
    const step = this.usd * (this.maxStepPct / 100);
    const stepped = Math.min(this.usd + step, Math.max(this.usd - step, smoothed));
    this.usd = this._bound(stepped);
    this.updatedAt = new Date().toISOString();
    this.status = "live";
    if (this.statePath) {
      try {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        fs.writeFileSync(this.statePath, JSON.stringify({ usd: this.usd, updatedAt: this.updatedAt }));
      } catch {
        /* persistence is best-effort */
      }
    }
    return this.snapshot();
  }
}

/** Parse the KAI_PRICE_SOURCES env value: a JSON array of {url, path}. */
function parseSources(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

module.exports = { PriceOracle, parseSources };
