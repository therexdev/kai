"use strict";

/*
 * Probe: §20 settlement splits going ACTIVE (KAI_TREASURY_ADDR).
 *
 * This is the first flag that moves real money away from providers, so it
 * gets its own probe. Until a treasury is configured, the verification and
 * protocol shares fold back into compute — full pass-through. Configuring one
 * routes 3% + 7% to the treasury instead.
 *
 * HISTORY: the first cut of this flag split every chat receipt's MINTED
 * value — which on a free-tier chat is bootstrap-pool emission, so providers
 * lost 10% of pure subsidy while paid demand was zero. This probe surfaced
 * that; the owner ruled 2026-08-19 that role shares divide PAID value only
 * and emission passes through whole. Sections 5-8 pin the ruling — section 6
 * FAILS on the pre-ruling code, which is the point.
 *
 *   node scripts/probe-splits.js
 *
 * Old code / no treasury -> the activation assertions FAIL, which is the
 * point: this proves the flag actually did something.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Scheduler } = require("../lib/scheduler");
const { loadEnvFile } = require("../lib/env-file");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "probe-splits-"));
const KAI = 100000000n; // satoshi per KAI

function main() {
  // The address the production box will actually run with.
  const env = {};
  loadEnvFile(path.join(__dirname, "..", "deploy", "app.env"), env);
  const TREASURY = env.KAI_TREASURY_ADDR;

  console.log("\n1) the shipped config carries a payable treasury address");
  check(Boolean(TREASURY), `deploy/app.env sets KAI_TREASURY_ADDR (${TREASURY || "MISSING"})`);
  check(/^1[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(String(TREASURY)), "it is a full base58 Koinos address, not truncated or a placeholder");
  try {
    const { utils } = require("koilib");
    const bytes = utils.decodeBase58(String(TREASURY));
    check(bytes.length === 25 && bytes[0] === 0, "25-byte mainnet payload, version 0x00");
    check(utils.encodeBase58(bytes) === String(TREASURY), "base58 round-trips exactly — checksum intact");
  } catch (e) {
    check(false, `address decodes (${e.message})`);
  }

  console.log("\n2) with NO treasury the network stays full pass-through");
  const off = new Scheduler({ dataDir: tmp(), splits: { treasury: null } });
  const v = 1000n * KAI;
  const so = off._splitValueSat(v, "koinos-fast");
  check(so.verifySat === 0n && so.protocolSat === 0n, "verification and protocol shares are zero");
  check(so.computeSat === v - so.royaltySat, "everything except royalty goes to compute");
  check(so.computeSat + so.royaltySat + so.verifySat + so.protocolSat === v, "buckets sum to the value exactly");

  console.log("\n3) with the treasury set, 3% + 7% is routed away from compute");
  const on = new Scheduler({ dataDir: tmp(), splits: { treasury: TREASURY } });
  check(on.splits.treasury === TREASURY, "the scheduler carries the configured address");
  check(on.splits.verifyBps === 300 && on.splits.protocolBps === 700, `bps as documented (${on.splits.verifyBps}/${on.splits.protocolBps})`);
  const sn = on._splitValueSat(v, "koinos-fast");
  check(sn.verifySat === (v * 300n) / 10000n, `verification share is 3% (${sn.verifySat / KAI} KAI of 1000)`);
  check(sn.protocolSat === (v * 700n) / 10000n, `protocol share is 7% (${sn.protocolSat / KAI} KAI of 1000)`);
  check(sn.computeSat + sn.royaltySat + sn.verifySat + sn.protocolSat === v, "buckets STILL sum to the value exactly");
  const lost = so.computeSat - sn.computeSat;
  check(lost === (v * 1000n) / 10000n, `providers' compute share drops by exactly 10% of PAID value (${lost / KAI} KAI of 1000)`);

  console.log("\n4) no satoshi rounds away, at any value");
  // Awkward values that do not divide evenly by 10000 are where money leaks.
  let exact = true;
  let treasuryEverNegative = false;
  for (const amt of [1n, 7n, 9999n, 10001n, 123456789n, 1n * KAI + 1n, 33333333333n]) {
    const s = on._splitValueSat(amt, "koinos-fast");
    if (s.computeSat + s.royaltySat + s.verifySat + s.protocolSat !== amt) exact = false;
    if (s.computeSat < 0n || s.verifySat < 0n || s.protocolSat < 0n) treasuryEverNegative = true;
  }
  check(exact, "compute absorbs every rounding remainder across awkward amounts");
  check(!treasuryEverNegative, "no bucket ever goes negative on a tiny value");

  console.log("\n5) an epoch credits the treasury 10% of every chat receipt's PAID value");
  // A pool large enough that nothing is capped — today's normal case.
  const budget = { poolSat: 10n ** 14n, demandSat: 1n, eligPpmByAddr: null };
  const usage = { prompt_tokens: 1000, completion_tokens: 4000 };
  const paidChat = [{ worker: "1WorkerAAA", jobType: "chat", modelClass: "koinos-fast", usage, freeTok: 0, totalTok: 5000 }];
  const a = on._settleFor(paidChat, budget);
  const b = off._settleFor(paidChat, budget);
  check(a.treasurySat > 0n, `treasury accrues on a paid chat (${a.treasurySat} sat)`);
  check(a.treasurySat === b.workerSat - a.workerSat, "every satoshi the treasury gains is one the provider lost — nothing minted, nothing lost");
  check(a.treasurySat * 10n === b.workerSat, "that is exactly 10% (3% verification + 7% protocol)");
  check(
    a.splitTotals.computeSat + a.splitTotals.royaltySat + a.splitTotals.verifySat + a.splitTotals.protocolSat === b.workerSat + a.splitTotals.royaltySat,
    "epoch split totals reconcile against the pass-through baseline"
  );

  console.log("\n6) *** free-tier (pool-funded) chats are NEVER split — emission passes through whole ***");
  // Owner ruling 2026-08-19. The pre-ruling code split paidSat + minted
  // subsidy, so a FREE-TIER chat — funded by the bootstrap pool, not by a
  // paying customer — lost 10% to the treasury. Now the subsidy fraction
  // bypasses _splitValueSat entirely: activating the treasury must be
  // revenue-sharing, never an emission cut.
  const freeChat = [{ worker: "1WorkerAAA", jobType: "chat", modelClass: "koinos-fast", usage, freeTok: 5000, totalTok: 5000 }];
  const fa = on._settleFor(freeChat, budget);
  const fb = off._settleFor(freeChat, budget);
  check(fa.subsidyMintedSat > 0n, "this chat really is pool-funded (subsidy minted, no revenue)");
  check(fa.treasurySat === 0n, `the treasury takes NOTHING from emission (got ${fa.treasurySat} sat; pre-ruling code FAILS here)`);
  check(fa.workerSat === fb.workerSat, "provider earns identically with splits on or off");
  check(fa.workerSat === fa.subsidyMintedSat, "every minted subsidy satoshi lands on the provider");

  console.log("\n7) a half-free chat splits ONLY its paid half");
  // The mixed case is where the two rules visibly diverge: minted-value
  // splitting would cut the whole receipt; paid-value splitting cuts the
  // paid fraction and hands the subsidy fraction through untouched.
  const mixed = [{ worker: "1WorkerAAA", jobType: "chat", modelClass: "koinos-fast", usage, freeTok: 2500, totalTok: 5000 }];
  const ma = on._settleFor(mixed, budget);
  const mb = off._settleFor(mixed, budget);
  // Recover paidSat without duplicating scheduler internals: pass-through
  // worker pay is paid + minted subsidy, and the subsidy mint is reported.
  const mixedPaidSat = mb.workerSat - ma.subsidyMintedSat;
  check(ma.subsidyMintedSat > 0n && mixedPaidSat > 0n, "the receipt genuinely has both a paid and a subsidized fraction");
  check(ma.treasurySat === (mixedPaidSat * 1000n) / 10000n, "treasury gets exactly 10% of the PAID fraction alone");
  check(ma.treasurySat === mb.workerSat - ma.workerSat, "treasury gain equals provider delta — nothing minted, nothing lost");

  console.log("\n8) eval receipts are untouched");
  // Seed evals are flat useful-work value, not split. They dominate the
  // current job mix, which bounds today's real impact.
  const evals = [{ worker: "1WorkerAAA", jobType: "inference-eval" }];
  const ea = on._settleFor(evals, budget);
  const eb = off._settleFor(evals, budget);
  check(ea.treasurySat === 0n, "an eval receipt sends the treasury nothing");
  check(ea.workerSat === eb.workerSat, "and the provider earns identically either way");

  console.log(failures ? `\nSPLITS PROBE FAILED (${failures})` : "\nSPLITS PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main();
