"use strict";

/*
 * Probe: epoch resume on boot + persistent daily free-tier counters.
 *
 *   node scripts/probe-epoch-resume.js
 *
 * Field finding 2026-08-17: a restart minted a fresh epoch number and ABANDONED
 * the in-flight epoch — its receipts (real earned work) never settled, and the
 * daily free-tier counters (memory-only) refilled. With the auto-deploy
 * restarting on every push, every deploy silently cost workers up to 15 minutes
 * of earnings and handed consumers a fresh free allowance.
 *
 * All resume/persistence checks FAIL on the old scheduler and PASS on the new:
 *  1. A scheduler booted over an unsettled epoch file RESUMES it — same epoch
 *     number, receipts restored — and its close settles the restored work.
 *  2. spentSat (mid-epoch consumer spend) survives the restart, so a consumer
 *     cannot double-spend epoch earnings by timing a deploy.
 *  3. Free-tier draws survive a restart (same UTC day).
 *  4. A stale freeday.json from a previous day is ignored (day-roll intact).
 *  5. A settled (closed) epoch file is NOT resumed — fresh epoch as before.
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
  const W = "1ResumeWorkerAddr";

  // ---- 1+2: resume an unsettled epoch ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-resume-"));
  const a = new Scheduler({ dataDir: dir, leaseMs: 150 }); // no pinned epoch — production path
  const epochA = a.epoch;
  a.receipts = [
    { jobId: "r1", worker: W, jobType: "inference-eval", honest: true },
    { jobId: "r2", worker: W, jobType: "inference-eval", honest: true },
  ];
  a.spentSat[W] = "12345";
  a.consumed[W] = 2;
  a._persist(); // what the per-receipt path writes mid-epoch
  await a.close(); // release the exit listener; the epoch file stays UNSETTLED

  const b = new Scheduler({ dataDir: dir, leaseMs: 150 });
  check(b.epoch === epochA, `boot RESUMES the unsettled epoch (${b.epoch} === ${epochA}) — FAILS on old (fresh epoch)`);
  check(b.receipts.length === 2 && b.receipts[0].jobId === "r1", "in-flight receipts restored (earnings no longer vaporized)");
  check(b.spentSat[W] === "12345", "mid-epoch consumer spend restored (no double-spend via restart)");
  check(b.consumed[W] === 2, "request tallies restored for the close summary");

  // The resumed epoch CLOSES and SETTLES the restored work.
  const summary = b.closeEpoch();
  check(summary.epoch === epochA && summary.receipts === 2, "resumed epoch closes with the restored receipts");
  check(!!summary.totals && Object.values(summary.totals).length > 0, "restored work settles into claims");
  check(b.epoch > epochA, "epoch number stays monotonic after the resumed close");
  await b.close();

  // ---- 3: free-tier persistence (same day) ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-resume2-"));
  const c = new Scheduler({ dataDir: dir2, leaseMs: 150, freeTokensPerDay: 100, freeTokensPerIp: 0 });
  c._chargeUsage("1FreeUserAddr", { prompt_tokens: 30, completion_tokens: 30 }, null); // draws 60 free tokens
  check(c._freeTokensLeft("1FreeUserAddr", null) === 40, "baseline: 60 of 100 free tokens drawn");
  await c.close();
  const d = new Scheduler({ dataDir: dir2, leaseMs: 150, freeTokensPerDay: 100, freeTokensPerIp: 0 });
  check(d._freeTokensLeft("1FreeUserAddr", null) === 40, "free-tier draw SURVIVES a restart (FAILS on old: refilled to 100)");
  await d.close();

  // ---- 4: a stale freeday.json (yesterday) is ignored ----
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-resume3-"));
  fs.writeFileSync(path.join(dir3, "freeday.json"), JSON.stringify({ day: "2020-01-01", byAddr: { X: 99999 }, global: 99999, byIp: {} }));
  const e = new Scheduler({ dataDir: dir3, leaseMs: 150, freeTokensPerDay: 100, freeTokensPerIp: 0 });
  check(e._freeTokensLeft("X", null) === 100, "yesterday's counters ignored — the day roll still grants a fresh allowance");
  await e.close();

  // ---- 5: a settled epoch file is not resumed ----
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-resume4-"));
  const f = new Scheduler({ dataDir: dir4, leaseMs: 150 });
  f.receipts = [{ jobId: "r9", worker: W, jobType: "inference-eval", honest: true }];
  const closedEpoch = f.epoch;
  f.closeEpoch(); // file now carries a summary
  await f.close();
  const g = new Scheduler({ dataDir: dir4, leaseMs: 150 });
  check(g.epoch !== closedEpoch && g.receipts.length === 0, "a SETTLED epoch is never resumed (no double-settlement)");
  await g.close();

  console.log(failures ? `\nFAILED (${failures} check${failures > 1 ? "s" : ""})` : "\nAll epoch-resume checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
