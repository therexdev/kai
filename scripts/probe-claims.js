#!/usr/bin/env node
"use strict";

/*
 * Probes GET /scheduler/claims — the public claim-packet endpoint that lets a
 * provider claim KAI from the settlement contract without trusting this
 * server. FAILS on the previous build (the endpoint 404s there).
 *
 *   node scripts/probe-claims.js
 *
 * Boots a real Scheduler on a temp dir, runs receipts through a real epoch
 * close, then asserts the served packets are complete AND cryptographically
 * consistent: every proof must recompute the served root.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { Scheduler, merkleRoot } = require("../lib/scheduler");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures += 1;
};

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(body || "{}") }));
    }).on("error", reject);
  });
}

/** Recompute the root from a leaf + proof exactly the way the contract does:
 *  sha256("epoch|worker|amount"), siblings ordered by index parity. */
function rootFromProof(epoch, worker, amount, index, proof) {
  let node = crypto.createHash("sha256").update(`${epoch}|${worker}|${amount}`).digest();
  let idx = index;
  for (const sibHex of proof) {
    const sib = Buffer.from(sibHex, "hex");
    node = idx % 2 === 0
      ? crypto.createHash("sha256").update(Buffer.concat([node, sib])).digest()
      : crypto.createHash("sha256").update(Buffer.concat([sib, node])).digest();
    idx = Math.floor(idx / 2);
  }
  return node.toString("hex");
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-claims-"));
  const sched = new Scheduler({ dataDir: dir, operatorSecret: null, onEvent: () => {} });
  const server = http.createServer((req, res) => sched.handle(req, res).catch(() => res.end()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // Three workers with honest receipts in the open epoch.
  const workers = ["1BoZ4CTTQGUpmwSnaR1RgHbzcZTSf8bFYo", "1DQzuCcTKacbs9GVWJKkEVbPBjDuMGNqBz", "16UjcYNBG9GTK6uq2rRcMkVxoqzXd3TDMx"];
  for (const [i, w] of workers.entries()) {
    for (let n = 0; n <= i; n++) {
      sched.receipts.push({ worker: w, honest: true, model: "koinos-fast", usage: { in: 100, out: 200 }, paid: false });
    }
  }

  const summary = sched.closeEpoch();
  ok("epoch closed with a root", /^[0-9a-f]{64}$/.test(summary.root), summary.root.slice(0, 16) + "…");

  const bad = await get(port, "/claims");
  ok("no address is refused, not defaulted", bad.status === 400);

  const none = await get(port, `/claims?address=1MxSTfsBLLzzSq4QTBBJqYWBGSAB4h8SGF`);
  ok("an address with no claims gets an empty list, not an error", none.status === 200 && none.json.count === 0);

  for (const w of workers) {
    const r = await get(port, `/claims?address=${w}`);
    ok(`claims served for ${w.slice(0, 8)}…`, r.status === 200 && r.json.count >= 1);
    ok("…with no-store", (r.headers["cache-control"] || "").includes("no-store"));
    const c = r.json.claims[0];
    ok("…epoch + root + amount + index + proof all present",
      c.epoch === summary.epoch && /^[0-9a-f]{64}$/.test(c.root) && c.amount != null && c.index != null && Array.isArray(c.proof));
    const recomputed = rootFromProof(c.epoch, w, c.amount, c.index, c.proof);
    ok("…and the proof RECOMPUTES the served root (contract-compatible)", recomputed === c.root,
      recomputed === c.root ? "" : `${recomputed.slice(0, 12)} != ${c.root.slice(0, 12)}`);
  }

  server.close();
  console.log(failures ? `\nCLAIMS PROBE FAILED (${failures})` : "\nCLAIMS PROBE PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
