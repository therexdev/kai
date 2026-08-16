"use strict";

/*
 * Oracle break-test (§51): proves the price machinery behaves BEFORE it ever
 * eats real data on mainnet. Replays adversarial price sequences through the
 * real PriceOracle by stubbing _readSource (no network), and asserts:
 *   - a raw spike/crash moves the smoothed reference at most maxStepPct/step
 *   - a single bad/outlier source can't move the median of three
 *   - all-sources-down holds the last good price (never snaps to anchor)
 *   - the price never leaves [floorUsd, ceilUsd]
 *   - a breaker-clamped climb recovers smoothly when data normalizes
 *
 *   node scripts/probe-oracle.js
 */

const { PriceOracle } = require("../lib/oracle");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}

// An oracle whose sources return scripted values instead of fetching. Each
// "source" is an index into the current `feed` array; a null means that
// source failed this round (excluded from the median, like a real timeout).
function makeOracle(opts, nSources) {
  const sources = Array.from({ length: nSources }, (_, i) => ({ url: `stub://${i}`, path: "x" }));
  const o = new PriceOracle({ sources, ...opts });
  o._feed = [];
  o._readSource = async (src) => {
    const i = Number(src.url.split("//")[1]);
    const v = o._feed[i];
    if (v == null) throw new Error("source down");
    return v;
  };
  return o;
}
async function step(o, feed) {
  o._feed = feed;
  await o.refresh();
  return o.snapshot();
}

async function main() {
  console.log("oracle 1: anchor start, then a normal live read moves toward the median");
  {
    const o = makeOracle({ anchorUsd: 0.042, alpha: 0.25, maxStepPct: 10 }, 3);
    check(o.snapshot().status === "anchor", "starts in anchor status with no refresh");
    const s = await step(o, [0.042, 0.043, 0.041]); // median 0.042
    check(s.status === "live" && Math.abs(s.usd - 0.042) < 0.002, `first live read settles near the median (${s.usd})`);
  }

  console.log("oracle 2: a single bad/outlier source cannot move the median of three");
  {
    const o = makeOracle({ anchorUsd: 0.042, alpha: 0.5, maxStepPct: 50 }, 3);
    await step(o, [0.042, 0.043, 0.041]);
    const before = o.snapshot().usd;
    const s = await step(o, [0.042, 0.043, 5.0]); // one source screams $5
    // median of [0.042,0.043,5.0] = 0.043 — the outlier is ignored.
    check(Math.abs(s.usd - before) < 0.01, `outlier source ignored (median held, ${s.usd})`);
  }

  console.log("oracle 3: a raw spike is rate-limited to maxStepPct per refresh (breaker)");
  {
    const o = makeOracle({ anchorUsd: 0.042, alpha: 1, maxStepPct: 10 }, 1); // alpha 1 = no EMA damping, isolate the step clamp
    await step(o, [0.042]);
    const before = o.snapshot().usd;
    const s = await step(o, [0.5]); // 10x spike in one round
    const movePct = ((s.usd - before) / before) * 100;
    check(movePct <= 10.0001 && movePct > 9, `10x spike clamped to +${movePct.toFixed(2)}% (<= maxStepPct 10)`);
  }

  console.log("oracle 4: a raw crash is rate-limited downward too");
  {
    const o = makeOracle({ anchorUsd: 0.042, alpha: 1, maxStepPct: 10 }, 1);
    await step(o, [0.042]);
    const before = o.snapshot().usd;
    const s = await step(o, [0.0001]); // crash
    const movePct = ((before - s.usd) / before) * 100;
    check(movePct <= 10.0001 && movePct > 9, `crash clamped to -${movePct.toFixed(2)}% (<= maxStepPct 10)`);
  }

  console.log("oracle 5: all sources down -> hold last good price, never snap to anchor");
  {
    const o = makeOracle({ anchorUsd: 0.01, alpha: 0.5, maxStepPct: 20 }, 3);
    await step(o, [0.042, 0.043, 0.041]);
    const good = o.snapshot().usd;
    const s = await step(o, [null, null, null]); // total blackout
    check(s.status === "stale-hold" && s.usd === good, `held ${s.usd} on blackout (status ${s.status}), did NOT snap to anchor 0.01`);
  }

  console.log("oracle 6: the price never leaves [floorUsd, ceilUsd]");
  {
    const o = makeOracle({ anchorUsd: 0.042, alpha: 1, maxStepPct: 100, floorUsd: 0.02, ceilUsd: 0.08 }, 1);
    await step(o, [0.042]);
    for (let i = 0; i < 20; i++) await step(o, [10]); // relentless pressure up
    check(o.snapshot().usd <= 0.08 + 1e-9, `held at ceil ${o.snapshot().usd} <= 0.08`);
    for (let i = 0; i < 20; i++) await step(o, [0.00001]); // relentless pressure down
    check(o.snapshot().usd >= 0.02 - 1e-9, `held at floor ${o.snapshot().usd} >= 0.02`);
  }

  console.log("oracle 7: a clamped climb recovers smoothly to the new level over several rounds");
  {
    const o = makeOracle({ anchorUsd: 0.042, alpha: 1, maxStepPct: 10 }, 1);
    await step(o, [0.042]);
    let s;
    for (let i = 0; i < 20; i++) s = await step(o, [0.084]); // sustained 2x
    check(Math.abs(s.usd - 0.084) < 0.001, `converged to the sustained new price ${s.usd} after repeated steps`);
  }

  console.log("oracle 8: crossed floor/ceil config fails loudly at construction");
  {
    let threw = false;
    try { new PriceOracle({ sources: [{ url: "x", path: "p" }], floorUsd: 0.5, ceilUsd: 0.1 }); }
    catch { threw = true; }
    check(threw, "floor > ceil throws instead of silently pinning the price");
  }

  console.log(failures === 0 ? "\nORACLE PROBE PASSED" : `\nORACLE PROBE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("aborted:", e.message); process.exit(1); });
