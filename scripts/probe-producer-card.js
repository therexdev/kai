"use strict";

/*
 * PRODUCER CARD — the Koinos block producer, from a worker's registration to
 * the account page.
 *
 * The path is: the desktop app reads its own block_producer log, works out its
 * share, and sends a snapshot with the worker registration it already makes.
 * The scheduler sanitises and stores it; the account page draws it.
 *
 * Three properties, in order of how much they'd cost to get wrong:
 *
 *   1. it is DISPLAY ONLY. Nothing about it is verified, so it must never
 *      reach routing, reputation or payouts. A node that claims a huge share
 *      must not thereby be favoured or paid.
 *   2. garbage in is not garbage out — Infinity, NaN, strings and absurd
 *      magnitudes become null, which renders as unknown.
 *   3. a node that stops producing stops showing a producer, rather than
 *      leaving a stale card that says it still is.
 *
 * The numbers used are a real node's, read off its logs on 2026-08-23.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Signer } = require("koilib");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-prodcard-"));

// Exactly what the desktop computes from the log lines the owner pasted.
const REAL = {
  producingVhp: 659.46173948,
  networkVhp: 5298037.50481388,
  sharePct: 0.012447,
  oneInBlocks: 8033.9,
  blocksPerDay: 3.5848,
  hoursPerBlock: 6.695,
  at: "2026-08-23T06:40:09Z",
};

async function main() {
  const { Scheduler } = require("../lib/scheduler");
  const sched = new Scheduler({ dataDir: tmp(), onEvent: () => {} });
  const port = await sched.listen();
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const wallet = Signer.fromSeed("probe-producer-card");
  const address = wallet.getAddress();
  const register = (producer) =>
    post("/worker/register", { address, models: ["koinos-fast"], capabilities: { ramGb: 16 }, producer });
  const workerRecord = () => [...sched.workers.values()].find((w) => w.address === address);

  /* ---------------------------------------------------------------- */
  console.log("\n1) a producing node reports, and the numbers survive the trip");
  const reg = await register(REAL);
  check(reg.status === 200 && reg.body.ok, `registration accepted (${reg.status})`);
  const p = workerRecord()?.producer;
  check(!!p, "the snapshot is stored on the worker");
  check(Math.abs(p.producingVhp - REAL.producingVhp) < 1e-6, `producing VHP intact (${p?.producingVhp})`);
  check(Math.abs(p.networkVhp - REAL.networkVhp) < 1e-6, "network VHP intact");
  check(Math.abs(p.blocksPerDay - REAL.blocksPerDay) < 1e-6, `blocks/day intact (${p?.blocksPerDay})`);
  check(p.at === REAL.at, "and the timestamp it was read at");

  /* ---------------------------------------------------------------- */
  console.log("\n2) THE security property: it is display only");
  // A node claiming an absurd share must not gain anything by it. The claim is
  // stored for its own account page and read by nothing else.
  await register({ ...REAL, producingVhp: 1e11, sharePct: 99.9, blocksPerDay: 28800 });
  const rep = sched._reputation(address, Date.now(), workerRecord());
  const boasted = workerRecord().producer;
  check(boasted.sharePct === 99.9, "the boast is stored verbatim (it is the user's own page)");
  check(rep.r <= 0.5 + 1e-9, `…but reputation is unmoved by it (r=${rep.r})`);
  /*
   * Nothing outside the account view may READ this field. The one legitimate
   * mention is sanitising the request body on the way in (`b.producer`);
   * anything else — reading it off a stored worker to make a decision — is the
   * failure this guards against, because the value is unverified.
   */
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "scheduler.js"), "utf8");
  const mentions = (src.match(/\w+\.producer\b/g) || []);
  const reads = mentions.filter((m) => m !== "b.producer");
  check(reads.length === 0,
    `scheduler never reads the stored value back — found ${JSON.stringify(reads)}, expected none`);

  /* ---------------------------------------------------------------- */
  console.log("\n3) garbage becomes unknown, not a number");
  for (const [label, bad] of [
    ["Infinity", { producingVhp: Infinity, networkVhp: 5e6 }],
    ["NaN", { producingVhp: NaN, networkVhp: NaN }],
    ["strings", { producingVhp: "lots", networkVhp: "loads" }],
    ["negative", { producingVhp: -5, networkVhp: -5 }],
    ["absurd", { producingVhp: 1e30, networkVhp: 1e30 }],
    ["an array", ["nope"]],
    ["a string", "nope"],
  ]) {
    await register(bad);
    const got = workerRecord().producer;
    const clean = got == null || (got.producingVhp == null && got.networkVhp == null) ||
      [got.producingVhp, got.networkVhp, got.sharePct, got.blocksPerDay]
        .every((v) => v == null || Number.isFinite(v));
    check(clean, `${label} → nothing pretending to be a number`);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n4) a node that stops producing stops claiming to");
  await register(REAL);
  check(!!workerRecord().producer, "producing…");
  await register(null);           // the Koinos node was switched off
  check(workerRecord().producer === null,
    "…and once it stops, no stale card is left behind saying it still is");

  /* ---------------------------------------------------------------- */
  console.log("\n5) an AI-only machine is unaffected");
  const plain = await register(undefined);
  check(plain.status === 200 && plain.body.ok, "a worker that never runs a node still registers fine");
  check(workerRecord().producer === null, "and simply has no producer to show");
  check(Array.isArray(workerRecord().models) && workerRecord().models.length === 1,
    "its models are untouched by any of this");

  sched.close?.();
  console.log(failures ? `\n${failures} FAILED` : "\nPRODUCER CARD PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
