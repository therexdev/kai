"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const { Signer, utils } = require("koilib");
const { fixture } = require("./koin-funding-fixture");
const { AccountService } = require("../../lib/accounts");
const { Scheduler } = require("../../lib/scheduler");
const { Meter } = require("../../lib/koin-network/metering");
const { FundedSessionObserver } = require("../../lib/koin-network/funded-session");
const P = require("../../lib/koin-network/job-protocol"), D = require("../../lib/koin-network/session-delegation");
const owner = Signer.fromSeed("funded-probe-owner");
const sign = async bytes => Buffer.from(await owner.signHash(bytes)).toString("base64");
async function setup(t, { work = null, realClock = false, model = "fixture" } = {}) {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "koin-session-delegation-"));
  if (realClock) {
    const now = Date.now(); f.time(now); f.target.clock = Date.now;
    Object.assign(f.session.session, { opened_at: String(now - 1000), expires: String(now + 60000), settle_until: String(now + 60000 + 86400000) });
    f.head.head_block_time = String(now); f.block.block.header.timestamp = String(now);
  }
  const accounts = new AccountService({ stateDir: path.join(dir, "accounts") }), account = accounts._newAccount({ email: "delegate@example.invalid" });
  const token = accounts._issueSession(account.id, "fixture"), ts = Date.now(), expiresAt = ts + 3600000, maxMicro = 1000000;
  accounts.linkWallet(account, { address: f.owner, ts, signature: await sign(Buffer.from(P.hash(`link|${f.owner}|${account.id}|${ts}`), "hex")) });
  const grant = accounts.grantSpend(account, { address: f.owner, ts, expiresAt, maxMicro,
    signature: await sign(Buffer.from(P.hash(`spend|${f.owner}|${account.id}|${maxMicro}|${expiresAt}|${ts}`), "hex")) });
  const tariff = { model, version: 1, modelHash: P.hash("model"), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 5000 };
  const encode = s => [...Buffer.from(s)], meter = new Meter([{ tariff,
    adapter: { ...tariff, render: JSON.stringify, encode, input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } }]);
  f.target.policyHash = meter.policyHash; f.session.session.policy_hash = utils.encodeBase64url(Buffer.from(meter.policyHash, "hex"));
  f.session.session.per_job = "200";
  const observer = new FundedSessionObserver(f.rpc, f.target), target = { chainId: f.target.chainId, credits: f.target.credits,
    creditsHash: f.target.creditsHash, policyHash: meter.policyHash, domain: "shadow:funded-account" };
  const config = { dataDir: path.join(dir, "scheduler"), accounts, koinFundedSessions: { target, observer, meter, clock: f.target.clock, work, accept: ({ output }) => output === "4" } };
  let scheduler = new Scheduler(config), port = await scheduler.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await scheduler.close(); accounts.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = async (action, body = {}, sessionToken = token) => {
    const response = await fetch(base + "/koin/funded/rehearsal/" + action, { method: "POST", headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ sessionToken, ...body }) });
    return { status: response.status, body: await response.json() };
  };
  const observation = await post("observe", { grantId: grant.id, session: f.id }); f.finalize();
  const proposal = { model: tariff.model, version: 1, maxOutput: 16, amount: "500", perJob: "200", maxJobs: 3, expires: f.target.clock() + 30000 };
  const review = async (extra = {}) => {
    const r = await post("review", { grantId: grant.id, observationId: observation.body.observationId, proposal: { ...proposal, ...extra } });
    if (r.status !== 200) throw Error(JSON.stringify(r.body)); return r.body;
  };
  const authorize = async (r = null) => {
    r ||= await review(); const signature = await sign(D.hash(r.terms));
    const body = { grantId: grant.id, observationId: observation.body.observationId, terms: r.terms, signature };
    const response = await post("authorize", body);
    if (response.status !== 200) throw Error(JSON.stringify(response.body));
    return { ...r, signature, request: body, status: response.body };
  };
  const quote = () => scheduler.koinFundedSessions.ledger.quote(tariff.model, 1, [{ role: "user", content: "hello" }], 16);
  const request = (approval, n = "one", q = quote()) => ({ id: P.hash(n), observationId: observation.body.observationId,
    quote: q, delegationId: approval.delegationId, accountId: account.id, grantId: grant.id });
  return { ...f, dir, accounts, account, token, grant, base, proposal, target, observer, meter, config, review, authorize, quote, request, post,
    observationId: observation.body.observationId, get scheduler() { return scheduler; }, get ledger() { return scheduler.koinFundedSessions.ledger; },
    async restart() { await scheduler.close(); scheduler = new Scheduler(config); await scheduler.listen(port, "127.0.0.1"); } };
}
module.exports = { setup, owner, sign };
