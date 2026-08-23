"use strict";

/*
 * SELF-SERVE — "run this on my own machine, and don't bill me for it".
 *
 * The feature is one line of intent and three lines of danger. A request the
 * user routes to their OWN node must cost nothing, because their hardware did
 * the work for their own question and no value moved. But "produces a result
 * and charges zero" is also the exact shape of a reward-farming exploit: if
 * self-served work banked a receipt, anyone could loop jobs to their own
 * machine and mint bootstrap subsidy for work nobody asked for, or buy the
 * routing preference with self-dealt speed samples.
 *
 * So the properties under test are, in order of how much they'd cost to get
 * wrong:
 *
 *   1. self-served work NEVER becomes a receipt — no earnings, no subsidy,
 *      no reputation, no perf sample;
 *   2. it costs nothing and does not touch the spend grant;
 *   3. it is REFUSED, not silently billed to the network, when the user's own
 *      machine cannot serve it;
 *   4. the ordinary paid path is completely unchanged — the revenue path is
 *      not something to break while making one lane free.
 *
 * The identity claim needs no new machinery and this probe leans on that: the
 * ledger is address-keyed, a spend grant carries the wallet that signed it,
 * and a node registers under its own wallet. "My machine" is therefore just
 * `worker.address === consumer.address`, proven by a signature at both ends.
 *
 * Old code (no selfHost lane): section 2 fails — the request is billed like
 * any other and a receipt appears.
 */

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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-selfserve-"));
const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });

async function main() {
  const { createAccounts } = require("../lib/accounts");
  const { Scheduler } = require("../lib/scheduler");

  const accounts = createAccounts({ stateDir: tmp(), sendMail: async () => {}, siteOrigin: "http://127.0.0.1:0", onEvent: () => {} });
  const app = express();
  app.use(express.json());
  app.use(accounts.router);
  const srv = await listen(app);
  accounts.service.siteOrigin = `http://127.0.0.1:${srv.address().port}`;
  accounts.service.rpId = "127.0.0.1";

  /*
   * Free tier OFF. This probe is about who pays for what, and a fresh
   * scheduler hands every new address a daily free allowance that swallows a
   * 100-token test request whole — which made "the paid path still charges"
   * fail for a reason that had nothing to do with the change under test.
   */
  const sched = new Scheduler({
    dataDir: tmp(), accounts: accounts.service, freeTokensPerDay: 0, onEvent: () => {},
  });
  const port = await sched.listen();
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const consume = (body) => post("/consume/chat/completions", body);

  // --- the user: an account, a linked wallet, a live grant
  const acct = accounts.service._newAccount({ email: "self@example.com" });
  const token = accounts.service._issueSession(acct.id, "probe");
  const wallet = Signer.fromSeed("probe-self-serve-mine");
  const address = wallet.getAddress();
  const sign = async (msg) =>
    Buffer.from(await wallet.signHash(crypto.createHash("sha256").update(msg).digest())).toString("base64");
  let ts = Date.now();
  accounts.service.linkWallet(acct, { address, ts, signature: await sign(`link|${address}|${acct.id}|${ts}`) });
  const exp = Date.now() + 3600000;
  const gts = Date.now();
  const grant = await accounts.service.grantSpend(acct, {
    address, maxMicro: 1e6, expiresAt: exp, ts: gts,
    signature: await sign(`spend|${address}|${acct.id}|1000000|${exp}|${gts}`),
  });

  // --- somebody ELSE's machine, so the network lane has a provider too
  const other = Signer.fromSeed("probe-self-serve-theirs");
  const otherAddr = other.getAddress();

  const MODEL = "koinos-fast";
  /** Register a worker and return a function that answers one job for it. */
  async function worker(signer, addr) {
    const reg = await post("/worker/register", {
      address: addr, models: [MODEL], capabilities: { ramGb: 64 },
    });
    const wtoken = reg.body.token || reg.body.workerToken;
    if (!wtoken) throw new Error(`worker/register gave no token: ${JSON.stringify(reg.body).slice(0, 200)}`);
    return {
      addr,
      token: wtoken,
      /**
       * Take the next job and answer it.
       *
       * The receipt signature is over sha256(`jobId|output`) — not over the
       * output alone, which is what an earlier version of this probe assumed
       * and why it hung: the worker never produced an acceptable result and
       * the consumer waited out its full timeout.
       */
      async serveOne(text = "hello from a node") {
        const r = await fetch(`${base}/worker/next-job?token=${encodeURIComponent(wtoken)}`);
        const job = (await r.json().catch(() => ({})))?.job;
        if (!job) return null;
        const out = String(text);
        const hash = crypto.createHash("sha256").update(`${job.id}|${out}`).digest();
        const sig = Buffer.from(await signer.signHash(hash)).toString("base64");
        await post(`/worker/result?token=${encodeURIComponent(wtoken)}`, {
          jobId: job.id, output: out, signature: sig,
          usage: { prompt_tokens: 20, completion_tokens: 80 },
          perf: { ms: 500, tokPerSec: 160 },
        });
        return job.id;
      },
    };
  }

  const mine = await worker(wallet, address);
  const theirs = await worker(other, otherAddr);

  const msgs = [{ role: "user", content: "hello" }];
  const ask = (extra) =>
    consume({ messages: msgs, sessionToken: token, grantId: grant.id, max_tokens: 64, model: MODEL, ...extra });

  /* ------------------------------------------------------------------ */
  console.log("\n1) the ordinary paid path still works and still earns");
  /*
   * With the free tier off, an address needs real capacity before the
   * scheduler will dispatch for it at all (402 otherwise). Credit the ledger
   * directly rather than driving a deposit — this probe is about which lane
   * pays, not about how money gets in.
   */
  sched.balances[address] = { balanceMicro: "1000000", depositHwmSat: "0" };
  const receiptsBefore = sched.receipts.length;
  let paid = ask({});
  await new Promise((r) => setTimeout(r, 60));
  await theirs.serveOne();
  paid = await paid;
  check(paid.status === 200, `a normal request is served (${paid.status})`);
  const paidCost = Number(paid.body?.costUsd ?? -1);
  check(paidCost > 0, `…and costs something (${paidCost})`);
  check(sched.receipts.length === receiptsBefore + 1, "…and banks exactly one receipt");
  check(sched.receipts.at(-1)?.worker === otherAddr, "…credited to the machine that served it");
  const grantAfterPaid = accounts.service.accountView(acct).grants.find((g) => g.id === grant.id);
  check(grantAfterPaid.spentUsd > 0, "…and the grant was charged");

  /* ------------------------------------------------------------------ */
  console.log("\n2) my own machine: free, and outside the economy entirely");
  const spentBefore = grantAfterPaid.spentUsd;
  const receiptsBefore2 = sched.receipts.length;
  const perfBefore = JSON.stringify(sched.perf[address] || null);

  let self = ask({ selfHost: true });
  await new Promise((r) => setTimeout(r, 60));
  const servedId = await mine.serveOne("answered by my own node");
  self = await self;

  check(self.status === 200, `the request is served (${self.status})`);
  check(!!servedId, "…by MY machine, because the job was stamped for it");
  check(Number(self.body?.costUsd) === 0, `…at zero cost (${self.body?.costUsd})`);
  check(/own machine/i.test(String(self.body?.paidWith)), `…and says so (${self.body?.paidWith})`);

  const grantAfterSelf = accounts.service.accountView(acct).grants.find((g) => g.id === grant.id);
  check(grantAfterSelf.spentUsd === spentBefore, "the spend grant is untouched");

  // THE security property. A receipt is a claim on the epoch: paid value,
  // bootstrap subsidy, reputation. Self-dealt work must never mint one.
  check(sched.receipts.length === receiptsBefore2, "NO receipt is banked for self-served work");
  check(!sched.receipts.some((r) => r.jobId === servedId), "…none anywhere carries that job id");
  check(JSON.stringify(sched.perf[address] || null) === perfBefore,
    "…and no perf sample is taken, so self-dealt speed cannot buy routing preference");
  /*
   * The worker above deliberately over-reports (80 completion tokens against
   * max_tokens 64), so this job IS clamped. A clamp normally lands a strike on
   * the node's dishonesty counter; on self-served work there is no counterparty
   * to defraud, and recording one would let someone damage their own standing
   * simply by using their own hardware.
   */
  check(!(sched.perf[address]?.clamps > 0),
    "…and an over-report on your own machine costs you no honesty strike");

  /* ------------------------------------------------------------------ */
  console.log("\n3) when my machine can't serve it, say so — never bill the network instead");
  // Take my machine off the live roster, then ask for it anyway.
  for (const w of sched.workers.values()) {
    if (w.address === address) w.lastSeen = 0; // aged off the live roster
  }
  const refused = await ask({ selfHost: true });
  const spentAfterRefusal = accounts.service.accountView(acct).grants.find((g) => g.id === grant.id).spentUsd;
  check(refused.status === 409, `refused with a clear status (${refused.status})`);
  check(/your machine/i.test(String(refused.body?.error?.message || "")),
    "…naming the machine, not a generic outage");
  check(/nothing was charged/i.test(String(refused.body?.error?.message || "")),
    "…and saying explicitly that nothing was charged");
  check(spentAfterRefusal === grantAfterSelf.spentUsd, "…which is true: the grant did not move");

  sched.close?.();
  srv.close();
  console.log(failures ? `\n${failures} FAILED` : "\nSELF-SERVE PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
