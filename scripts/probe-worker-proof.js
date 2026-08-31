#!/usr/bin/env node
/*
 * Worker registration ownership proof — FIND-NET-001.
 *
 * /worker/register took `address` on trust. Anyone who could reach the
 * scheduler could POST somebody else's wallet address, receive a live token,
 * and from that moment be that worker: taking their dispatched jobs, and
 * sitting on the payout roster under their address. The audit called it a P0
 * and it was: the address IS the payee.
 *
 * The fix is a wallet signature over sha256("register|<address>|<ts>"), and
 * the rollout is what most of this probe is about. Every node currently
 * earning runs a client that does not sign yet, so refusing unsigned
 * registrations on deploy day would empty the network. Shadow mode accepts
 * them and marks them; KAI_WORKER_PROOF_ENFORCE=1 closes the door afterwards.
 *
 * The distinction that has to hold in BOTH modes: "no proof offered" is an
 * old client and is a scheduling problem, while "a proof was offered and it
 * did not check out" is an attack and is refused always. If shadow mode let
 * bad signatures through, the check would be decoration for as long as the
 * rollout lasted.
 *
 * Exits non-zero on any failure. Run: node scripts/probe-worker-proof.js
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

/* A registration proof, exactly as the client builds it. */
async function proofFor(signer, address, ts = Date.now()) {
  const hash = crypto.createHash("sha256").update(`register|${address}|${ts}`).digest();
  return { ts, signature: Buffer.from(await signer.signHash(hash)).toString("base64") };
}

async function withScheduler(opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-proof-"));
  const sched = new Scheduler({ dataDir: dir, operatorSecret: null, onEvent: () => {}, ...opts });
  const server = http.createServer((rq, rs) => sched.handle(rq, rs).catch(() => rs.end()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(server.address().port);
  } finally {
    server.close();
    sched.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  // Two real keys minted per run. VICTIM is the wallet an attacker wants to
  // be paid as; ATTACKER holds a key that is genuinely theirs and useless here.
  const victim = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  const attacker = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  const VICTIM = victim.getAddress();
  const ATTACKER = attacker.getAddress();

  // ---------- shadow mode (the default, and what deploys first) ----------
  await withScheduler({ workerProofEnforce: false }, async (port) => {
    const unsigned = await req(port, "POST", "/worker/register", { address: VICTIM, models: ["koinos-fast"] });
    check(unsigned.status === 200 && unsigned.json.ok,
      "shadow: a client too old to sign still registers", `HTTP ${unsigned.status}`);

    const signed = await req(port, "POST", "/worker/register",
      { address: VICTIM, models: ["koinos-fast"], ...(await proofFor(victim, VICTIM)) });
    check(signed.status === 200 && signed.json.ok, "shadow: a correctly signed registration is accepted", `HTTP ${signed.status}`);

    /*
     * The attack itself, and the one case shadow mode must NOT wave through:
     * a signature that is real, but over a different wallet's address.
     */
    const forged = await req(port, "POST", "/worker/register",
      { address: VICTIM, models: ["koinos-fast"], ...(await proofFor(attacker, VICTIM)) });
    check(forged.status === 401,
      "shadow: signing someone else's address with your own key is refused", `HTTP ${forged.status}`);

    const garbage = await req(port, "POST", "/worker/register",
      { address: VICTIM, models: ["koinos-fast"], ts: Date.now(), signature: "not-base64-at-all" });
    check(garbage.status === 401, "shadow: junk in the signature field is refused", `HTTP ${garbage.status}`);

    const stale = await req(port, "POST", "/worker/register",
      { address: VICTIM, models: ["koinos-fast"], ...(await proofFor(victim, VICTIM, Date.now() - 10 * 60 * 1000)) });
    check(stale.status === 401, "shadow: a proof older than the window is refused", `HTTP ${stale.status}`);

    // Replay: the same bytes twice. The second must not mint a second token.
    const once = await proofFor(victim, VICTIM);
    const first = await req(port, "POST", "/worker/register", { address: VICTIM, models: ["koinos-fast"], ...once });
    const again = await req(port, "POST", "/worker/register", { address: VICTIM, models: ["koinos-fast"], ...once });
    check(first.status === 200 && again.status === 401,
      "shadow: a captured proof cannot be replayed", `first ${first.status}, replay ${again.status}`);

    /*
     * Domain separation. A consume request signs "consume|<address>|<ts>|..."
     * with the same wallet key and hands that signature to this very server on
     * every paid request — so without distinct prefixes, every paying client
     * would be leaking a registration proof for its own wallet continuously.
     */
    const ts = Date.now();
    const consumeHash = crypto.createHash("sha256").update(`consume|${VICTIM}|${ts}|[]`).digest();
    const consumeSig = Buffer.from(await victim.signHash(consumeHash)).toString("base64");
    const crossed = await req(port, "POST", "/worker/register",
      { address: VICTIM, models: ["koinos-fast"], ts, signature: consumeSig });
    check(crossed.status === 401,
      "shadow: a consume signature is not a registration proof", `HTTP ${crossed.status}`);

    // The rollout counter the digest watches.
    const st = (await req(port, "GET", "/network/status")).json;
    check(st.workerProofEnforced === false, "shadow: status says enforcement is off", String(st.workerProofEnforced));
    check(typeof st.workersUnsigned === "number",
      "shadow: status publishes how many workers cannot prove their address", String(st.workersUnsigned));
  });

  // ---------- enforce mode (armed once the roster reads all-signed) ----------
  await withScheduler({ workerProofEnforce: true }, async (port) => {
    const unsigned = await req(port, "POST", "/worker/register", { address: VICTIM, models: ["koinos-fast"] });
    check(unsigned.status === 401, "enforce: an unsigned registration is refused", `HTTP ${unsigned.status}`);
    check(/update Koinos AI/i.test(unsigned.json.error || ""),
      "enforce: the refusal tells the operator what to do", unsigned.json.error);

    const signed = await req(port, "POST", "/worker/register",
      { address: ATTACKER, models: ["koinos-fast"], ...(await proofFor(attacker, ATTACKER)) });
    check(signed.status === 200 && signed.json.ok,
      "enforce: a signed registration still works", `HTTP ${signed.status}`);

    const forged = await req(port, "POST", "/worker/register",
      { address: VICTIM, models: ["koinos-fast"], ...(await proofFor(attacker, VICTIM)) });
    check(forged.status === 401, "enforce: the impersonation is refused", `HTTP ${forged.status}`);

    const st = (await req(port, "GET", "/network/status")).json;
    check(st.workersUnsigned === 0 && st.workerProofEnforced === true,
      "enforce: nothing unsigned can be on the roster", `unsigned=${st.workersUnsigned}`);
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall worker-proof checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
