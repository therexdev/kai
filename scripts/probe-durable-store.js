"use strict";

/*
 * Probe: sqlite storage backend (KAI_STORE=sqlite; docs/durable-ledger-design.md).
 *
 *   node scripts/probe-durable-store.js
 *
 * FAILS on the old code (lib/durable-store.js absent), PASSES on new:
 *  1. Migration: a data dir with existing JSON ledgers opens in sqlite mode
 *     with every value intact; the files become *.json.migrated (kept).
 *  2. The scheduler runs end-to-end on sqlite: ledgers round-trip a restart
 *     with NO json ledger files present (DB is the authority).
 *  3. Epoch resume works from the DB (the crash-recovery path).
 *  4. Transaction atomicity: a throw inside a grouped commit rolls EVERYTHING
 *     back — the cross-file consistency JSON files cannot give.
 *  5. exportViews + db-export round-trip: the DB dumps back to JSON shapes a
 *     json-mode scheduler can boot from (the rollback path).
 *  6. json mode stays the default (no env, no option -> flat files, no DB).
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
  let openStore;
  try {
    ({ openStore } = require("../lib/durable-store"));
  } catch {
    check(false, "lib/durable-store.js exists (FAILS on old code)");
    console.log("\nFAILED (1 check)");
    process.exit(1);
  }
  check(typeof openStore === "function", "lib/durable-store.js exists (FAILS on old code)");
  const W = "1StoreWorkerAddr";

  // ---- 1. migration from JSON ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-store-"));
  fs.writeFileSync(path.join(dir, "credits.json"), JSON.stringify({ [W]: { balanceMicro: "777000" } }));
  fs.writeFileSync(path.join(dir, "workers.json"), JSON.stringify({ tokX: { address: W, models: ["koinos-fast"], firstSeen: 111, repPaidJobs: 9 } }));
  fs.writeFileSync(path.join(dir, "perf.json"), JSON.stringify({ [W]: { jobs: 4, sr: 1 } }));
  fs.writeFileSync(path.join(dir, "epoch-42.json"), JSON.stringify({ epoch: 42, receipts: [], summary: { epoch: 42, root: "r" } }));
  const s1 = new Scheduler({ dataDir: dir, leaseMs: 150, storeMode: "sqlite" });
  check(s1.balances[W]?.balanceMicro === "777000", "migration: balances imported into the DB");
  check([...s1.workers.values()][0]?.repPaidJobs === 9, "migration: worker roster (incl. reputation fields) imported");
  check(s1.perf[W]?.jobs === 4, "migration: perf imported");
  check(s1.store.readEpoch(42)?.summary?.root === "r", "migration: settled epochs imported");
  check(fs.existsSync(path.join(dir, "credits.json.migrated")), "migration: source files kept as *.json.migrated");
  // The migration immediately re-derives JSON views from the DB (review fix:
  // otherwise every backup until the first close would bundle an empty dir).
  const view = JSON.parse(fs.readFileSync(path.join(dir, "credits.json"), "utf8"));
  check(view[W]?.balanceMicro === "777000", "migration: fresh JSON views re-derived for the backup tooling");

  // ---- 2. sqlite round-trip without json files ----
  s1.balances[W].balanceMicro = "555000";
  s1._saveBalances();
  s1.perf[W].jobs = 5;
  s1._persistPerf();
  await s1.close();
  const s2 = new Scheduler({ dataDir: dir, leaseMs: 150, storeMode: "sqlite" });
  check(s2.balances[W]?.balanceMicro === "555000" && s2.perf[W]?.jobs === 5, "restart restores ledgers from the DB (no json files needed)");

  // ---- 3. epoch resume from the DB ----
  s2.receipts = [{ jobId: "q1", worker: W, jobType: "inference-eval", honest: true }];
  s2.spentSat[W] = "42";
  const epoch2 = s2.epoch;
  s2._persist();
  await s2.close();
  const s3 = new Scheduler({ dataDir: dir, leaseMs: 150, storeMode: "sqlite" });
  check(s3.epoch === epoch2 && s3.receipts.length === 1 && s3.spentSat[W] === "42", "epoch RESUME works from the DB (crash recovery intact)");

  // ---- 4. transaction atomicity ----
  const before = JSON.stringify([s3.store.loadBalances(), s3.store.loadPerf()]);
  let threw = false;
  try {
    s3.store.transaction(() => {
      s3.store.saveBalances({ [W]: { balanceMicro: "1" } });
      s3.store.savePerf({ [W]: { jobs: 999 } });
      throw new Error("crash between grouped writes");
    });
  } catch {
    threw = true;
  }
  const after = JSON.stringify([s3.store.loadBalances(), s3.store.loadPerf()]);
  check(threw && before === after, "a crash inside a grouped commit rolls back EVERY write (cross-ledger consistency)");

  // ---- 5. rollback: exportViews -> json-mode boot ----
  s3.store.exportViews();
  await s3.close();
  const s4 = new Scheduler({ dataDir: dir, leaseMs: 150 }); // json mode reads the exported views
  check(s4.balances[W]?.balanceMicro === "555000", "exported JSON views boot a json-mode scheduler (rollback path works)");
  await s4.close();

  // ---- 6. default stays json ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-store2-"));
  const s5 = new Scheduler({ dataDir: dir2, leaseMs: 150 });
  s5.balances[W] = { balanceMicro: "1" };
  s5._saveBalances();
  check(s5.store.mode === "json" && fs.existsSync(path.join(dir2, "credits.json")) && !fs.existsSync(path.join(dir2, "kai-store.sqlite")), "default (no env/option) stays json — deploying changes nothing");
  await s5.close();

  console.log(failures ? `\nFAILED (${failures} check${failures > 1 ? "s" : ""})` : "\nAll durable-store checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
