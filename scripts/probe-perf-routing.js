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
const { Scheduler, seedOnce } = require("../lib/scheduler");

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

  await sched.close();
  console.log(failures === 0 ? "\nPROBE PASSED" : `\nPROBE FAILED (${failures} assertion(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("probe aborted:", e.message);
  process.exit(1);
});
