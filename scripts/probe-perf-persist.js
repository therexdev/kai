"use strict";

/*
 * Probe: perf persists across restarts.
 *
 *   node scripts/probe-perf-persist.js
 *
 * The scheduler used to reset its server-measured perf map (routing quality:
 * sr, srvTokPerSec, per-tier challenge history, token-inflation strikes) to {}
 * on every boot — so a deploy/host-recycle cold-started routing and let a bad
 * actor launder its strike count with a restart. This asserts perf now survives
 * a restart: set perf, close an epoch (persists), construct a FRESH scheduler on
 * the same data dir (= a restart), and confirm the values came back.
 *
 * FAILS on the old scheduler (fresh perf is empty), PASSES on the new one.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-perfp-"));
  const ADDR = "1TestWorkerAddr";

  const s1 = new Scheduler({ dataDir: dir, leaseMs: 150 });
  s1.perf[ADDR] = {
    jobs: 5, tokPerSec: 20, cuRating: 1, srvTokPerSec: 12.3,
    ok: 4, to: 0, bad: 1, sr: 0.9,
    chal: { t1: { ok: 3, bad: 1 } }, clampEgregious: 2,
  };
  s1.closeEpoch(); // persists perf.json (empty epoch is safe — merkleRoot([]) is defined)

  // Simulate a restart: a brand-new scheduler on the same data dir.
  const s2 = new Scheduler({ dataDir: dir, leaseMs: 150 });
  const p = s2.perf[ADDR];

  check(!!p, "perf survives a restart (FAILS on old scheduler — perf reset to {})");
  check(p && p.jobs === 5 && p.srvTokPerSec === 12.3 && p.sr === 0.9, "restored perf values are exact");
  check(p && p.chal && p.chal.t1 && p.chal.t1.ok === 3 && p.chal.t1.bad === 1, "per-tier challenge history survives");
  check(p && p.clampEgregious === 2, "token-inflation strikes survive (a restart can't launder them)");

  // A fresh data dir must still start clean (no crash, empty perf).
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-perfp2-"));
  const s3 = new Scheduler({ dataDir: dir2, leaseMs: 150 });
  check(Object.keys(s3.perf).length === 0, "a fresh data dir starts with empty perf (no false restore)");

  console.log(failures ? `\nFAILED (${failures} check${failures > 1 ? "s" : ""})` : "\nAll perf-persistence checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
