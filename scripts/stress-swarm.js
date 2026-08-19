#!/usr/bin/env node
"use strict";

/*
 * Stress harness: a synthetic swarm against a LOCAL scheduler — the Beta
 * capacity rehearsal. Never points at production; it boots its own Scheduler
 * on a temp dir and hammers it over real HTTP with the real protocol
 * (register with fingerprint, long-poll next-job, chunk, signed result;
 * consumers sign /consume/chat/completions exactly like the app).
 *
 *   node scripts/stress-swarm.js
 *   WORKERS=80 CHATS=800 CONCURRENCY=40 KAI_STORE=sqlite node scripts/stress-swarm.js
 *
 * Measures: time-to-first-response and completion latency for consumers,
 * dispatch fairness across identical workers, queue depth, /network/status
 * latency under load, and epoch close + persist time with the full receipt
 * set. Asserts the invariants Beta depends on; prints a BASELINE block for
 * the capacity record.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Signer } = require("koilib");

process.env.KAI_STORE = process.env.KAI_STORE || "sqlite";

const { Scheduler } = require("../lib/scheduler");

const WORKERS = Number(process.env.WORKERS || 40);
const CHATS = Number(process.env.CHATS || 400);
const CONCURRENCY = Number(process.env.CONCURRENCY || 25);
// Simulated generation time per job. Zero would overstate §51 concentration:
// an instant worker is never busy, so the measured-fastest few would absorb
// the whole load — production workers are busy for seconds and jobs spill
// over to the rest of the fleet. SERVE_MS=0 for pure scheduler-overhead runs.
const SERVE_MS = process.env.SERVE_MS != null ? Number(process.env.SERVE_MS) : 600;
const MODEL = "koinos-fast";

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures += 1;
};
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

function jreq(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, json: b ? JSON.parse(b) : {} }); }
          catch { resolve({ status: res.statusCode, text: b }); }
        });
      }
    );
    r.on("error", reject);
    r.setTimeout(180000, () => r.destroy(new Error("timeout")));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

/** A synthetic provider speaking the real worker protocol in-process. */
function makeWorker(port, seed, fingerprint) {
  const signer = Signer.fromSeed(`stress-worker-${seed}`);
  const address = signer.getAddress();
  let token = null;
  let stopped = false;
  let served = 0;

  async function register() {
    const r = await jreq(port, "POST", "/worker/register", {
      address,
      models: [MODEL],
      capabilities: { ramGb: 32 },
      fingerprint,
    });
    token = r.json.token;
  }

  async function loop() {
    await register();
    while (!stopped) {
      let r;
      try {
        r = await jreq(port, "GET", `/worker/next-job?token=${token}`);
      } catch {
        continue; // long-poll cycle ended; poll again
      }
      if (stopped) break;
      if (r.status === 401) { await register(); continue; }
      const job = r.json?.job;
      if (!job) continue;
      // Fabricated generation: bounded output, believable usage/perf. The
      // point is the SCHEDULER under load, not inference.
      const output = `stress answer ${job.id} ` + "lorem ".repeat(40);
      if (SERVE_MS > 0) await new Promise((r) => setTimeout(r, SERVE_MS / 2 + Math.random() * SERVE_MS));
      await jreq(port, "POST", `/worker/chunk?token=${token}`, { jobId: job.id, delta: output.slice(0, 64) }).catch(() => {});
      const hash = crypto.createHash("sha256").update(`${job.id}|${output}`).digest();
      const signature = Buffer.from(await signer.signHash(hash)).toString("base64");
      const usage = { prompt_tokens: 24, completion_tokens: 48 };
      await jreq(port, "POST", `/worker/result?token=${token}`, {
        jobId: job.id, output, usage, perf: { ms: 400, tokPerSec: 120 }, signature,
      }).catch(() => {});
      served += 1;
    }
  }

  return { address, loop, stop: () => { stopped = true; }, count: () => served };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-stress-"));
  const sched = new Scheduler({
    dataDir: dir,
    operatorSecret: null,
    // The throughput phase must not trip the free-tier ceilings (they get
    // their own phase below): every consumer here shares 127.0.0.1.
    freeTokensPerDay: 10_000_000,
    freeTokensPerDayGlobal: 0,
    onEvent: () => {},
  });
  sched.freeTokensPerIp = 0; // 0 = uncapped per-IP for phase 1
  const server = http.createServer((rq, rs) => sched.handle(rq, rs).catch(() => rs.end()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  console.log(`swarm: ${WORKERS} workers, ${CHATS} chats @ concurrency ${CONCURRENCY}, serve≈${SERVE_MS}ms, store=${process.env.KAI_STORE}`);

  // Half the fleet shares one device fingerprint — the collision surface
  // gets exercised at scale in the same run.
  const workers = Array.from({ length: WORKERS }, (_, i) =>
    makeWorker(port, i, i < WORKERS / 2 ? "deadbeefdeadbeef" : crypto.randomBytes(8).toString("hex")));
  const loops = workers.map((w) => w.loop());
  await new Promise((r) => setTimeout(r, 500)); // all registered

  const st0 = await jreq(port, "GET", "/network/status");
  ok(`all ${WORKERS} workers registered and live`, st0.json.workersOnline === WORKERS, String(st0.json.workersOnline));

  // ---- phase 1: consumer load ----
  const consumers = Array.from({ length: 10 }, (_, i) => Signer.fromSeed(`stress-consumer-${i}`));
  const latencies = [];
  const errors = { http: 0, quota: 0, timeout: 0 };
  let maxQueue = 0;
  const qWatch = setInterval(() => { maxQueue = Math.max(maxQueue, sched.queue.length); }, 100);

  let sent = 0;
  async function oneChat(i) {
    const consumer = consumers[i % consumers.length];
    const messages = [{ role: "user", content: `stress question ${i}: say something` }];
    const ts = Date.now();
    const hash = crypto.createHash("sha256")
      .update(`consume|${consumer.getAddress()}|${ts}|${JSON.stringify(messages)}`).digest();
    const signature = Buffer.from(await consumer.signHash(hash)).toString("base64");
    const t0 = Date.now();
    try {
      const r = await jreq(port, "POST", "/consume/chat/completions", {
        messages, model: MODEL, address: consumer.getAddress(), ts, signature, stream: false,
      });
      if (r.status === 200) latencies.push(Date.now() - t0);
      else if (r.status === 402) errors.quota += 1;
      else errors.http += 1;
    } catch {
      errors.timeout += 1;
    }
  }

  const t0 = Date.now();
  const inFlight = new Set();
  for (let i = 0; i < CHATS; i++) {
    while (inFlight.size >= CONCURRENCY) await Promise.race(inFlight);
    const p = oneChat(i).finally(() => inFlight.delete(p));
    inFlight.add(p);
    sent += 1;
  }
  await Promise.all(inFlight);
  const wallMs = Date.now() - t0;
  clearInterval(qWatch);

  ok(`every chat answered — ${latencies.length}/${CHATS}`, latencies.length === CHATS,
    `quota=${errors.quota} http=${errors.http} timeout=${errors.timeout}`);
  const p50 = pct(latencies, 50), p95 = pct(latencies, 95), p99 = pct(latencies, 99);
  ok("p95 completion bounded (serve time + scheduling overhead)", p95 != null && p95 < Math.max(5000, SERVE_MS * 6), `p95=${p95}ms serve≈${SERVE_MS}ms`);

  // Distribution: §51 perf-fed routing CONCENTRATES paid work on measured-
  // fast workers by design (faster hardware earns more by completing more
  // work), and cold start is fair SEEDING's job (auto-ops, not run here).
  // So concentration is REPORTED for the record, and the asserted floor is
  // that dispatch spreads at all rather than pinning to one winner.
  const counts = workers.map((w) => w.count());
  const nonzero = counts.filter((c) => c > 0).length;
  const mx = Math.max(...counts);
  ok(`dispatch spreads beyond a single winner — ${nonzero}/${WORKERS} served`, nonzero >= WORKERS / 2, JSON.stringify(counts));
  ok("no single worker serves the majority of all chats", mx < CHATS / 2, `top worker=${mx}/${CHATS}`);

  // Status stays fast while the fleet is registered.
  const s0 = Date.now();
  const stLoad = await jreq(port, "GET", "/network/status");
  const statusMs = Date.now() - s0;
  ok("/network/status answers under 500ms with the fleet online", statusMs < 500, `${statusMs}ms`);
  const fpPeers = (stLoad.json.workers || []).filter((w) => w.fpPeers > 0).length;
  ok(`the shared-device half is visible as collisions — ${fpPeers} workers with fpPeers>0`, fpPeers === Math.floor(WORKERS / 2));

  // ---- phase 2: epoch close + settle math + persistence, full receipt set ----
  const c0 = Date.now();
  const summary = sched.closeEpoch();
  const closeMs = Date.now() - c0;
  const receipts = summary.receipts ?? summary.served ?? "?";
  ok(`epoch closed over the full receipt set in under 5s`, closeMs < 5000, `${closeMs}ms, receipts=${JSON.stringify(receipts).slice(0, 40)}`);
  ok("summary persisted durably", summary.persisted === true);
  ok("every serving worker holds a claim packet",
    workers.filter((w) => w.count() > 0).every((w) => summary.claims[w.address]),
    `claims=${Object.keys(summary.claims).length}`);
  ok("the collision group is in the epoch record",
    Array.isArray(summary.fingerprintGroups?.deadbeefdeadbeef) &&
    summary.fingerprintGroups.deadbeefdeadbeef.length === Math.floor(WORKERS / 2));

  // ---- phase 3: the per-IP free ceiling actually bites (separate scheduler) ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "kai-stress2-"));
  const sched2 = new Scheduler({ dataDir: dir2, operatorSecret: null, freeTokensPerDay: 1000000, onEvent: () => {} });
  sched2.freeTokensPerIp = 50; // tiny: one chat's usage exhausts it
  const server2 = http.createServer((rq, rs) => sched2.handle(rq, rs).catch(() => rs.end()));
  await new Promise((r) => server2.listen(0, "127.0.0.1", r));
  const port2 = server2.address().port;
  const w2 = makeWorker(port2, 999, "cafecafecafecafe");
  const l2 = w2.loop();
  await new Promise((r) => setTimeout(r, 300));
  const capConsumer = Signer.fromSeed("stress-cap-consumer");
  const capChat = async () => {
    const messages = [{ role: "user", content: "cap check" }];
    const ts = Date.now();
    const hash = crypto.createHash("sha256").update(`consume|${capConsumer.getAddress()}|${ts}|${JSON.stringify(messages)}`).digest();
    const signature = Buffer.from(await capConsumer.signHash(hash)).toString("base64");
    return jreq(port2, "POST", "/consume/chat/completions", { messages, model: MODEL, address: capConsumer.getAddress(), ts, signature });
  };
  const first = await capChat();
  const second = await capChat();
  ok("free tier serves the first request", first.status === 200, String(first.status));
  ok("…and the per-IP ceiling then pauses free usage with the friendly 402", second.status === 402,
    String(second.status));
  w2.stop(); server2.close(); void l2;

  for (const w of workers) w.stop();
  server.close();

  console.log("\nBASELINE (record in docs)");
  console.log(`  workers=${WORKERS} chats=${CHATS} concurrency=${CONCURRENCY} store=${process.env.KAI_STORE}`);
  console.log(`  wall=${(wallMs / 1000).toFixed(1)}s throughput=${(CHATS / (wallMs / 1000)).toFixed(1)} chats/s`);
  console.log(`  latency p50=${p50}ms p95=${p95}ms p99=${p99}ms maxQueueDepth=${maxQueue}`);
  console.log(`  spread: ${nonzero}/${WORKERS} served, top worker ${mx}/${CHATS} (§51 concentration is by design; seeding covers cold start)`);
  console.log(`  epochClose=${closeMs}ms statusUnderLoad=${statusMs}ms`);
  console.log(failures ? `\nSTRESS SWARM FAILED (${failures})` : "\nSTRESS SWARM PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
