"use strict";

/*
 * Probe: the public AI-node payout roster (GET /scheduler/network/roster).
 *
 * Standing rule: every scheduler behavior change ships with a probe that
 * FAILS on the old code and PASSES on the new. Run it twice:
 *
 *   node scripts/probe-roster.js                # new code -> ALL PASS
 *   git stash -- lib/scheduler.js && node scripts/probe-roster.js
 *                                               # old code -> FAILs
 *   git stash pop
 *
 * Why this endpoint exists: Free Koinos Node splits its block-reward profit
 * across eligible nodes, one category being "running a Koinos AI node". It
 * polls this roster through the day and pays the addresses it finds ON CHAIN.
 * That makes two properties load-bearing, and this probe pins both:
 *
 *   · addresses must be FULL. /network/status truncates for display
 *     ("1AbCdE…wXyZ"); a truncated address fails the consumer's checksum and
 *     nobody gets paid. The truncation there is deliberate and stays.
 *   · liveness must mean the SAME thing here as on /network/status, or the
 *     two surfaces disagree about who was serving during a snapshot.
 *
 * Everything below runs over the real HTTP worker protocol against an
 * in-process scheduler with real koilib-signed workers.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Signer } = require("koilib");
const { Scheduler } = require("../lib/scheduler");

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

/* Privileged routes now fail CLOSED when no operator secret is configured
   (FIND-CFG-001) — they used to be open to anyone in exactly that case, which
   is what these probes were unknowingly relying on. So the probe carries a
   secret and presents it, the way a real operator does. */
const OPERATOR_SECRET = "probe-operator-secret";

async function j(method, p, body) {
  const res = await fetch(base() + p, {
    method,
    headers: { "content-type": "application/json", "x-operator-secret": OPERATOR_SECRET },
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

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-roster-"));
  // A short lease so a "busy" worker can be aged past the liveness window
  // inside a probe run without the reaper reclaiming its job first.
  const sched = new Scheduler({ operatorSecret: OPERATOR_SECRET, dataDir: dir, leaseMs: 60000 });
  PORT = await sched.listen(0);

  const A = mkWorker(["koinos-fast"]);
  const B = mkWorker(["koinos-fast"]);
  const C = mkWorker(["koinos-fast"]);
  for (const w of [A, B, C]) await register(w);

  console.log("\n1) every live provider is listed, with a full payable address");
  const raw = await fetch(`${base()}/network/roster`);
  const r1 = await raw.json();
  check(raw.status === 200, "responds 200");
  check(r1.ok === true, "ok:true");
  check(Array.isArray(r1.workers), "workers is an array");
  check(r1.count === r1.workers.length, `count matches the array (${r1.count})`);
  check(
    [A, B, C].every((w) => r1.workers.includes(w.address)),
    "all three registered providers appear"
  );
  check(
    r1.workers.every((a) => !a.includes("…") && !a.includes("...")),
    "no address is truncated — a shortened address is not payable"
  );
  check(
    r1.workers.every((a) => /^1[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(a)),
    "every entry is a full base58 Koinos address"
  );
  check(new Set(r1.workers).size === r1.workers.length, "addresses are de-duplicated");
  check(raw.headers.get("cache-control") === "no-store", "Cache-Control: no-store (a stale roster pays departed nodes)");
  check(JSON.stringify(r1).length < 2 * 1024 * 1024, "response is well under the 2 MB ceiling");

  console.log("\n2) the roster tracks the SAME liveness rule as /network/status");
  const st = await j("GET", "/network/status");
  check(
    st.workersOnline === r1.count,
    `workersOnline (${st.workersOnline}) equals roster count (${r1.count}) — one definition of "live"`
  );
  check(
    (st.workers || []).every((w) => w.address.includes("…")),
    "/network/status still truncates — this change did not weaken it"
  );

  console.log("\n3) a provider silent past the liveness window drops out");
  // Age B and C beyond 90s without touching A.
  const now = Date.now();
  sched.workers.get(B.token).lastSeen = now - 91000;
  sched.workers.get(C.token).lastSeen = now - 600000;
  const r2 = await j("GET", "/network/roster");
  check(r2.workers.includes(A.address), "the still-polling provider stays");
  check(!r2.workers.includes(B.address), "a provider 91s silent is gone (window is 90s, not 'ever registered')");
  check(!r2.workers.includes(C.address), "a long-departed provider is gone");
  check(r2.count === 1, `count follows (${r2.count})`);

  console.log("\n4) a provider BUSY mid-job stays listed without a recent poll");
  // Hand C a job and mark it dispatched now: it is working, not polling.
  await j("POST", "/operator/enqueue", { type: "inference-eval", model: "koinos-fast", prompt: "2+2?", forWorker: C.address });
  const got = await fetch(`${base()}/worker/next-job?token=${C.token}`, { signal: AbortSignal.timeout(25000) }).then((x) => x.json());
  check(Boolean(got.job), "the busy provider picked up a job");
  // Polling refreshed lastSeen; push it back past the window so ONLY the
  // busy set can keep this provider on the roster.
  sched.workers.get(C.token).lastSeen = Date.now() - 600000;
  const r3 = await j("GET", "/network/roster");
  check(
    r3.workers.includes(C.address),
    "a provider deep in a long generation is still earning, so it is still on the payout roster"
  );
  check(!r3.workers.includes(B.address), "…while the genuinely absent one stays off");

  console.log("\n5) a provider is paid ONCE, however many entries it has");
  // Standby resume, the watchdog and token refresh all re-register
  // mid-epoch, each minting a fresh token. Registration prunes the old
  // entry, so a refresh must not change the roster at all.
  const beforeReg = (await j("GET", "/network/roster")).count;
  await register(A); // same address, fresh token
  check(
    [...sched.workers.values()].filter((w) => w.address === A.address).length === 1,
    "re-registration replaces the entry rather than adding one"
  );
  const rReg = await j("GET", "/network/roster");
  check(rReg.count === beforeReg, `a token refresh does not change the roster (${rReg.count})`);
  check(rReg.workers.filter((a) => a === A.address).length === 1, "…and the address appears once");

  // De-duplication is the roster's OWN guarantee, not something inherited
  // from registration hygiene: if two live entries ever share an address
  // (a future code path, a restored snapshot), the payout list must still
  // carry it once or that node takes a double share of the distribution.
  sched.workers.set("wt_probe_duplicate", { ...[...sched.workers.values()].find((w) => w.address === A.address), lastSeen: Date.now() });
  check(
    [...sched.workers.values()].filter((w) => w.address === A.address).length === 2,
    "two live entries now genuinely share one address"
  );
  const r4 = await j("GET", "/network/roster");
  check(r4.workers.filter((a) => a === A.address).length === 1, "the roster still lists that address exactly once");
  check(r4.count === beforeReg, `count is unaffected by the duplicate (${r4.count})`);
  sched.workers.delete("wt_probe_duplicate");

  console.log("\n6) shape is exactly what the consumer parses");
  const keys = Object.keys(r4).sort().join(",");
  check(keys === "count,ok,workers", `top-level keys are ok/count/workers (got ${keys})`);
  check(typeof r4.count === "number" && r4.workers.every((a) => typeof a === "string"), "count is a number, workers are plain strings");

  await sched.close();
  console.log(failures ? `\nROSTER PROBE FAILED (${failures})` : "\nROSTER PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("PROBE ERROR:", e.stack || e.message);
  process.exit(1);
});
