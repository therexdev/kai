"use strict";

/*
 * Probe: §7.4 SHADOW reputation (Task #20).
 *
 *   node scripts/probe-reputation.js
 *
 * FAILS on a pre-reputation scheduler (no `_reputation`, no reputation in the
 * public stats) and PASSES once the shadow reputation ships. The load-bearing
 * assertion is the SHADOW INVARIANT: reputation is surfaced but NEVER changes
 * the bootstrap-pool split or anyone's pay — proven by settling the same
 * receipts with a worker's reputation mutated to both extremes and getting the
 * identical minted amount. Also checks the reputation math: floor at REP_MIN
 * for a fresh node, monotonic in network age, and the eligibility GATE
 * (elig 0 below the gate, ((r-gate)/(1-gate))^γ above it).
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Signer } = require("koilib");
const { Scheduler } = require("../lib/scheduler");

let PORT = 0;
const base = () => `http://127.0.0.1:${PORT}`;
let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}
async function j(method, p, body) {
  const res = await fetch(base() + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try { return await res.json(); } catch { return {}; }
}
function mkWorker(models) {
  const s = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") });
  return { signer: s, address: s.getAddress(), models, token: null };
}
async function register(w) {
  const r = await j("POST", "/worker/register", { address: w.address, models: w.models, capabilities: { ramGb: 64 } });
  if (!r.ok) throw new Error("registration failed");
  w.token = r.token;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-rep-"));
  const sched = new Scheduler({ dataDir: dir, leaseMs: 150 });
  PORT = await sched.listen(0);
  const A = mkWorker(["koinos-fast"]);
  await register(A);

  const hasRep = typeof sched._reputation === "function";
  check(hasRep, "_reputation method exists (FAILS on pre-reputation scheduler)");

  if (hasRep) {
    const now = Date.now();

    // Fresh worker: no age, no history -> sits at the floor, below the gate.
    const fresh = sched._reputation(A.address, now);
    check(fresh.r <= 0.06, `fresh worker sits near REP_MIN (r=${fresh.r})`);
    check(fresh.gated === false && fresh.elig === 0, "fresh worker below gate: elig 0, not gated");

    // Monotonic in network age: same worker, later clock -> higher reputation.
    const aged = sched._reputation(A.address, now + 60 * 86400000);
    check(aged.r > fresh.r, `reputation rises with network age (${fresh.r} -> ${aged.r})`);
    check(aged.sub.age > fresh.sub.age, "age sub-score increases with time");

    // Proven worker (old + reliable + passes challenges + real paid demand)
    // clears the gate; elig follows ((r-gate)/(1-gate))^gamma.
    const w = [...sched.workers.values()].find((x) => x.address === A.address);
    w.firstSeen = now - 90 * 86400000;
    w.repPaidJobs = 500;
    sched.perf[A.address] = { sr: 1, chal: { t1: { ok: 20, bad: 0 }, t2: { ok: 10, bad: 0 } } };
    const proven = sched._reputation(A.address, now);
    check(proven.gated === true && proven.elig > 0, `proven worker clears the gate (r=${proven.r}, elig=${proven.elig})`);
    const expElig = +Math.pow((proven.r - 0.45) / (1 - 0.45), 2).toFixed(3);
    check(Math.abs(proven.elig - expElig) < 0.02, `elig matches gated superlinear formula (${proven.elig} ~ ${expElig})`);

    // Unproven worker: below the gate -> elig 0 (would draw ZERO pool).
    w.firstSeen = now - 3600000;
    w.repPaidJobs = 0;
    sched.perf[A.address] = { sr: 0.2, chal: { t1: { ok: 1, bad: 5 } } };
    const weak = sched._reputation(A.address, now);
    check(weak.elig === 0, `unproven worker below gate has elig 0 (r=${weak.r})`);
  }

  // Reputation is surfaced in the detailed public stats (FAILS on old).
  const stats = sched.statsPublic({ detail: true });
  const row = (stats.workers || []).find((r) => r.address === A.address);
  check(row && row.reputation && typeof row.reputation.r === "number", "statsPublic detail includes per-worker reputation");

  // SHADOW INVARIANT: the bootstrap-pool split is identical regardless of the
  // worker's reputation. Settle a fixed receipt set, mutate reputation to the
  // extremes, settle again -> the minted amount must not move.
  const mkR = () => ({ jobId: crypto.randomUUID(), worker: A.address, jobType: "inference-eval", honest: true });
  const receipts = [mkR(), mkR(), mkR()];
  const settle = () => sched._settleFor(receipts, sched._networkSubsidyBudget(receipts)).workerSat.toString();
  const before = settle();
  const w2 = [...sched.workers.values()].find((x) => x.address === A.address);
  if (w2) { w2.firstSeen = Date.now() - 365 * 86400000; w2.repPaidJobs = 100000; }
  sched.perf[A.address] = { sr: 1, chal: { t1: { ok: 999, bad: 0 } } };
  const after = settle();
  check(before === after, `settlement is reputation-independent — SHADOW (${before} === ${after})`);

  await sched.close?.();
  console.log(failures ? `\nFAILED (${failures} check${failures > 1 ? "s" : ""})` : "\nAll reputation checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
