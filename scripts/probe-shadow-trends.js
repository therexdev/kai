"use strict";

/*
 * Probe: §7.4 shadow-data trend analysis.
 *
 *   node scripts/probe-shadow-trends.js
 *
 * Drives a real scheduler through two closed epochs (worker registered, perf +
 * reputation populated), then runs lib/shadow-trends over the persisted epoch
 * files and asserts the report: series timeline, rolling challenge totals,
 * per-worker trajectory, and the flat-vs-gated pool-share preview (including
 * the poolInReserve case — nobody clears the gate on a fresh network).
 *
 * FAILS on the old code (lib/shadow-trends.js does not exist), PASSES on new.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { Scheduler } = require("../lib/scheduler");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}

async function main() {
  let computeTrends;
  try {
    ({ computeTrends } = require("../lib/shadow-trends"));
  } catch {
    check(false, "lib/shadow-trends.js exists (FAILS on old code)");
    console.log("\nFAILED (1 check)");
    process.exit(1);
  }
  check(typeof computeTrends === "function", "lib/shadow-trends.js exists (FAILS on old code)");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-trends-"));
  const ADDR = "1TrendWorkerAddr";

  // Epoch 1: pin an explicit epoch, seed perf + a served receipt, close.
  const s1 = new Scheduler({ dataDir: dir, leaseMs: 150, epoch: 1000 });
  s1.workers.set("tok1", { address: ADDR, models: ["koinos-fast"], firstSeen: Date.now() - 86400000, repPaidJobs: 3, lastSeen: Date.now(), seedsThisEpoch: 0, mystThisEpoch: 0 });
  s1.perf[ADDR] = { jobs: 3, tokPerSec: 10, cuRating: 0.5, srvTokPerSec: 9, ok: 3, bad: 0, sr: 1, chal: { t1: { ok: 2, bad: 0 } } };
  s1.receipts = [{ jobId: "j1", worker: ADDR, jobType: "inference-eval", honest: true }];
  s1.closeEpoch();

  // Epoch 2 (scheduler advances epoch itself after close): more history.
  s1.perf[ADDR].chal.t1.ok = 4;
  s1.receipts = [{ jobId: "j2", worker: ADDR, jobType: "inference-eval", honest: true }];
  s1.closeEpoch();

  const t = computeTrends(dir, { maxEpochs: 10 });
  check(t.ok === true, "report computes ok");
  check(t.epochsScanned === 2, `both closed epochs scanned (got ${t.epochsScanned})`);
  check(t.series.length === 2 && t.series[0].epoch === 1000, "series is an epoch-ordered timeline");
  check(t.series[1].chal.t1 && t.series[1].chal.t1.ok === 4, "rolling challenge totals tracked per epoch");
  check(!!t.perWorker[ADDR] && typeof t.perWorker[ADDR].last.r === "number", "per-worker reputation trajectory present");
  check(t.perWorker[ADDR].perf && t.perWorker[ADDR].perf.sr === 1, "per-worker perf (sr) attached");

  // Gate preview: a 1-day-old worker sits below the gate -> elig 0 -> the pool
  // would stay in reserve under enforcement. flat share is still 100%.
  const gp = t.gatePreview;
  check(gp && gp.epoch === t.series[1].epoch, "gate preview computed on the last closed epoch");
  check(gp.workers.length === 1 && gp.workers[0].flatSharePct === 100, "flat share: sole worker takes 100%");
  check(gp.poolInReserve === true && gp.workers[0].gatedSharePct === 0, "below-gate worker -> gated share 0, pool stays in reserve");

  // Robustness: unreadable epoch file is skipped, never fatal.
  fs.writeFileSync(path.join(dir, "epoch-999.json"), "{not json");
  const t2 = computeTrends(dir, { maxEpochs: 10 });
  check(t2.ok === true && t2.epochsScanned === 2, "corrupt epoch file skipped without failing the report");

  console.log(failures ? `\nFAILED (${failures} check${failures > 1 ? "s" : ""})` : "\nAll shadow-trend checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
