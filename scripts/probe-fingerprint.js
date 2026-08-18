#!/usr/bin/env node
"use strict";

/*
 * Probes §7.4 anti-Sybil signal #3 — device-fingerprint binding, SHADOW only.
 * FAILS on the previous build (no fp fields anywhere).
 *
 *   node scripts/probe-fingerprint.js
 *
 * Registers three workers over real HTTP: two claiming the same device, one
 * distinct. Asserts the collision is SURFACED (stats fpPeers, epoch
 * fingerprintGroups) and NOT PUNISHED (identical work still settles
 * identically — equal work, equal pay, per the owner's binding principles).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { Scheduler } = require("../lib/scheduler");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures += 1;
};

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(b || "{}") }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-fp-"));
  const sched = new Scheduler({ dataDir: dir, operatorSecret: null, onEvent: () => {} });
  const server = http.createServer((rq, rs) => sched.handle(rq, rs).catch(() => rs.end()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const FP_A = "aabbccddeeff0011";
  const FP_B = "1100ffeeddccbbaa";
  const W1 = "1BoZ4CTTQGUpmwSnaR1RgHbzcZTSf8bFYo";
  const W2 = "1DQzuCcTKacbs9GVWJKkEVbPBjDuMGNqBz";
  const W3 = "16UjcYNBG9GTK6uq2rRcMkVxoqzXd3TDMx";

  await req(port, "POST", "/worker/register", { address: W1, models: ["koinos-fast"], fingerprint: FP_A });
  await req(port, "POST", "/worker/register", { address: W2, models: ["koinos-fast"], fingerprint: FP_A });
  await req(port, "POST", "/worker/register", { address: W3, models: ["koinos-fast"], fingerprint: FP_B });

  const st = (await req(port, "GET", "/network/status")).json;
  const by = Object.fromEntries((st.workers || []).map((w) => [w.address.replace(/…/g, ""), w]));
  const find = (addr) => (st.workers || []).find((w) => w.address.startsWith(addr.slice(0, 6)));
  const w1 = find(W1), w2 = find(W2), w3 = find(W3);
  void by;

  ok("fp surfaced on every worker", Boolean(w1?.fp && w2?.fp && w3?.fp), JSON.stringify([w1?.fp, w2?.fp, w3?.fp]));
  ok("two wallets on one device SEE each other", w1?.fpPeers === 1 && w2?.fpPeers === 1);
  ok("a distinct device has no peers", w3?.fpPeers === 0);
  ok("the short fp does not leak the full hash", (w1?.fp || "").length === 8);

  // A malformed fingerprint is refused, not stored.
  await req(port, "POST", "/worker/register", { address: W3, models: ["koinos-fast"], fingerprint: "<script>x".repeat(20) });
  const st2 = (await req(port, "GET", "/network/status")).json;
  const w3b = (st2.workers || []).find((w) => w.address.startsWith(W3.slice(0, 6)));
  ok("garbage fingerprint input keeps the last good one", w3b?.fp === FP_B.slice(0, 8), String(w3b?.fp));

  // An old client that stops sending one must not erase the binding.
  await req(port, "POST", "/worker/register", { address: W2, models: ["koinos-fast"] });
  const st3 = (await req(port, "GET", "/network/status")).json;
  const w2b = (st3.workers || []).find((w) => w.address.startsWith(W2.slice(0, 6)));
  ok("a fingerprint survives a client that omits it", w2b?.fp === FP_A.slice(0, 8), String(w2b?.fp));

  // Equal work, equal pay — the collision changes NOTHING about settlement.
  for (const w of [W1, W2, W3]) {
    sched.receipts.push({ worker: w, honest: true, model: "koinos-fast", usage: { in: 100, out: 200 }, paid: false });
  }
  const summary = sched.closeEpoch();
  const amts = [W1, W2, W3].map((w) => summary.claims[w]?.amount);
  ok("identical work settles identically despite the collision", amts[0] === amts[1] && amts[1] === amts[2], JSON.stringify(amts));
  ok("the epoch records the collision group for calibration",
    Array.isArray(summary.fingerprintGroups?.[FP_A]) && summary.fingerprintGroups[FP_A].length === 2 &&
    !summary.fingerprintGroups[FP_B],
    JSON.stringify(summary.fingerprintGroups));

  server.close();
  console.log(failures ? `\nFINGERPRINT PROBE FAILED (${failures})` : "\nFINGERPRINT PROBE PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
