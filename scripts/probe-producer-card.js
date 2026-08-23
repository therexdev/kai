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

  /* ------------------------------------------------------------------ */
  console.log("\n6) the account endpoint itself — ONLINE and offline");
  /*
   * The gap that shipped. Everything above tested the scheduler's STORE; none
   * of it touched /account/api/nodes, which has two branches. The producer was
   * added only to the offline one, so the card could appear exclusively on a
   * machine that was switched off — the opposite of every case that matters.
   * A tester saw three online nodes and no producer anywhere.
   */
  const express = require("express");
  const { createAccounts } = require("../lib/accounts");
  const accounts = createAccounts({ stateDir: tmp(), sendMail: async () => {}, siteOrigin: "http://127.0.0.1:0", onEvent: () => {} });

  const acct = accounts.service._newAccount({ email: "producer@example.com" });
  const session = accounts.service._issueSession(acct.id, "probe");
  const ts = Date.now();
  const sig = Buffer.from(await wallet.signHash(
    crypto.createHash("sha256").update(`link|${address}|${acct.id}|${ts}`).digest())).toString("base64");
  accounts.service.linkWallet(acct, { address, ts, signature: sig });

  // Mount the real route against the real scheduler.
  const app = express();
  app.use(express.json());
  const server = require("http").createServer(app);
  app.get("/account/api/nodes", (req, res) => {
    const a = accounts.requireAccount(req, res);
    if (!a) return;
    let live = [];
    try { live = sched.statsPublic({ detail: true }).workers || []; } catch { live = []; }
    const producerFor = (addr) => {
      for (const x of sched.workers.values()) if (x.address === addr) return x.producer || null;
      return null;
    };
    const nodes = (accounts.service.accountView(a).wallets || []).map((w) => {
      const on = live.find((x) => x.address === w.address) || null;
      return on
        ? { address: w.address, online: true, models: on.models || [], producer: producerFor(w.address) }
        : { address: w.address, online: false, neverSeen: false, producer: producerFor(w.address) };
    });
    res.json({ ok: true, nodes });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const nodesUrl = `http://127.0.0.1:${server.address().port}/account/api/nodes`;
  const getNodes = () =>
    fetch(nodesUrl, { headers: { cookie: `kai_session=${session}` } }).then((r) => r.json());

  await register(REAL);            // live registration, so this address is ONLINE
  const seenOnline = await getNodes();
  const mine = (seenOnline.nodes || []).find((n) => n.address === address);
  check(!!mine, "the account lists the wallet's node");
  check(mine?.online === true, "…and it is online, which is the case that was broken");
  check(!!mine?.producer, "…and the ONLINE node carries the producer (this failed before the fix)");
  check(Math.abs((mine?.producer?.producingVhp ?? 0) - REAL.producingVhp) < 1e-6,
    `…with the right VHP (${mine?.producer?.producingVhp})`);

  // And the offline path still works — it was the only one that ever did.
  for (const w of sched.workers.values()) if (w.address === address) w.lastSeen = 0;
  const seenOffline = await getNodes();
  const off = (seenOffline.nodes || []).find((n) => n.address === address);
  check(off?.online === false, "a node aged off the roster reads as offline");
  check(!!off?.producer, "…and still shows what it last reported");

  server.close();

  /* ------------------------------------------------------------------ */
  console.log("\n7) a stake is not public");
  // VHP is a holdings figure. It belongs on the owner's own page and nowhere
  // else — /network/status is public and truncates addresses precisely so
  // operator details do not leak.
  const pub = sched.statsPublic({ detail: true });
  const leaked = (pub.workers || []).filter((w) => w.producer != null);
  check(leaked.length === 0,
    `statsPublic carries no producer data — it feeds public /network/status (${leaked.length} leak(s))`);

  /* ------------------------------------------------------------------ */
  console.log("\n8) the real route, not the copy above");
  /*
   * Section 6 mounts a REPLICA of /account/api/nodes, because standing the
   * whole server up needs config this probe has no business owning. That
   * replica is also exactly the sort of stand-in that let the bug through in
   * the first place — a test can only be as right as its copy.
   *
   * So this reads server.js itself. The handler has TWO return paths, online
   * and offline, and the failure was one of them silently lacking `producer`.
   * Counting them is crude, and it is precisely the crudeness that would have
   * caught it.
   */
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = serverSrc.indexOf('app.get("/account/api/nodes"');
  check(start > 0, "found the real handler in server.js");
  const handler = serverSrc.slice(start, start + 4000);
  const producerLines = (handler.match(/producer:\s*producerFor\(/g) || []).length;
  check(producerLines >= 2,
    `both branches of the real handler return a producer — found ${producerLines}, expected 2 (online + offline)`);
  check(/const producerFor = /.test(handler),
    "…from one shared lookup, so the two branches cannot drift apart again");
  /*
   * The online branch's `on` object comes from statsPublic. Reading producer
   * off it would mean statsPublic had to carry the field — and statsPublic
   * feeds the PUBLIC /network/status, so that would publish every operator's
   * stake next to their address. Naming the exact expression is the check;
   * a looser pattern matched the unrelated `live = statsPublic(...)` line.
   */
  check(!/\bon\.producer\b/.test(serverSrc),
    "…and never off the statsPublic-derived object, which would leak stakes publicly");

  sched.close?.();
  console.log(failures ? `\n${failures} FAILED` : "\nPRODUCER CARD PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
