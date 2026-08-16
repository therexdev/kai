"use strict";

/*
 * Probe: §51 phase-2 perf-fed routing.
 *
 * Standing rule: every scheduler behavior change ships with a probe that
 * FAILS on the old code and PASSES on the new. Run it twice:
 *
 *   node scripts/probe-perf-routing.js          # new code -> ALL PASS
 *   git stash -- lib/scheduler.js && node scripts/probe-perf-routing.js
 *                                               # old code -> FAILs
 *   git stash pop
 *
 * What it proves, over the real HTTP worker protocol with real koilib
 * signatures (in-process scheduler, two simulated workers):
 *   1. A chat job is reserved first for the worker the SERVER measured as
 *      faster (old code: first poller wins, so the slow parked worker
 *      takes it).
 *   2. A worker that takes jobs and never delivers accrues server-observed
 *      timeouts and its measured success rate falls (old code: nothing is
 *      tracked).
 *   3. That worker lands on probation and is never the preferred target.
 *   4. A signed consumer "auto" request no longer selects the probation
 *      worker's exclusive class (old code: auto picks the priciest class
 *      any live worker holds, failing or not).
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Signer } = require("koilib");
const { Scheduler, seedOnce, seedMysteryOnce } = require("../lib/scheduler");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PORT = 0;
const base = () => `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}

async function j(method, p, body) {
  const res = await fetch(base() + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function mkWorker(models) {
  const signer = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") });
  return { signer, address: signer.getAddress(), models, token: null };
}

async function register(w) {
  const r = await j("POST", "/worker/register", { address: w.address, models: w.models, capabilities: { ramGb: 64 } });
  if (!r.ok) throw new Error("registration failed");
  w.token = r.token;
}

async function poll(w, timeoutMs = 25000) {
  try {
    const res = await fetch(`${base()}/worker/next-job?token=${w.token}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return { job: null };
    return await res.json();
  } catch {
    return { job: null };
  }
}

async function submit(w, job, { completion = 50, tokPerSec = 10, output = "4" } = {}) {
  const hash = crypto.createHash("sha256").update(`${job.id}|${output}`).digest();
  const signature = Buffer.from(await w.signer.signHash(hash)).toString("base64");
  return j("POST", `/worker/result?token=${w.token}`, {
    jobId: job.id,
    output,
    usage: { prompt_tokens: 5, completion_tokens: completion },
    perf: { ms: 100, tokPerSec },
    signature,
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-route-"));
  const sched = new Scheduler({ dataDir: dir, leaseMs: 150 });
  PORT = await sched.listen(0);
  const A = mkWorker(["koinos-fast"]); // will measure slow, stay honest
  const B = mkWorker(["koinos-fast", "qwen25-32b"]); // fast, then starts failing
  await register(A);
  await register(B);

  // Rate both workers with one targeted eval each. Wall time is equal, so
  // the SERVER-measured speed differs purely by completion tokens: A ~25
  // tok/s, B ~3000 tok/s.
  for (const [w, tokens] of [
    [A, 3],
    [B, 400],
  ]) {
    await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "2+2?", forWorker: w.address });
    const r = await poll(w, 2000);
    if (!r.job) throw new Error("rating eval never reached a worker");
    await sleep(120);
    await submit(w, r.job, { completion: tokens });
  }

  console.log("probe 1: dispatch preference (fast worker gets the chat job)");
  const aParked = poll(A, 8000); // slow worker parks FIRST — old code hands it the job
  await sleep(100);
  await j("POST", "/operator/enqueue", { type: "chat", model: "koinos-fast", messages: [{ role: "user", content: "hi" }] });
  await sleep(250);
  const bRes = await poll(B, 3000); // fast worker arrives late — new code held the job for it
  const aRes = await aParked;
  check(!!(bRes.job && bRes.job.type === "chat"), "measured-faster worker B received the chat job");
  check(!aRes.job, "parked slower worker A did NOT receive it");
  if (bRes.job) await submit(B, bRes.job, { completion: 60, output: "hello" });

  console.log("probe 2: server-observed timeouts (B takes jobs, never delivers)");
  for (let i = 0; i < 4; i++) {
    await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "x", forWorker: B.address });
    const r = await poll(B, 2000);
    if (!r.job) throw new Error(`timeout eval ${i} never reached B`);
    await sleep(220); // lease (150ms) expires
    await j("GET", "/network/models"); // any request runs the reaper
    const drained = await poll(A, 2000); // requeued job is open again — A rescues it
    if (!drained.job) throw new Error(`requeued eval ${i} never reached A`);
    await submit(A, drained.job, { completion: 20 });
  }
  const status = await j("GET", "/network/status");
  const bRow = (status.workers || []).find((w) => w.address.startsWith(B.address.slice(0, 6)));
  check(!!(bRow && bRow.perf && bRow.perf.to >= 4), "B's lease expiries are tracked server-side (perf.to)");
  check(!!(bRow && bRow.perf && typeof bRow.perf.sr === "number" && bRow.perf.sr < 0.5), "B's measured success rate fell below 0.5");

  console.log("probe 3: probation");
  check(typeof sched._onProbation === "function" && sched._onProbation(B.address) === true, "B is on probation");
  check(
    typeof sched._preferredFor === "function" && sched._preferredFor("koinos-fast") === null,
    "no preference stamp with only one healthy candidate"
  );

  console.log("probe 4: signed consumer auto request avoids the probation worker's class");
  const consumer = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") });
  const answer = async (w) => {
    const r = await poll(w, 5000);
    if (r.job) await submit(w, r.job, { completion: 40, output: "net answer" });
  };
  const loops = Promise.all([answer(A), answer(B)]);
  const ts = Date.now();
  const messages = [{ role: "user", content: "hello network" }];
  const chash = crypto.createHash("sha256").update(`consume|${consumer.getAddress()}|${ts}|${JSON.stringify(messages)}`).digest();
  const csig = Buffer.from(await consumer.signHash(chash)).toString("base64");
  const resp = await j("POST", "/consume/chat/completions", {
    address: consumer.getAddress(),
    signature: csig,
    ts,
    messages,
    model: "auto",
  });
  check(resp.servedModel === "koinos-fast", `auto served the healthy class (got: ${resp.servedModel || JSON.stringify(resp.error || resp)})`);
  await loops;

  console.log("probe 5: server clamps inflated token counts (§17)");
  await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "2+2?", forWorker: A.address });
  const inflated = await poll(A, 2000);
  if (!inflated.job) throw new Error("clamp eval never reached A");
  await submit(A, inflated.job, { completion: 1500000, output: "4" });
  const lastReceipt = sched.receipts[sched.receipts.length - 1];
  check(
    lastReceipt && lastReceipt.usage.completion_tokens < 1000,
    `a 4-char output can't bill 1.5M tokens (receipt says: ${lastReceipt?.usage?.completion_tokens})`
  );

  console.log("probe 6: challenges are generated, not a memorizable fixed pool (§17)");
  const legacyPrompts = new Set([
    "What is 2+2? Reply with just the number.",
    "Name the capital of France in one word.",
    "Write one short sentence about local AI.",
  ]);
  const seen = [];
  for (let i = 0; i < 24; i++) {
    const job = seedOnce(sched);
    if (job) seen.push(job);
    sched.queue.splice(0); // drain so backpressure never blocks the next seed
  }
  check(
    seen.length >= 20 && seen.some((s) => !legacyPrompts.has(s.prompt)),
    "seeds include generated challenge prompts beyond the legacy pool"
  );

  console.log("probe 7: a worker actively streaming chunks keeps its lease (no false timeout)");
  await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "slow one", forWorker: A.address });
  const slowJob = await poll(A, 2000);
  if (!slowJob.job) throw new Error("chunk-lease eval never reached A");
  const toBefore = (sched.perf[A.address] && sched.perf[A.address].to) || 0;
  await sleep(100); // inside the 150ms lease
  await j("POST", `/worker/chunk?token=${A.token}`, { jobId: slowJob.job.id, delta: "wor" });
  await sleep(90); // past the ORIGINAL lease, inside the chunk-refreshed one
  await j("GET", "/network/models"); // runs the reaper
  check(sched.pending.has(slowJob.job.id), "chunk-streaming job is still leased past the original window");
  await j("POST", `/worker/chunk?token=${A.token}`, { jobId: slowJob.job.id, delta: "king" });
  await submit(A, slowJob.job, { completion: 10, output: "working" });
  const toAfter = (sched.perf[A.address] && sched.perf[A.address].to) || 0;
  check(toAfter === toBefore, "the slow-but-streaming worker was never timeout-blamed");

  console.log("probe 8: server-side stamps never reach the client");
  await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "2+2?", forWorker: A.address });
  const stamped = await poll(A, 2000);
  if (!stamped.job) throw new Error("stamped eval never reached A");
  check(
    !("forWorker" in stamped.job) && !("preferWorker" in stamped.job) && !("challenge" in stamped.job) && !("challengeTier" in stamped.job),
    "dispatched payload carries no forWorker/preferWorker/challenge fields"
  );
  await submit(A, stamped.job, { completion: 10 });

  console.log("probe 9: mystery chat — paid-path audit is shadow (records, never burns)");
  const myst1 = seedMysteryOnce(sched); // targets a live worker; A and B qualify
  if (!myst1) throw new Error("mystery seed produced nothing");
  const mTarget = myst1.forWorker === A.address ? A : B;
  const mPoll = await poll(mTarget, 2000);
  if (!mPoll.job) throw new Error("mystery chat never reached its target");
  check(
    mPoll.job.type === "chat" && Array.isArray(mPoll.job.messages) &&
      !("forWorker" in mPoll.job) && !("challenge" in mPoll.job) && !("challengeTier" in mPoll.job),
    "mystery chat is shaped exactly like a real consumer chat (no server fields leak)"
  );
  // Answer it correctly (compute from the actual prompt, whatever shape).
  const mExpected = String(myst1.challenge.expected);
  await submit(mTarget, mPoll.job, { completion: 8, output: mExpected });
  let rc = sched.receipts[sched.receipts.length - 1];
  check(rc.jobType === "chat" && rc.challenged && rc.honest === true, "correct mystery answer -> honest chat receipt");
  check(!!(sched.perf[mTarget.address].chal && sched.perf[mTarget.address].chal.t0), "mystery pass/fail recorded under tier 0 (not collapsed into t1)");
  const myst2 = seedMysteryOnce(sched);
  if (!myst2) throw new Error("second mystery seed produced nothing");
  const m2Target = myst2.forWorker === A.address ? A : B;
  const m2Poll = await poll(m2Target, 2000);
  if (!m2Poll.job) throw new Error("second mystery chat never reached its target");
  await submit(m2Target, m2Poll.job, { completion: 8, output: "totally wrong answer here" });
  rc = sched.receipts[sched.receipts.length - 1];
  check(rc.challenged && rc.honest === true, "SHADOW: wrong mystery answer is recorded but receipt is NOT burned");
  check(sched.perf[m2Target.address].chal.t0.bad >= 1, "the wrong mystery answer was recorded as a tier-0 fail");

  console.log("probe 10: answer-bank dump does NOT pass a normalized challenge");
  await j("POST", "/operator/enqueue", {
    type: "inference-eval", model: "koinos-fast", prompt: "add", expected: "42", norm: "digits", challengeTier: 1, forWorker: A.address,
  });
  const bankJob = await poll(A, 2000);
  if (!bankJob.job) throw new Error("answer-bank eval never reached A");
  await submit(A, bankJob.job, { completion: 12, output: "0 1 2 3 4 5 6 7 8 9 40 41 42 43 44" });
  rc = sched.receipts[sched.receipts.length - 1];
  check(rc.honest === false, "digit-dump carrying the answer is rejected (dominance check)");

  console.log("probe 11: tier-3 class discriminators run in shadow until armed");
  await j("POST", "/operator/enqueue", {
    type: "inference-eval", model: "qwen25-32b", prompt: "Reverse 'candle', capitals only.",
    expected: "ELDNAC", norm: "letters", challengeTier: 3, forWorker: B.address,
  });
  const t3a = await poll(B, 2000);
  if (!t3a.job) throw new Error("tier-3 eval never reached B");
  await submit(B, t3a.job, { completion: 6, output: "CANDLE" }); // wrong on purpose
  rc = sched.receipts[sched.receipts.length - 1];
  const bPerf = sched.perf[B.address];
  check(rc.honest === true && bPerf.chal && bPerf.chal.t3 && bPerf.chal.t3.bad >= 1, "shadow mode: tier-3 fail recorded, receipt NOT burned");
  sched.classEnforce = true;
  await j("POST", "/operator/enqueue", {
    type: "inference-eval", model: "qwen25-32b", prompt: "Reverse 'forest', capitals only.",
    expected: "TSEROF", norm: "letters", challengeTier: 3, forWorker: B.address,
  });
  const t3b = await poll(B, 2000);
  if (!t3b.job) throw new Error("second tier-3 eval never reached B");
  await submit(B, t3b.job, { completion: 6, output: "FOREST" });
  rc = sched.receipts[sched.receipts.length - 1];
  check(rc.honest === false, "armed: tier-3 fail burns the receipt");
  sched.classEnforce = false;

  console.log("probe 12: egregious token inflation earns strikes, then burns receipts");
  let lastHonest = null;
  for (let i = 0; i < 4; i++) {
    await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "hi", forWorker: A.address });
    const r = await poll(A, 2000);
    if (!r.job) throw new Error(`inflation eval ${i} never reached A`);
    await submit(A, r.job, { completion: 1900000, output: "x" });
    lastHonest = sched.receipts[sched.receipts.length - 1].honest;
  }
  const aPerf = sched.perf[A.address];
  check(aPerf.clampEgregious >= 4, "egregious clamps are counted");
  check(lastHonest === false, "fourth egregious inflation burns the receipt");

  console.log("probe 13: non-numeric usage cannot poison a receipt or crash settlement (CRITICAL)");
  await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "hi", forWorker: B.address });
  const nanJob = await poll(B, 2000);
  if (!nanJob.job) throw new Error("NaN eval never reached B");
  // Sign a result whose usage is a garbage object — the raw fetch, since our
  // submit() helper sends clean numbers.
  {
    const output = "4";
    const hash = crypto.createHash("sha256").update(`${nanJob.job.id}|${output}`).digest();
    const signature = Buffer.from(await B.signer.signHash(hash)).toString("base64");
    await j("POST", `/worker/result?token=${B.token}`, {
      jobId: nanJob.job.id, output, usage: { prompt_tokens: {}, completion_tokens: "abc" }, signature,
    });
  }
  rc = sched.receipts[sched.receipts.length - 1];
  check(Number.isFinite(rc.usage.prompt_tokens) && Number.isFinite(rc.usage.completion_tokens), "garbage usage coerced to finite numbers");
  // Prove settlement doesn't throw on the poisoned-turned-clean receipt.
  let closeOk = true;
  try { sched.closeEpoch(); } catch { closeOk = false; }
  check(closeOk, "epoch close does not throw (BigInt(NaN) can't happen)");

  await sched.close();

  // ---- Economics: network-wide bootstrap pool + daily free tier ----
  console.log("probe 14: bootstrap pool is network-wide, useful-work-divided, unused stays in reserve");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-econ-"));
    // Pool = 10 KAI/epoch. Each eval is nominally 1 KAI.
    const s2 = new Scheduler({ dataDir: dir, leaseMs: 150, bootstrapPoolSat: String(10n * 100000000n) });
    PORT = await s2.listen(0);
    const W = [];
    for (let i = 0; i < 3; i++) { const w = mkWorker(["koinos-fast"]); await register(w); W.push(w); }
    const runEvals = async (w, n) => {
      for (let i = 0; i < n; i++) {
        await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "2+2?", forWorker: w.address });
        const r = await poll(w, 2000);
        if (!r.job) throw new Error("econ eval never reached worker");
        await submit(w, r.job, { completion: 10, output: "4" });
      }
    };
    // Under-subscribed: 4 evals total, pool 10 KAI -> each mints full 1 KAI, 6 KAI unused.
    await runEvals(W[0], 4);
    let sum = s2.closeEpoch();
    let mintedKai = Number(sum.bootstrap.mintedSat) / 1e8;
    check(Math.abs(mintedKai - 4) < 1e-6, `under-subscribed: 4 evals mint 4 KAI, not the full 10 pool (got ${mintedKai})`);
    check(Number(sum.bootstrap.poolSat) === 10 * 1e8, "summary reports the network pool, not a per-worker cap");
    // Over-subscribed: 30 evals across workers, pool 10 KAI -> total mint capped at 10, pro-rata.
    await runEvals(W[0], 12); await runEvals(W[1], 12); await runEvals(W[2], 6);
    sum = s2.closeEpoch();
    mintedKai = Number(sum.bootstrap.mintedSat) / 1e8;
    check(mintedKai <= 10 + 1e-6 && mintedKai > 9.5, `over-subscribed: 30 evals mint ~10 KAI total (the pool), not 30 (got ${mintedKai})`);
    // Worker 0 did 2× worker 2's work -> earns ~2× the share (useful-work-divided).
    const e0 = Number(sum.totals[W[0].address] || 0), e2 = Number(sum.totals[W[2].address] || 0);
    check(e0 > e2 * 1.8 && e0 < e2 * 2.2, `pool divided by useful work: W0 (12 evals) ≈ 2× W2 (6 evals) [${e0} vs ${e2}]`);
    await s2.close();
  }

  console.log("probe 15: free tier is DAILY and has a global ceiling that pauses free (not paid)");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-free-"));
    // Global daily ceiling 100 tokens; per-account 80.
    const s3 = new Scheduler({ dataDir: dir, leaseMs: 150, freeTokensPerDay: 80, freeTokensPerDayGlobal: 100, freeTokensPerIp: 0 });
    PORT = await s3.listen(0);
    const a1 = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") }).getAddress();
    const a2 = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") }).getAddress();
    // Account 1 draws 80 (its whole daily allowance).
    s3._chargeUsage(a1, { prompt_tokens: 40, completion_tokens: 40 }, null, "koinos-fast");
    check(s3._freeTokensLeft(a1, null) === 0, "per-account daily allowance is exhausted after 80 tokens");
    // Account 2 should only get the remaining 20 of the 100 global ceiling.
    check(s3._freeTokensLeft(a2, null) === 20, "global ceiling caps a second account to the network remainder (20)");
    s3._chargeUsage(a2, { prompt_tokens: 20, completion_tokens: 40 }, null, "koinos-fast");
    check(s3._freeTokensLeft(a2, null) === 0 && s3.freeUsedGlobalDay === 100, "global daily free budget is fully spent");
    // A closeEpoch (15-min settlement) must NOT reset the daily free counters.
    s3.receipts.push({ honest: true, worker: a1, jobType: "chat", usage: { prompt_tokens: 1, completion_tokens: 1 } });
    s3.closeEpoch();
    check(s3.freeUsedGlobalDay === 100, "a settlement epoch close does NOT reset the daily free tier (the 96× bug stays fixed)");
    // Rolling the UTC day DOES reset it.
    s3.freeDay = "2000-01-01";
    check(s3._freeTokensLeft(a1, null) === 80, "a new UTC day restores the full daily allowance");
    await s3.close();
  }

  console.log("probe 16: consumption is authorized only against non-shrinkable (paid) earnings");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-debt-"));
    const s4 = new Scheduler({ dataDir: dir, leaseMs: 150, bootstrapPoolSat: String(15625n * 100000n) });
    PORT = await s4.listen(0);
    const wc = mkWorker(["koinos-fast"]); // worker+consumer, same wallet ("cover usage with work")
    await register(wc);
    // Earn a pile of EVAL (pool-subsidy) receipts only — no paid revenue.
    for (let i = 0; i < 6; i++) {
      await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "2+2?", forWorker: wc.address });
      const r = await poll(wc, 2000);
      if (!r.job) throw new Error("debt-probe eval never arrived");
      await submit(wc, r.job, { completion: 10, output: "4" });
    }
    // Guaranteed floor excludes the shrinkable pool subsidy -> eval-only
    // earnings authorize ZERO consumption spend (can't over-commit).
    const capMine = s4._consumeCapacity(wc.address, null);
    check(capMine.earningsLeftSat === 0n, "eval-only (pool-subsidy) earnings do NOT authorize consumption spend");
    await s4.close();
  }

  console.log("probe 17: a fractional pool config does not throw");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-frac-"));
    let ok = true;
    try { const s5 = new Scheduler({ dataDir: dir, bootstrapPoolSat: 15.625 * 1e8 }); await s5.listen(0); await s5.close(); }
    catch { ok = false; }
    check(ok, "constructor tolerates a fractional bootstrapPoolSat (rounded, no BigInt throw)");
  }

  console.log("\nECON PROBES PASSED");
  console.log(failures === 0 ? "\nPROBE PASSED" : `\nPROBE FAILED (${failures} assertion(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("probe aborted:", e.message);
  process.exit(1);
});
