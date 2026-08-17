"use strict";

const fs = require("fs");
const path = require("path");

/*
 * §7.4 shadow-data analysis — makes arming the anti-Sybil gate and the §17
 * shadow challenge tiers a DATA-DRIVEN flip instead of a guess.
 *
 * Every closed epoch persists a summary with `reputationShadow` (per-worker
 * r/elig/gated + sub-scores) and `perf` (per-tier challenge ok/bad, sr).
 * This module scans the most recent closed epochs and produces:
 *   - series: per-epoch timeline (challenge pass rates by tier, reputation
 *     spread, how many workers clear the gate)
 *   - perWorker: per-address trajectory (r now vs first seen, sr, challenge
 *     totals, would-be pool eligibility)
 *   - gatePreview: for the LAST closed epoch, each worker's subsidy share
 *     under today's flat split vs what the reputation gate WOULD pay —
 *     the before/after picture the owner reviews before arming.
 *
 * Read-only over epoch files; no scheduler state is touched. Served by the
 * operator-gated /admin/api/shadow-trends endpoint (full addresses are fine
 * there — it is never a public surface).
 */

function computeTrends(dataDir, { maxEpochs = 96 } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return { ok: false, error: "no data dir" };
  }
  // epoch-<unixMinute>.json, ascending; keep the most recent maxEpochs.
  const files = names
    .filter((n) => /^epoch-\d+\.json$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .slice(-maxEpochs);

  const series = [];
  const perWorker = {};
  let lastClosed = null;
  for (const n of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dataDir, n), "utf8"));
    } catch {
      continue; // unreadable file — skip, never fail the report
    }
    const s = j && j.summary;
    if (!s) continue; // open epoch — not settled yet
    const rep = s.reputationShadow || {};
    const perf = s.perf || {};
    const served = s.served || {};

    // Per-tier challenge pass rates this epoch are not in the summary directly
    // (perf.chal is a rolling lifetime counter), so track the LIFETIME counter
    // per epoch — the delta between epochs is the per-epoch rate, and the
    // rolling view is what the arming decision actually needs (field baseline).
    const chal = {};
    for (const p of Object.values(perf)) {
      for (const [tier, c] of Object.entries(p.chal || {})) {
        (chal[tier] ||= { ok: 0, bad: 0 });
        chal[tier].ok += Number(c.ok) || 0;
        chal[tier].bad += Number(c.bad) || 0;
      }
    }

    const rs = Object.values(rep).map((x) => Number(x && x.r) || 0);
    const aboveGate = Object.values(rep).filter((x) => x && x.gated).length;
    series.push({
      epoch: j.epoch,
      at: new Date(j.epoch * 60000).toISOString(), // unix-minute epochs
      workers: Object.keys(rep).length,
      aboveGate,
      rMin: rs.length ? Math.min(...rs) : null,
      rMax: rs.length ? Math.max(...rs) : null,
      chal, // rolling lifetime totals as of this epoch
    });

    for (const [addr, x] of Object.entries(rep)) {
      const w = (perWorker[addr] ||= { firstEpoch: j.epoch, first: null, last: null });
      if (!w.first) w.first = { r: x.r, sub: x.sub };
      w.last = { epoch: j.epoch, r: x.r, elig: x.elig, gated: x.gated, sub: x.sub };
      const p = perf[addr];
      if (p) w.perf = { sr: p.sr, jobs: p.jobs, chal: p.chal || null, clampEgregious: p.clampEgregious || 0 };
      w.servedLast = Number(served[addr]) || 0;
    }
    lastClosed = { epoch: j.epoch, rep, served };
  }

  // Gate preview on the last closed epoch: flat share (today) vs the share the
  // reputation gate WOULD assign (weight = served × elig; if every weight is 0
  // the pool simply stays in reserve that epoch). Approximation by receipt
  // count — exact subsidy value weighting lives in the scheduler; this is the
  // operator's calibration view, and it says so.
  let gatePreview = null;
  if (lastClosed) {
    const rows = Object.entries(lastClosed.served).map(([addr, cnt]) => {
      const x = lastClosed.rep[addr] || {};
      return { addr, served: Number(cnt) || 0, r: x.r ?? null, elig: Number(x.elig) || 0 };
    });
    const flatTot = rows.reduce((a, b) => a + b.served, 0);
    const gatedTot = rows.reduce((a, b) => a + b.served * b.elig, 0);
    gatePreview = {
      epoch: lastClosed.epoch,
      note: "share-by-receipt-count approximation; poolInReserve=true means no worker clears the gate yet",
      poolInReserve: gatedTot === 0,
      workers: rows.map((row) => ({
        addr: row.addr,
        r: row.r,
        flatSharePct: flatTot ? +((100 * row.served) / flatTot).toFixed(1) : 0,
        gatedSharePct: gatedTot ? +((100 * row.served * row.elig) / gatedTot).toFixed(1) : 0,
      })),
    };
  }

  return { ok: true, epochsScanned: series.length, series, perWorker, gatePreview };
}

module.exports = { computeTrends };
