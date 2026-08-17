"use strict";

/*
 * Probe: review-fix batch — settlement integrity across crashes.
 *
 *   node scripts/probe-settle-integrity.js
 *
 * Covers the adversarial-review fixes (all FAIL on the pre-fix scheduler):
 *  1. Charge-time durability: _chargeUsage + the receipt stamp persist the
 *     epoch state immediately — a hard kill right after a consumer charge can
 *     no longer resume receipts against a stale spend counter (the CRITICAL
 *     over-mint).
 *  2. Settlement is withheld when the close's persistence failed
 *     (summary.persisted === false) — an unpersisted epoch can never anchor
 *     on-chain and later be resumed/re-closed against its own root.
 *  3. Boot repair re-settles a persisted epoch whose on-chain settlement a
 *     crash swallowed (summary present, settlement missing).
 *  4. Price pinning: a resumed epoch settles at the price it OPERATED under,
 *     not the boot snapshot.
 *  5. firstSeen backfill: legacy roster entries (no firstSeen) get a clock at
 *     boot so the reputation age signal can accumulate.
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
  const W = "1IntegrityWorker";
  const C = "1IntegrityConsumer";

  // ---- 1. charge-time durability ----
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-integ1-"));
  const a = new Scheduler({ dataDir: dir1, leaseMs: 150, freeTokensPerDay: 0, freeTokensPerIp: 0 });
  a.receipts = [{ jobId: "e1", worker: C, jobType: "chat", modelClass: "koinos-fast", usage: { prompt_tokens: 1e6, completion_tokens: 1e6 }, totalTok: 2e6, freeTok: 0, honest: true }];
  a._persist(); // the receipt push's write
  // The consumer (who is also a worker with earnings) gets charged — the fix
  // persists the epoch state inside the charge path via _persist().
  a._chargeUsage(C, { prompt_tokens: 100, completion_tokens: 100 }, null);
  a._persist(); // consume handler persists right after the stamp (the fix)
  const epochNum = a.epoch;
  // HARD KILL: no close, no exit handler (simulate by just abandoning `a`).
  const onDisk = a.store.readEpoch(epochNum);
  check(onDisk && onDisk.spentSat && BigInt(onDisk.spentSat[C] || "0") > 0n, "durable spend counter is CURRENT after a charge (over-mint window closed)");
  await a.close();

  // ---- 2. settlement withheld when persistence failed ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-integ2-"));
  const b = new Scheduler({ dataDir: dir2, leaseMs: 150 });
  let settled = 0;
  b.settlement = { settleEpoch: async () => { settled += 1; return { rootTx: "tx" }; } };
  b.receipts = [{ jobId: "e2", worker: W, jobType: "inference-eval", honest: true }];
  // Break the store for the close only: every grouped save throws.
  const realSaveEpoch = b.store.saveEpoch.bind(b.store);
  b.store.saveEpoch = () => { throw new Error("disk full"); };
  const summary = b.closeEpoch();
  check(summary.persisted === false, "a failed close persist is OBSERVED (summary.persisted=false)");
  await b.settleClosedEpoch(summary);
  check(settled === 0, "settlement WITHHELD for an unpersisted epoch (no on-chain anchor to poison)");
  b.store.saveEpoch = realSaveEpoch;
  await b.close();

  // ---- 3. boot repair re-settles a stranded epoch ----
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-integ3-"));
  const c = new Scheduler({ dataDir: dir3, leaseMs: 150, epoch: 7000 });
  c.store.saveEpoch(7000, { epoch: 7000, receipts: [], summary: { epoch: 7000, root: "abc", receipts: 1, totals: { [W]: "5" } } }); // persisted but never settled
  let resettled = [];
  c.settlement = { settleEpoch: async (s) => { resettled.push(s.epoch); return { rootTx: "tx2" }; } };
  const n = await c.recoverPendingSettlements();
  check(n === 1 && resettled[0] === 7000, "boot repair re-settles a persisted-but-unanchored epoch");
  check((c.store.readEpoch(7000).summary.settlement || {}).rootTx === "tx2", "repair writes the settlement back to the stored epoch");
  const n2 = await c.recoverPendingSettlements();
  check(n2 === 0, "repair is idempotent — a settled epoch is not re-submitted");
  await c.close();

  // ---- 4. price pinning across resume ----
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-integ4-"));
  const d = new Scheduler({ dataDir: dir4, leaseMs: 150 });
  d.price = { usd: 0.123, status: "live", updatedAt: "t", microPerKai: 123000n, satPerMicro: 813n };
  d.receipts = [{ jobId: "e4", worker: W, jobType: "inference-eval", honest: true }];
  d._persist();
  await d.close();
  const e = new Scheduler({ dataDir: dir4, leaseMs: 150 });
  check(e.price.usd === 0.123 && e.price.satPerMicro === 813n && e.price.status === "resumed", `resumed epoch restores its OPERATING price (usd=${e.price.usd}, status=${e.price.status})`);
  await e.close();

  // ---- 5. firstSeen backfill for legacy rosters ----
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-integ5-"));
  fs.mkdirSync(dir5, { recursive: true });
  fs.writeFileSync(path.join(dir5, "workers.json"), JSON.stringify({ tokL: { address: W, models: ["koinos-fast"], lastSeen: Date.now() } })); // pre-feature entry: no firstSeen
  const f = new Scheduler({ dataDir: dir5, leaseMs: 150 });
  const lw = [...f.workers.values()][0];
  check(Number.isFinite(lw.firstSeen) && lw.firstSeen > 0, "legacy roster entry gets a reputation clock at boot (age can accumulate)");
  const onDiskW = JSON.parse(fs.readFileSync(path.join(dir5, "workers.json"), "utf8"));
  check(Number.isFinite(onDiskW.tokL.firstSeen), "the backfilled clock is persisted durably");
  await f.close();

  console.log(failures ? `\nFAILED (${failures} check${failures > 1 ? "s" : ""})` : "\nAll settlement-integrity checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
