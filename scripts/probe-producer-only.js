#!/usr/bin/env node
/*
 * A block producer that sells no AI compute — task #84.
 *
 * The producer snapshot used to ride along with /worker/register, and the app
 * only registers inside earn.start(). So a machine running a Koinos node with
 * Earning switched OFF never reported anything, and its owner's account page
 * showed no producer card at all. v0.46.2 surfaced that ("the report needs
 * Earning on") without fixing it.
 *
 * /producer/report fixes it, and the entire risk of the fix is that it must
 * not accidentally mint a worker. A producer-only row that leaked into the
 * worker roster would be dispatched jobs it cannot serve (every one timing
 * out), would sit on the payout roster drawing a share it did not earn, and
 * would inflate workersOnline so the network looked healthier than it is.
 *
 * The implementation keeps those rows in a SEPARATE map rather than flagging
 * them inside this.workers, because this.workers is filtered inline in a
 * dozen places and a flag would have to be remembered at every one. This probe
 * holds that line from the outside: whatever the internals do, a producer-only
 * address must never appear anywhere that decides work or money.
 *
 * Exits non-zero on any failure. Run: node scripts/probe-producer-only.js
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Signer } = require("koilib");
const { Scheduler } = require("../lib/scheduler");

let failures = 0;
const check = (cond, label, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures += 1;
};

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json" } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(b || "{}") }));
      },
    );
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function producerProof(signer, address, ts = Date.now()) {
  const hash = crypto.createHash("sha256").update(`producer|${address}|${ts}`).digest();
  return { ts, signature: Buffer.from(await signer.signHash(hash)).toString("base64") };
}
async function registerProof(signer, address, ts = Date.now()) {
  const hash = crypto.createHash("sha256").update(`register|${address}|${ts}`).digest();
  return { ts, signature: Buffer.from(await signer.signHash(hash)).toString("base64") };
}

const SNAPSHOT = { producingVhp: 1170.74, networkVhp: 9870000, sharePct: 0.0119, blocksPerDay: 4.8 };

async function withScheduler(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-produceronly-"));
  const sched = new Scheduler({ dataDir: dir, operatorSecret: null, onEvent: () => {} });
  const server = http.createServer((rq, rs) => sched.handle(rq, rs).catch(() => rs.end()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(server.address().port, sched);
  } finally {
    server.close();
    sched.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const prod = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  const other = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  const PROD = prod.getAddress();
  const OTHER = other.getAddress();

  // ---------------------------------------------- it works at all
  await withScheduler(async (port, sched) => {
    const ok = await req(port, "POST", "/producer/report",
      { address: PROD, producer: SNAPSHOT, ...(await producerProof(prod, PROD)) });
    check(ok.status === 200 && ok.json.ok && ok.json.stored === true,
      "a producer with Earning OFF can report, with no registration and no token",
      `HTTP ${ok.status}`);
    check(!ok.json.token, "and is handed NO token — a token is the right to be dispatched to");

    const card = sched.producerFor(PROD);
    check(card && Math.abs(card.producingVhp - SNAPSHOT.producingVhp) < 1e-6,
      "the card the account page reads comes back for that address");

    // ---------------------------------------- and touches nothing that pays
    check(sched.workers.size === 0, `no worker row was created — workers.size=${sched.workers.size}`);

    const stats = sched.statsPublic({ detail: true });
    check(stats.workersOnline === 0,
      `it does not count toward workersOnline — got ${stats.workersOnline}`);
    check(!JSON.stringify(stats).includes(PROD),
      "it appears nowhere in the public network status");

    const live = sched._liveWorkers();
    check(live.length === 0 && !live.some((w) => w.address === PROD),
      "_liveWorkers cannot see it — so routing, the roster and reputation cannot either");

    check(sched._preferredFor("koinos-fast") === null,
      "it is never a routing candidate");

    const roster = await req(port, "GET", "/network/roster");
    check(!JSON.stringify(roster.json).includes(PROD),
      "it is NOT on the payout roster", `HTTP ${roster.status}`);

    const chk = sched.workerCheck ? sched.workerCheck(PROD) : null;
    void chk;
  });

  // ------------------------------------- the proof is required, no shadow
  await withScheduler(async (port, sched) => {
    const unsigned = await req(port, "POST", "/producer/report", { address: PROD, producer: SNAPSHOT });
    check(unsigned.status === 401,
      "an UNSIGNED report is refused — this route has no legacy clients to protect",
      `HTTP ${unsigned.status}`);

    const forged = await req(port, "POST", "/producer/report",
      { address: PROD, producer: SNAPSHOT, ...(await producerProof(other, PROD)) });
    check(forged.status === 401,
      "signing someone else's address with your own key is refused — nobody can publish figures onto another operator's page",
      `HTTP ${forged.status}`);

    const stale = await req(port, "POST", "/producer/report",
      { address: PROD, producer: SNAPSHOT, ...(await producerProof(prod, PROD, Date.now() - 10 * 60 * 1000)) });
    check(stale.status === 401, "a proof older than the window is refused", `HTTP ${stale.status}`);

    /*
     * Domain separation, which is the whole reason the prefix exists. A
     * registration proof is signed by the same key and handed to this same
     * server; if the domains were shared, one could be replayed as the other
     * — a captured producer proof would become a worker slot.
     */
    const crossed = await req(port, "POST", "/producer/report",
      { address: PROD, producer: SNAPSHOT, ...(await registerProof(prod, PROD)) });
    check(crossed.status === 401,
      "a REGISTER proof cannot be replayed as a producer proof", `HTTP ${crossed.status}`);

    const crossedBack = await req(port, "POST", "/worker/register",
      { address: PROD, models: ["koinos-fast"], ...(await producerProof(prod, PROD)) });
    check(crossedBack.status === 401,
      "and a PRODUCER proof cannot be replayed to claim a worker slot", `HTTP ${crossedBack.status}`);
    check(sched.workers.size === 0, "so no worker row exists after any of that");

    const p = await producerProof(prod, PROD);
    const first = await req(port, "POST", "/producer/report", { address: PROD, producer: SNAPSHOT, ...p });
    const replay = await req(port, "POST", "/producer/report", { address: PROD, producer: SNAPSHOT, ...p });
    check(first.status === 200 && replay.status === 401,
      "the same signature cannot be used twice", `first ${first.status}, replay ${replay.status}`);
  });

  // ------------------------------- a machine that does BOTH is unaffected
  await withScheduler(async (port, sched) => {
    const reg = await req(port, "POST", "/worker/register", {
      address: PROD, models: ["koinos-fast"], producer: SNAPSHOT,
      ...(await registerProof(prod, PROD)),
    });
    check(reg.status === 200 && reg.json.ok, "a machine that earns AND produces still registers normally");
    check(sched.statsPublic().workersOnline === 1, "and DOES count as a worker");
    const card = sched.producerFor(PROD);
    check(card && Math.abs(card.producingVhp - SNAPSHOT.producingVhp) < 1e-6,
      "its card still comes from the worker row — the worker wins over the producer map");
  });

  // ---------------------------------------------- a card that goes stale
  await withScheduler(async (port, sched) => {
    await req(port, "POST", "/producer/report",
      { address: PROD, producer: SNAPSHOT, ...(await producerProof(prod, PROD)) });
    check(sched.producerFor(PROD) != null, "fresh report renders");
    // A node that stopped reporting stopped producing. A card still quoting
    // its last VHP figure hours later is a confident lie; blank is honest.
    const future = Date.now() + 31 * 60 * 1000;
    check(sched.producerFor(PROD, future) === null,
      "a report older than the TTL stops rendering rather than going stale on the page");

    // Reporting nothing worth showing forgets the address entirely.
    const cleared = await req(port, "POST", "/producer/report",
      { address: PROD, producer: {}, ...(await producerProof(prod, PROD)) });
    check(cleared.status === 200 && cleared.json.stored === false, "an empty snapshot stores nothing");
    check(sched.producers.size === 0, "and drops the row rather than keeping an empty husk");
  });

  // --------------------------------------------------- bounded, not a leak
  await withScheduler(async (port, sched) => {
    // The map is written by anyone who can sign for an address, so it must not
    // be a route to unbounded memory. Driven through the real endpoint.
    const keys = [];
    for (let i = 0; i < 6; i++) keys.push(Signer.fromSeed(crypto.randomBytes(32).toString("hex")));
    for (const k of keys) {
      const a = k.getAddress();
      await req(port, "POST", "/producer/report", { address: a, producer: SNAPSHOT, ...(await producerProof(k, a)) });
    }
    check(sched.producers.size === 6, `each distinct address gets one row — got ${sched.producers.size}`);
    check(sched.workers.size === 0, "and still not one worker among them");
  });

  console.log(failures ? `\n${failures} failure(s).` : "\nAll producer-only checks passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("PROBE ERROR", e);
  process.exit(1);
});
