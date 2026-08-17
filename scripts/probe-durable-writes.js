"use strict";

/*
 * Probe: durable-storage phase 0 — atomic money-path writes + exit persistence.
 *
 *   node scripts/probe-durable-writes.js
 *
 * Two behaviors, both FAIL on the old scheduler and PASS on the new one:
 *
 * 1. CRASH MID-WRITE CANNOT CORRUPT A LEDGER. Simulated by stubbing
 *    fs.writeFileSync to write half the bytes to its target and then throw
 *    (what a SIGKILL/host recycle mid-write leaves on disk). Old code wrote
 *    straight to credits.json -> the ledger itself ends up truncated garbage
 *    and every balance is lost on restart. New code writes to credits.json.tmp
 *    -> only the tmp is garbage; the real ledger still parses.
 *
 * 2. PERF SURVIVES process.exit(). The runtime-log's SIGTERM/crash handlers
 *    terminate via process.exit(); close-only persistence lost everything
 *    earned since the last epoch close (field finding: two auto-deploys inside
 *    one epoch wiped perf twice on 2026-08-17). A child process sets perf and
 *    calls process.exit(0) WITHOUT closing an epoch; the parent asserts
 *    perf.json exists anyway.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Scheduler } = require("../lib/scheduler");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}

async function main() {
  // ---- 1. crash mid-write ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-durable-"));
  const s = new Scheduler({ dataDir: dir, leaseMs: 150 });
  s.balances["1SomeConsumerAddr"] = { balanceMicro: "123456789" };
  s._saveBalances(); // good ledger on disk
  const creditsPath = path.join(dir, "credits.json");
  check(JSON.parse(fs.readFileSync(creditsPath, "utf8"))["1SomeConsumerAddr"].balanceMicro === "123456789", "baseline: ledger written and parseable");

  // Stub: half-write then throw — the on-disk shape a kill mid-write leaves.
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, data, ...rest) => {
    realWrite(p, String(data).slice(0, Math.floor(String(data).length / 2)), ...rest);
    throw new Error("simulated crash mid-write");
  };
  s.balances["1SomeConsumerAddr"].balanceMicro = "999999999";
  try {
    s._saveBalances(); // swallows internally (best-effort) — the write dies mid-way
  } finally {
    fs.writeFileSync = realWrite;
  }
  let survived = null;
  try {
    survived = JSON.parse(fs.readFileSync(creditsPath, "utf8"));
  } catch {
    /* corrupted — old behavior */
  }
  check(!!survived, "ledger still parses after a crash mid-write (FAILS on old: truncated JSON)");
  check(survived && survived["1SomeConsumerAddr"].balanceMicro === "123456789", "ledger holds the last GOOD state (no partial write visible)");
  await s.close();

  // ---- 2. perf survives process.exit() ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-durable2-"));
  const child = `
    const { Scheduler } = require(${JSON.stringify(path.join(__dirname, "../lib/scheduler.js"))});
    const s = new Scheduler({ dataDir: ${JSON.stringify(dir2)}, leaseMs: 150 });
    s.perf["1ExitWorkerAddr"] = { jobs: 7, srvTokPerSec: 5.5, sr: 1, ok: 7, chal: { t1: { ok: 2, bad: 0 } } };
    process.exit(0); // how the runtime-log's SIGTERM handler terminates
  `;
  execFileSync(process.execPath, ["-e", child], { stdio: "ignore" });
  let perf = null;
  try {
    perf = JSON.parse(fs.readFileSync(path.join(dir2, "perf.json"), "utf8"));
  } catch {
    /* not persisted — old behavior */
  }
  check(!!perf && perf["1ExitWorkerAddr"] && perf["1ExitWorkerAddr"].jobs === 7, "perf persists through process.exit() without an epoch close (FAILS on old)");

  // ---- 3. listener hygiene: many schedulers, no exit-listener leak ----
  const before = process.listenerCount("exit");
  const many = [];
  for (let i = 0; i < 12; i++) many.push(new Scheduler({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "probe-durable3-")), leaseMs: 150 }));
  for (const m of many) await m.close();
  check(process.listenerCount("exit") === before, "close() deregisters the exit listener (no leak across instances)");

  console.log(failures ? `\nFAILED (${failures} check${failures > 1 ? "s" : ""})` : "\nAll durable-write checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
