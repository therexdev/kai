"use strict";

/*
 * Probe: §7.4 reputation-GATE enforcement (KAI_REPUTATION_ENFORCE, default OFF).
 *
 *   node scripts/probe-reputation-enforce.js
 *
 * Scenario: one PROVEN worker (90 days old, real paid history, clean challenge
 * record — clears the gate) vs a 4-node FRESH fleet doing 4× the eval volume
 * (passes challenges but sits below the gate). Small pool so it oversubscribes.
 *
 *  - Armed: the fleet's pool draw is ZERO, the proven worker's work mints, the
 *    pool ceiling holds, and unclaimed budget stays in reserve. FAILS on the
 *    old scheduler (option unknown -> flat pro-rata hands the fleet ~80%).
 *  - Equal-work-equal-pay invariant: identical PAID chats from a proven and a
 *    fresh worker mint IDENTICAL compute value — reputation never touches pay.
 *  - Unarmed (the deploy default): settlement is bit-identical to flat
 *    pro-rata — shipping this code changes nothing until the env flips.
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

const PROVEN = "1ProvenWorkerAddr";
const FLEET = ["1FleetAddr1", "1FleetAddr2", "1FleetAddr3", "1FleetAddr4"];

function seedWorkers(s) {
  const now = Date.now();
  s.workers.set("tokP", { address: PROVEN, models: ["koinos-fast"], firstSeen: now - 90 * 86400000, repPaidJobs: 500, lastSeen: now, seedsThisEpoch: 0, mystThisEpoch: 0 });
  s.perf[PROVEN] = { sr: 1, jobs: 50, chal: { t1: { ok: 20, bad: 0 }, t2: { ok: 10, bad: 0 } } };
  for (const [i, a] of FLEET.entries()) {
    s.workers.set("tokF" + i, { address: a, models: ["koinos-fast"], firstSeen: now, repPaidJobs: 0, lastSeen: now, seedsThisEpoch: 0, mystThisEpoch: 0 });
    s.perf[a] = { sr: 1, jobs: 5, chal: { t1: { ok: 5, bad: 0 } } }; // passes challenges — reputation is layer 2
  }
}
function evalReceipts() {
  const rs = [];
  let n = 0;
  for (let i = 0; i < 5; i++) rs.push({ jobId: "p" + n++, worker: PROVEN, jobType: "inference-eval", honest: true });
  for (const a of FLEET) for (let i = 0; i < 5; i++) rs.push({ jobId: "f" + n++, worker: a, jobType: "inference-eval", honest: true });
  return rs; // 5 proven + 20 fleet = 4:1 volume against the proven worker
}
function settleAll(s, receipts) {
  const budget = s._networkSubsidyBudget(receipts);
  const by = {};
  for (const a of [PROVEN, ...FLEET]) {
    by[a] = s._settleFor(receipts.filter((r) => r.worker === a), budget).workerSat;
  }
  return by;
}

async function main() {
  const POOL = String(10n * 100000000n); // 10 KAI — oversubscribed by 25 evals

  // ---- armed: the gate reshapes the pool split ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-repenf-"));
  const on = new Scheduler({ dataDir: dir, leaseMs: 150, epoch: 5000, bootstrapPoolSat: POOL, reputationEnforce: true });
  seedWorkers(on);
  const receipts = evalReceipts();
  const armed = settleAll(on, receipts);
  const fleetSat = FLEET.reduce((a, w) => a + armed[w], 0n);
  const totalSat = fleetSat + armed[PROVEN];
  check(fleetSat === 0n, `armed: below-gate fleet draws ZERO pool (got ${fleetSat}) — FAILS on old (~80% capture)`);
  check(armed[PROVEN] > 0n, `armed: the proven worker's work mints (${armed[PROVEN]} sat)`);
  check(totalSat <= BigInt(POOL), "armed: total mint stays under the pool ceiling");
  // Weighted demand (5 KAI × elig) is under the 10-KAI pool -> the proven
  // worker mints in full at its eligibility; the rest stays in reserve.
  check(totalSat < BigInt(POOL), "armed: unclaimed pool stays in reserve (not redistributed to anyone)");

  // ---- equal-work-equal-pay: PAID value is never reputation-weighted ----
  const paid = (worker) => ({ jobId: "c-" + worker, worker, jobType: "chat", modelClass: "koinos-fast", usage: { prompt_tokens: 100, completion_tokens: 100 }, totalTok: 200, freeTok: 0, honest: true });
  const pr = [paid(PROVEN), paid(FLEET[0])];
  const pb = on._networkSubsidyBudget(pr);
  const provenPaid = on._settleFor([pr[0]], pb).workerSat;
  const fleetPaid = on._settleFor([pr[1]], pb).workerSat;
  check(provenPaid === fleetPaid && provenPaid > 0n, `identical paid work mints identical pay regardless of reputation (${provenPaid} === ${fleetPaid})`);
  await on.close();

  // ---- unarmed (deploy default): bit-identical to flat pro-rata ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "probe-repenf2-"));
  const off = new Scheduler({ dataDir: dir2, leaseMs: 150, epoch: 5000, bootstrapPoolSat: POOL });
  seedWorkers(off);
  const flat = settleAll(off, receipts);
  const flatFleet = FLEET.reduce((a, w) => a + flat[w], 0n);
  // Flat pro-rata: 25 evals over a 10-KAI pool -> each receipt mints pool/25;
  // the fleet (20 receipts) takes exactly 4× the proven worker (5 receipts).
  check(flatFleet === 4n * flat[PROVEN] && flat[PROVEN] > 0n, "unarmed default: flat pro-rata unchanged (fleet 4x by volume — today's behavior)");
  check(off.reputationEnforce === false, "unarmed default: flag is OFF without the env (deploy changes nothing)");
  await off.close();

  console.log(failures ? `\nFAILED (${failures} check${failures > 1 ? "s" : ""})` : "\nAll reputation-enforcement checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
