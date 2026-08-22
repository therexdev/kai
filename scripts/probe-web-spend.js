"use strict";

/*
 * WEB SPEND PATH — a signed-in browser spending KAI through a grant.
 *
 * The property under test is not "does it work" but "can it be abused". Two
 * authorization lanes now reach /consume/chat/completions:
 *
 *   1. a per-request wallet signature (the desktop app)
 *   2. a session + spend grant (the web app)
 *
 * Lane 2 must be no weaker than lane 1. Specifically it must NOT let the web
 * tier act as any user, must NOT let one account draw on another's grant, and
 * must NOT let a request run whose worst-case cost exceeds what the grant has
 * left — because a web user has no epoch earnings to absorb an overdraft, and
 * closeEpoch WIPES debts with no carry-forward. Money spent past the cap is
 * money nobody ever collects.
 *
 * Old code (no grant lane): every session-authorized request 401s, so the
 * "accepted" assertions fail — which is the point.
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { Signer } = require("koilib");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-webspend-"));
const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });

async function main() {
  const { createAccounts } = require("../lib/accounts");
  const { Scheduler } = require("../lib/scheduler");

  const accounts = createAccounts({ stateDir: tmp(), sendMail: async () => {}, siteOrigin: "http://127.0.0.1:0", onEvent: () => {} });
  const app = express();
  app.use(express.json());
  app.use(accounts.router);
  const srv = await listen(app);
  const origin = `http://127.0.0.1:${srv.address().port}`;
  accounts.service.siteOrigin = origin;
  accounts.service.rpId = "127.0.0.1";

  const sched = new Scheduler({ dataDir: tmp(), accounts: accounts.service, onEvent: () => {} });
  const port = await sched.listen();
  const base = `http://127.0.0.1:${port}`;

  const consume = (body) =>
    fetch(`${base}/consume/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // --- an account with a linked wallet and a live grant
  const acct = accounts.service._newAccount({ email: "web@example.com" });
  const token = accounts.service._issueSession(acct.id, "probe");
  const wallet = Signer.fromSeed("probe-web-spend");
  const address = wallet.getAddress();
  const sign = async (msg) =>
    Buffer.from(await wallet.signHash(crypto.createHash("sha256").update(msg).digest())).toString("base64");

  let ts = Date.now();
  accounts.service.linkWallet(acct, { address, ts, signature: await sign(`link|${address}|${acct.id}|${ts}`) });

  const CAP = 1 * 1e6; // $1
  /* One live grant per wallet is the rule — a new grant REPLACES the old, so
   * "how much can this site spend?" always has one answer. Every grant below
   * is minted through here, and the caller must use the newest. */
  const mint = async (maxMicro = CAP, ms = 3600000) => {
    const e = Date.now() + ms;
    const t = Date.now();
    return accounts.service.grantSpend(acct, {
      address, maxMicro, expiresAt: e, ts: t,
      signature: await sign(`spend|${address}|${acct.id}|${Math.floor(maxMicro)}|${e}|${t}`),
    });
  };
  const grant = await mint();

  const msgs = [{ role: "user", content: "hello" }];

  console.log("\n1) the session lane exists and is gated");
  let r = await consume({ messages: msgs });
  check(r.status === 401, "no credential at all is refused");

  r = await consume({ messages: msgs, sessionToken: "sk_not_a_real_token", grantId: grant.id, max_tokens: 64 });
  check(r.status === 401, "a bogus session is refused");

  r = await consume({ messages: msgs, sessionToken: token, grantId: "grant_nope", max_tokens: 64 });
  check(r.status === 404, "a session with an unknown grant is refused");

  console.log("\n2) a grant belongs to ONE account");
  const other = accounts.service._newAccount({ email: "other@example.com" });
  const otherToken = accounts.service._issueSession(other.id, "probe");
  r = await consume({ messages: msgs, sessionToken: otherToken, grantId: grant.id, max_tokens: 64 });
  check(r.status === 404 || r.status === 403, "another account cannot spend this grant");

  console.log("\n3) a granted request must be BOUNDED before it runs");
  r = await consume({ messages: msgs, sessionToken: token, grantId: grant.id });
  check(r.status === 400 && /max_tokens/.test(r.body?.error?.message || ""), "max_tokens is required on the grant lane");

  r = await consume({ messages: msgs, sessionToken: token, grantId: grant.id, max_tokens: 999999 });
  check(r.status === 400, "an absurd max_tokens is refused outright");

  /*
   * A grant small enough that the worst case genuinely does not fit. 4000
   * output tokens on the 32B class prices at ~$0.016, so a $0.005 grant must
   * refuse it — BEFORE running, since there is nothing to claw back after.
   */
  const tiny = await mint(5000);
  check(
    (() => { try { accounts.service.spendableGrant(acct.id, grant.id); return false; } catch { return true; } })(),
    "minting a new grant replaces the old one — never two live caps on one wallet"
  );
  r = await consume({
    messages: msgs, sessionToken: token, grantId: tiny.id,
    model: "qwen25-32b", max_tokens: 4000,
  });
  check(
    r.status === 402 && /spending grant/.test(r.body?.error?.message || ""),
    "a request whose WORST CASE exceeds the grant is refused before running"
  );
  check(
    accounts.service.spendableGrant(acct.id, tiny.id).remainingMicro === 5000,
    "…and that refusal spent nothing"
  );
  // The SAME grant accepts a request that does fit — the bound tracks cost,
  // it is not a blanket refusal of the cheap class.
  r = await consume({ messages: msgs, sessionToken: token, grantId: tiny.id, model: "koinos-fast", max_tokens: 8 });
  check(r.status !== 402, `a request that fits the same small grant is not refused on cost (got ${r.status})`);

  console.log("\n4) a bounded request passes authorization and reaches dispatch");
  const roomy = await mint();
  r = await consume({ messages: msgs, sessionToken: token, grantId: roomy.id, max_tokens: 32 });
  check(r.status !== 401 && r.status !== 400, `a small bounded request is authorized (got ${r.status})`);
  check(r.status !== 404 && r.status !== 403, "…and is not rejected as an unknown or foreign grant");

  console.log("\n5) revocation and expiry cut spending immediately");
  accounts.service.revokeGrant(acct, roomy.id);
  r = await consume({ messages: msgs, sessionToken: token, grantId: roomy.id, max_tokens: 32 });
  check(r.status === 403, "a revoked grant cannot spend");

  const g2 = await mint();
  accounts.service.db.prepare("UPDATE spend_grants SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, g2.id);
  r = await consume({ messages: msgs, sessionToken: token, grantId: g2.id, max_tokens: 32 });
  check(r.status === 403, "an expired grant cannot spend");

  console.log("\n6) the web tier never forges a wallet signature");
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "scheduler.js"), "utf8");
  check(
    !/signHash|signMessage|signTransaction/.test(src.slice(src.indexOf("grantCharge"), src.indexOf("_syncDeposits"))),
    "the grant branch signs nothing — it resolves an address, it does not impersonate one"
  );

  srv.close();
  sched.server?.close();
  console.log(failures ? `\nWEB SPEND PROBE FAILED (${failures})` : "\nWEB SPEND PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
