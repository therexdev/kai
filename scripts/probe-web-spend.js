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
  /* Authorizations are single-use by the digest of their signed message
     (FIND-FIN-002), and that message is pinned to a timestamp. Two mints with
     identical terms inside the same millisecond ARE the same authorization by
     that definition, so the probe steps its clock to make each one distinct —
     which a person clicking Authorise does for free. */
  let mintSeq = 0;
  const mint = async (maxMicro = CAP, ms = 3600000) => {
    const e = Date.now() + ms;
    const t = Date.now() + (mintSeq += 1);
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

  console.log("\n7) the cap is HELD, not merely compared against (FIND-FIN-001)");
  {
    /*
     * The holds have to OVERLAP for this to mean anything, so give the class
     * a live provider and then never answer the job: each accepted request
     * parks inside the scheduler holding its reservation, which is exactly
     * the shape of the real race. Before the fix all four sailed past the
     * cost gate, because each one read the same untouched remaining balance.
     */
    await fetch(`${base}/worker/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "1ProbeWorkerNeverAnswersXXXXXXXXXX", models: ["qwen25-32b"], capabilities: { ramGb: 32 } }),
    });

    const PER = 4000 * 4000000 / 1e6;         // 4000 tokens at the 32B out-rate
    const g = await mint(2.5 * PER);           // room for two, nowhere near three
    const spentOf = () => Number(accounts.service.db.prepare("SELECT spent_micro AS s FROM spend_grants WHERE id = ?").get(g.id).s);
    const capOf = () => Number(accounts.service.db.prepare("SELECT max_micro AS m FROM spend_grants WHERE id = ?").get(g.id).m);

    const settled = [];
    for (let i = 0; i < 4; i++) {
      consume({ messages: msgs, sessionToken: token, grantId: g.id, model: "qwen25-32b", max_tokens: 4000 })
        .then((r) => settled.push(r))
        .catch(() => {});
    }
    // The refusals come back immediately; the accepted ones are still parked.
    await new Promise((r) => setTimeout(r, 500));

    const refused = settled.filter((x) => x.status === 402).length;
    check(refused >= 2, `concurrent requests past the cap are refused while the others hold (${refused} of 4 got 402)`);
    check(!settled.some((x) => x.status === 500), "…and the refusals are honest 402s, not crashes");
    check(
      spentOf() > PER && spentOf() <= capOf(),
      `two holds are outstanding at once and stay inside the cap (held=${spentOf()} cap=${capOf()})`,
    );
  }

  console.log("\n8) a hold that never spends is given back");
  {
    // Nothing is serving, so every one of these dies at "no providers" or
    // times out — either way not a token is generated. If the reservation
    // were not released the grant would retire itself on failures alone.
    const g = await mint(0.5 * 1e6);
    const spentOf = () => Number(accounts.service.db.prepare("SELECT spent_micro AS s FROM spend_grants WHERE id = ?").get(g.id).s);
    check(spentOf() === 0, "a fresh grant starts unspent");
    for (let i = 0; i < 3; i++) {
      await consume({ messages: msgs, sessionToken: token, grantId: g.id, model: "koinos-fast", max_tokens: 64 });
    }
    // The response has ended on every one of them, which is where the
    // backstop settles the hold.
    await new Promise((r) => setTimeout(r, 50));
    check(spentOf() === 0, `three requests that generated nothing leave the grant unspent (spent=${spentOf()})`);
  }

  console.log("\n9) a grant authorization is single-use (FIND-FIN-002)");
  {
    // The exact bytes the app sent to authorize a grant. Re-sending them used
    // to revoke the live grant and insert a fresh one with spent_micro back at
    // zero — the cap handed back, indistinguishable from a real re-approval.
    const t = Date.now();
    const e = t + 24 * 3600 * 1000;
    const cap = 2 * 1e6;
    const payload = {
      address, maxMicro: cap, expiresAt: e, ts: t,
      signature: await sign(`spend|${address}|${acct.id}|${Math.floor(cap)}|${e}|${t}`),
    };
    const first = accounts.service.grantSpend(acct, payload);
    check(Boolean(first.id), "the authorization is accepted once");

    // Spend some of it so a successful replay would be visibly profitable.
    accounts.service.chargeGrant(first.id, 1.5 * 1e6);
    const spentAfter = Number(accounts.service.db.prepare("SELECT spent_micro AS s FROM spend_grants WHERE id = ?").get(first.id).s);
    check(spentAfter === 1.5 * 1e6, "…and spending against it books normally");

    let replayed = null;
    try {
      replayed = accounts.service.grantSpend(acct, payload);
    } catch (err) {
      check(/already been used/i.test(String(err.message)), `the replay is refused by name (${err.message})`);
    }
    check(replayed === null, "replaying the same authorization does NOT mint a second grant");

    const live = accounts.service.grants(acct).filter((x) => !x.revokedAt && x.id === first.id);
    check(live.length === 1, "the original grant is still the live one");
    const stillSpent = Number(accounts.service.db.prepare("SELECT spent_micro AS s FROM spend_grants WHERE id = ?").get(first.id).s);
    check(stillSpent === 1.5 * 1e6, `and its consumed total survived the replay (spent=${stillSpent})`);

    // A genuine re-authorization — new timestamp, new signature — still works.
    const t2 = t + 1000;
    const fresh = accounts.service.grantSpend(acct, {
      address, maxMicro: cap, expiresAt: e, ts: t2,
      signature: await sign(`spend|${address}|${acct.id}|${Math.floor(cap)}|${e}|${t2}`),
    });
    check(fresh.id !== first.id, "a person re-approving from the app is unaffected");
  }

  srv.close();
  sched.server?.close();
  console.log(failures ? `\nWEB SPEND PROBE FAILED (${failures})` : "\nWEB SPEND PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
