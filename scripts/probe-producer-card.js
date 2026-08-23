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


// The scheduler bounds every number it will render. Rather than reach into the
// module, push a value through the real path and read back what survived.
async function _shortfall(register, workerRecord, REAL, v) {
  await register({ ...REAL, stakeBehind: true, stakeShortfallPct: v });
  return workerRecord().producer.stakeShortfallPct;
}

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
  /*
   * WRITES are fine — registration and the refresh endpoint both store it.
   * What must never appear is a READ of the stored value, because nothing
   * verifies it. So: ignore `b.producer` (the request body) and anything
   * immediately assigned to, and flag whatever is left.
   */
  const mentions = (src.match(/\w+\.producer\b\s*=?/g) || []).map((m) => m.trim());
  const reads = mentions.filter((m) => !m.endsWith("=") && m !== "b.producer");
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

  /* ------------------------------------------------------------------ */
  console.log("\n9) refreshing the snapshot without re-registering");
  /*
   * Reported as "the account page isn't updating", and it wasn't: the snapshot
   * used to ride ONLY on registration, and a healthy worker with a live long
   * poll may not re-register for hours. So the machine now refreshes it on its
   * own cadence through this endpoint — small, token-authenticated, and
   * crucially NOT a re-registration, because registering mints a new token and
   * kills the in-flight poll.
   */
  const reg2 = await register(REAL);
  const tok = reg2.body.token;
  check(!!tok, "registration returns the token the refresh authenticates with");

  const moved = { ...REAL, producingVhp: 700.5, nodeValueUsd: 12.34, dailyUsd: 0.31, basis: "measured", daysTracked: 22 };
  const up = await post(`/worker/producer?token=${encodeURIComponent(tok)}`, { producer: moved });
  check(up.status === 200 && up.body.ok, `refresh accepted (${up.status})`);
  const after = workerRecord().producer;
  check(Math.abs(after.producingVhp - 700.5) < 1e-6, "the new reading replaced the old one");
  check(Math.abs(after.nodeValueUsd - 12.34) < 1e-6, "…including the dollar figures the dashboard shows");
  check(after.basis === "measured" && after.daysTracked === 22, "…and how much history they rest on");

  // The token still works afterwards: a refresh must not disturb earning.
  const stillMine = sched.workers.get(tok);
  check(!!stillMine, "the worker's token still resolves — no re-registration happened");

  const forged = await post("/worker/producer?token=not-a-real-token", { producer: moved });
  check(forged.status === 401, `a stranger cannot write to someone's row (${forged.status})`);

  /* ------------------------------------------------------------------ */
  console.log("\n10) the dashboard page is wired and gated");
  const dashSrc = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.js"), "utf8");
  const serverSrc2 = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const acctSrc = fs.readFileSync(path.join(__dirname, "..", "public", "account.html"), "utf8");

  check(/app\.get\("\/dashboard"/.test(serverSrc2), "/dashboard is a route");
  check(/redirect\("\/account\?next=\/dashboard"\)/.test(serverSrc2),
    "…gated: a signed-out browser gets a door, not a 401");
  check(/no-store/.test(serverSrc2.slice(serverSrc2.indexOf('app.get("/account/api/nodes"'), serverSrc2.indexOf('app.get("/account/api/nodes"') + 900)),
    "…and the node data is no-store, so a cache cannot serve last hour's numbers");

  // The two links the owner asked for, in both directions.
  check(/href="\/app"/.test(fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8")),
    "the dashboard links to chat");
  check(/href="\/account"/.test(fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8")),
    "…and to the account page");
  check(/href="\/dashboard"/.test(acctSrc), "and the account page links to the dashboard");

  // The split: AI detail must no longer be rendered by the account page.
  check(!/srvTokPerSec/.test(acctSrc),
    "the account page no longer renders node performance — that moved to the dashboard");
  check(/srvTokPerSec/.test(dashSrc), "…and the dashboard does render it");
  check(/basis === "measured"/.test(dashSrc),
    "the dashboard distinguishes a measured rate from no history, rather than printing $0.00");

  /* ------------------------------------------------------------------ */
  console.log("\n11) the dashboard page itself is well formed");
  /*
   * This exists because it was not. The first dashboard.html carried a block
   * of the account page's MARKUP inside its <style> element — a copy/paste
   * that the browser silently absorbed as an unparseable selector, taking the
   * page's own width rule down with it. Nothing looked broken enough to
   * notice; the page was simply 200px narrower than written, forever.
   */
  const dashHtml = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
  const once = (tag) => (dashHtml.match(new RegExp(tag.replace("/", "\\/"), "g")) || []).length === 1;
  check(["<html", "</html>", "<head>", "</head>", "<body>", "</body>", "<style>", "</style>"].every(once),
    "one of each structural tag — no second document spliced into the first");
  const styleBody = dashHtml.slice(dashHtml.indexOf("<style>") + 7, dashHtml.indexOf("</style>"));
  check(!/<[a-zA-Z!/]/.test(styleBody), "the <style> element contains CSS and nothing else");
  // Every class the script paints must exist in the stylesheet, or it renders unstyled.
  const painted = [...dashSrc.matchAll(/class="([a-z0-9 -]+)"/g)].flatMap((m) => m[1].split(" ")).filter(Boolean);
  const missing = [...new Set(painted)].filter((c) => !new RegExp("\\." + c + "[^a-z0-9-]").test(dashHtml));
  check(missing.length === 0, `every class the dashboard paints is styled${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  check(/\.brand[^a-z-]/.test(dashHtml), "…the page's own eyebrow included");

  /* ------------------------------------------------------------------ */
  console.log("\n12) a card with no figures explains itself instead of showing blanks");
  /*
   * The owner's phone showed four tiles, each containing a dash and an
   * apology, filling the screen and saying nothing about WHY. An absent
   * number has two very different causes — an app too old to send it, or a
   * chain RPC that would not answer — and the version is what separates them.
   */
  await register({ ...REAL, appVersion: "0.48.0" });
  check(workerRecord().producer.appVersion === "0.48.0", "the reported app version is kept");
  await register({ ...REAL, appVersion: '<img src=x onerror="alert(1)">' });
  check(workerRecord().producer.appVersion === null,
    "…but only if it looks like a version — a page renders this string");
  await register({ ...REAL, appVersion: "0.48.0" + "0".repeat(400) });
  check(workerRecord().producer.appVersion === null, "…and it cannot be used to smuggle in a wall of text");
  await register(REAL);
  check(workerRecord().producer.appVersion === null,
    "…and an app that never sends one reads as unknown, not as a lie");

  // The rendering rules, read off the source: tiles are conditional now.
  check(/if \(hasPrice\) \{/.test(dashSrc) && /tiles\.push\(tile\("Node value"/.test(dashSrc),
    "the value tile is drawn only when there is a price to draw it from");
  check(/k\.appVersion == null/.test(dashSrc) && /older version of the desktop app/.test(dashSrc),
    "…and an old app is named as the reason, rather than four empty boxes");
  check(/tiles \? `<div class="tiles">/.test(dashSrc),
    "…with the tile row omitted entirely when there are no tiles");
  check(/minmax\(112px/.test(dashHtml),
    "tiles fit two-up on a phone — at 140px the owner's screenshot showed one per row");

  // The two VHP figures, which do not always agree.
  check(/VHP in wallet/.test(dashSrc) && /mismatch/.test(dashSrc),
    "producing VHP and wallet VHP are shown separately when they disagree");
  check(dashSrc.indexOf('["VHP producing"') < dashSrc.indexOf('["VHP in wallet"'),
    "…producing leads, because it is the figure the share is derived from");

  /* ------------------------------------------------------------------ */
  console.log("\n13) stake sitting out of the lottery is named, not just displayed");
  /*
   * A real machine, 2026-08-23: the chain said the wallet held 41,123.92 VHP
   * and the block producer said it was producing with 16,955.37 — 41% of the
   * stake, same address, same computer, every screen internally consistent.
   * In proof-of-burn the producer derives from its own VHP figure when its
   * proof becomes valid, so understating it loses real blocks. The verdict is
   * made on the machine (only it has both numbers at the same instant) and
   * carried here; the page must not quietly drop it.
   */
  await register({ ...REAL, vhpSats: "4112392378763", stakeBehind: true, stakeShortfallPct: 58.77 });
  const behind = workerRecord().producer;
  check(behind.stakeBehind === true, "the shortfall verdict survives the trip");
  check(Math.abs(behind.stakeShortfallPct - 58.77) < 1e-6, "…with the size of it");

  await register({ ...REAL, vhpSats: "65946173948" });
  check(workerRecord().producer.stakeBehind === false,
    "a node that is not behind does not inherit somebody else's alarm");
  check((await _shortfall(register, workerRecord, REAL, 101)) === null,
    "an impossible shortfall is dropped, not printed");

  check(/stakeBehind/.test(dashSrc), "the dashboard reads the verdict");
  check(/sitting out of the block lottery/.test(dashSrc),
    "…and says what it costs, in words, rather than leaving two numbers side by side");
  check(/Restart the Koinos node/.test(dashSrc), "…and what to do about it");

  sched.close?.();
  console.log(failures ? `\n${failures} FAILED` : "\nPRODUCER CARD PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
