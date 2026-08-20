"use strict";

/*
 * Probe: the warming grace (A40 field finding 2026-08-20).
 *
 * A cold engine swap (loading a NON-resident model) runs longer than an
 * eval lease — 166s measured for a 32B against the 60s default — and the
 * old scheduler read that silence as a timeout: the job requeued and the
 * honest worker ate a "to" outcome, eight times in a row in the field,
 * with zero failed challenges. The worker now announces the swap on
 * POST /worker/warming and the job gets ONE fixed, non-renewable grace.
 *
 * Pins (fails on the pre-warming scheduler):
 *   1. /worker/warming grants a grace to the job's own worker (old: no route)
 *   2. the lease reaper holds the job through the grace — no requeue, no
 *      "to" strike (old: requeued + strike at lease expiry)
 *   3. a warming worker still counts as BUSY (no second job stacked on it)
 *   4. a result delivered inside the grace is accepted, outcome "ok"
 *   5. the grace is not immortality: unfinished past it -> requeue + "to"
 *   6. another worker's announcement grants nothing
 *
 *   KAI_WARM_GRACE_MS=1500 node scripts/probe-warming.js
 */

process.env.KAI_WARM_GRACE_MS = process.env.KAI_WARM_GRACE_MS || "1500";

const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const os = require("os");
const path = require("path");
const { Signer } = require("koilib");
const { Scheduler } = require("../lib/scheduler");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "probe-warming-"));

function main() {
  return new Promise((resolve, reject) => {
    const LEASE = 400; // ms — far under the 1500ms grace
    const sched = new Scheduler({ dataDir: tmp(), leaseMs: LEASE });
    const srv = http.createServer((req, res) => sched.handle(req, res).catch(reject));
    srv.listen(0, "127.0.0.1", async () => {
      try {
        const base = `http://127.0.0.1:${srv.address().port}`;
        const j = async (method, p, body) =>
          (await fetch(`${base}${p}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          })).json();

        const reg = async (seed) => {
          const signer = Signer.fromSeed(seed);
          const r = await j("POST", "/worker/register", {
            address: signer.getAddress(),
            capabilities: { ramGb: 48 },
            models: ["koinos-fast"],
          });
          return { signer, address: signer.getAddress(), token: r.token };
        };
        const A = await reg("probe-warming-A");
        const B = await reg("probe-warming-B");

        const enqueue = (id) => {
          sched.queue.push({ id, type: "inference-eval", model: "koinos-fast", prompt: "2+2?", createdAt: Date.now() });
        };
        const take = async (w) => (await j("GET", `/worker/next-job?token=${w.token}`)).job;

        console.log("\n1) the worker holding the job gets a warming grace");
        enqueue("wj1");
        const job1 = await take(A);
        check(job1 && job1.id === "wj1", "job dispatched to worker A");
        const g = await j("POST", `/worker/warming?token=${A.token}`, { jobId: "wj1" });
        check(g.ok === true && g.granted === true, "warming granted (old scheduler: no such route)");
        check(Number(g.graceMs) > LEASE, `grace (${g.graceMs}ms) outlives the lease (${LEASE}ms)`);

        console.log("\n2) the reaper holds the job through the grace — no requeue, no strike");
        await sleep(LEASE + 250); // lease long dead, grace still holding
        sched._reapPending();
        check(sched.pending.has("wj1"), "job still pending past the lease (old scheduler: requeued)");
        check(!(sched.perf[A.address]?.to > 0), "no timeout strike on the honest worker (old scheduler: to=1)");

        console.log("\n3) a warming worker is BUSY — no second job stacks on it");
        check(sched._busySet().has(A.address), "worker A still in the busy set during the swap");

        console.log("\n4) a result inside the grace lands normally");
        const output = "4";
        const hash = crypto.createHash("sha256").update(`wj1|${output}`).digest();
        const signature = Buffer.from(await A.signer.signHash(hash)).toString("base64");
        const rr = await j("POST", `/worker/result?token=${A.token}`, {
          jobId: "wj1",
          output,
          usage: { prompt_tokens: 5, completion_tokens: 1 },
          perf: { ms: 900, tokPerSec: 1.1 },
          signature,
        });
        check(rr.ok === true, "result accepted inside the grace");
        check((sched.perf[A.address]?.ok || 0) >= 1, "outcome recorded as ok");
        check(!(sched.perf[A.address]?.to > 0), "still zero timeout strikes");

        console.log("\n5) the grace is not immortality");
        enqueue("wj2");
        const job2 = await take(B);
        check(job2 && job2.id === "wj2", "second job dispatched to worker B");
        await j("POST", `/worker/warming?token=${B.token}`, { jobId: "wj2" });
        await sleep(Number(process.env.KAI_WARM_GRACE_MS) + 200); // outlive the grace
        sched._reapPending();
        check(!sched.pending.has("wj2"), "unfinished past the grace -> requeued");
        check((sched.perf[B.address]?.to || 0) === 1, "…and the timeout is honestly recorded");
        const requeued = sched.queue.find((x) => x.id === "wj2");
        check(Boolean(requeued) && !requeued.warmingUntil, "requeued job carries NO stale grace");

        console.log("\n6) another worker's announcement grants nothing");
        const j3 = sched.queue.find((x) => x.id === "wj2");
        const took = await take(A);
        check(took && took.id === "wj2", "requeued job re-dispatched (to worker A)");
        const gx = await j("POST", `/worker/warming?token=${B.token}`, { jobId: "wj2" });
        check(gx.granted === false, "worker B cannot warm worker A's job");
        check(!sched.pending.get("wj2")?.warmingUntil, "no grace was attached");
        void j3;

        console.log(failures ? `\nPROBE FAILED (${failures})` : "\nWARMING PROBE PASSED");
        srv.close();
        resolve(failures);
      } catch (e) {
        srv.close();
        reject(e);
      }
    });
  });
}

main().then(
  (f) => process.exit(f ? 1 : 0),
  (e) => {
    console.error("probe crashed:", e);
    process.exit(1);
  }
);
