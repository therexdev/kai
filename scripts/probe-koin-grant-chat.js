"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os");
const { Signer } = require("koilib");
const { Scheduler } = require("../lib/scheduler");
const { AccountService } = require("../lib/accounts");
const { Meter } = require("../lib/koin-network/metering");
const P = require("../lib/koin-network/job-protocol");
const owner = Signer.fromSeed("grant-chat-owner"), worker = Signer.fromSeed("grant-chat-worker");
const sign = async (who, bytes) => Buffer.from(await who.signHash(bytes)).toString("base64");
const hashSign = (who, text) => sign(who, Buffer.from(P.hash(text), "hex"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const tariff = { model: "koinos-fast", version: 1, modelHash: P.hash("fixture-model"), tokenizerHash: P.hash("fixture-tokenizer"),
  templateHash: P.hash("fixture-template"), inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000",
  maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 5000 };
const input = [{ role: "user", content: "Private prompt for the grant chat integration test" }];

async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koin-grant-chat-"));
  const accounts = new AccountService({ stateDir: path.join(dir, "accounts") });
  const account = accounts._newAccount({ email: "fixture@example.invalid" });
  const token = accounts._issueSession(account.id, "fixture"), address = owner.getAddress(), ts = Date.now();
  accounts.linkWallet(account, { address, ts, signature: await hashSign(owner, `link|${address}|${account.id}|${ts}`) });
  const expiresAt = ts + 3600000, maxMicro = 1000000;
  const grant = accounts.grantSpend(account, { address, ts, expiresAt, maxMicro,
    signature: await hashSign(owner, `spend|${address}|${account.id}|${maxMicro}|${expiresAt}|${ts}`) });
  const encode = s => [...Buffer.from(s)];
  const meter = new Meter([{ tariff, adapter: { ...tariff, render: JSON.stringify, encode,
    input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } }]);
  const session = P.hash("synthetic-session");
  const config = { dataDir: path.join(dir, "scheduler"), accounts, operatorSecret: "fixture-secret",
    koinWork: { domain: "shadow:grant-chat", meter, qualify: address => address === worker.getAddress(), accept: ({ output }) => output === "4",
      consumerWaitMs: options.waitMs || 3000,
      ...(options.disabled ? {} : { consumerBindings: [{ accountId: account.id, grantId: grant.id, session, model: tariff.model, version: 1, maxOutput: 16 }] }) } };
  let s = new Scheduler(config), base = `http://127.0.0.1:${await s.listen(0, "127.0.0.1")}`;
  s.koinWork.ledger.importSimulationGrant({ id: session, owner: address, amount: "10000", perJob: "1000", maxJobs: options.maxJobs || 4,
    expires: Date.now() + 3600000, policyHash: meter.policyHash });
  t.after(async () => { await s.close(); accounts.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = async (route, body, extra = {}) => {
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...extra });
    return { status: r.status, type: r.headers.get("content-type"), text: await r.text() };
  };
  const request = (id = "first") => ({ billing: "koin-shadow", sessionToken: token, grantId: grant.id,
    requestId: P.hash(id), messages: input, model: "koinos-fast", max_tokens: 16, stream: false });
  const chat = (body = request(), extra) => post("/consume/chat/completions", body, extra);
  const waitJob = async id => {
    for (let i = 0; i < 100; i++) {
      const row = s.koinWork.ledger.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
      if (row) return JSON.parse(row.data);
      await pause(5);
    }
    throw Error("No reserved request");
  };
  const take = async () => {
    const at = Date.now(), addr = worker.getAddress();
    const registered = await post("/worker/register", { address: addr, ts: at, signature: await hashSign(worker, `register|${addr}|${at}`),
      models: ["koinos-fast"], capabilities: { ramGb: 8, koinShadowJobs: 1 } });
    const workerToken = JSON.parse(registered.text).token;
    const r = await fetch(base + "/worker/next-job?token=" + workerToken);
    assert.equal(r.status, 200); const job = (await r.json()).job;
    assert.equal(job.type, "koin-shadow-chat"); return { workerToken, job };
  };
  const finish = async ({ workerToken, job }, output = "4") => post("/koin/shadow/jobs/result?token=" + workerToken,
    { jobId: job.id, output, signature: await sign(worker, P.resultHash(job.quote.domain, job.id, job.attempt, job.quote.hash, output)) });
  return { dir, accounts, account, grant, token, session, config, request, chat, waitJob, take, finish,
    get s() { return s; }, get base() { return base; },
    async restart() { await s.close(); s = new Scheduler(config); base = `http://127.0.0.1:${await s.listen(0, "127.0.0.1")}`; } };
}

test("existing account grant -> normal chat endpoint -> verified worker answer, without legacy or KOIN charges", async t => {
  const f = await setup(t), request = f.request();
  const pending = f.chat(request); await f.waitJob(request.requestId);
  const work = await f.take(); assert.equal((await f.finish(work)).status, 200);
  const r = await pending; assert.equal(r.status, 200, r.text);
  const body = JSON.parse(r.text);
  assert.equal(body.choices[0].message.content, "4"); assert.equal(body.servedModel, "koinos-fast");
  assert.equal(body.koin.paymentsEnabled, false); assert.equal(body.koin.state, "verified");
  assert.equal(body.koin.receipt.usage.outputTokens, 1); assert.equal(body.costUsd, 0);
  assert.equal(f.accounts.spendableGrant(f.account.id, f.grant.id).remainingMicro, 1000000);
  assert.equal(f.s.koinWork.ledger.status(f.session).spent, "0");
  assert.notEqual(f.s.koinWork.ledger.status(f.session).held, "0");
  assert.equal(f.s.receipts.length, 0); assert.deepEqual(f.s.usage, {});
  const stored = f.s.koinWork.ledger.get("jobs", request.requestId);
  assert.equal(stored.requestSignature, undefined, "no server-created consumer signature");
  assert.equal(stored.delegatedAuthorization.grantId, f.grant.id);
  assert.equal(JSON.stringify(stored).includes(input[0].content), false);
  const retry = await f.chat(request); assert.equal(retry.status, 200); assert.deepEqual(JSON.parse(retry.text), body);
  assert.equal(f.s.koinWork.ledger.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  const stream = await f.chat({ ...request, stream: true });
  assert.match(stream.type, /text\/event-stream/); assert.match(stream.text, /"delta":"4"/); assert.match(stream.text, /"paymentsEnabled":false/);
  const changed = await f.chat({ ...request, messages: [{ role: "user", content: "different" }] });
  assert.equal(changed.status, 409);
});

test("rehearsal requires explicit binding, account session and existing linked-wallet grant", async t => {
  const off = await setup(t, { disabled: true }); assert.equal((await off.chat()).status, 409);
  const f = await setup(t);
  const other = f.accounts._newAccount({ email: "other@example.invalid" });
  const otherToken = f.accounts._issueSession(other.id, "other");
  for (const change of [
    { sessionToken: "invalid", trustedAccountId: f.account.id },
    { sessionToken: otherToken }, { grantId: "unbound" }, { signature: "old-wallet-proof" },
    { model: "koinos-smart" }, { max_tokens: 17 }, { billing: "koin-funded" },
  ]) assert.ok((await f.chat({ ...f.request(), ...change })).status >= 400);
  assert.equal(f.s.koinWork.ledger.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  f.accounts.unlinkWallet(f.account, owner.getAddress());
  assert.ok((await f.chat()).status >= 400);
});

test("another account cannot recover or replace a completed request ID", async t => {
  const f = await setup(t), request = f.request(); const pending = f.chat(request); await f.waitJob(request.requestId);
  assert.equal((await f.finish(await f.take())).status, 200); assert.equal((await pending).status, 200);
  const other = f.accounts._newAccount({ email: "other@example.invalid" });
  const token = f.accounts._issueSession(other.id, "other");
  const r = await f.chat({ ...request, sessionToken: token });
  assert.ok(r.status >= 400); assert.ok(!r.text.includes('"content":"4"'));
  assert.equal(f.s.koinWork.ledger.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
});

test("concurrent duplicate requests and competing jobs cannot reserve the same grant capacity", async t => {
  const f = await setup(t, { maxJobs: 1 }), request = f.request();
  const pending = f.chat(request); await f.waitJob(request.requestId);
  assert.equal((await f.chat(request)).status, 409);
  assert.ok((await f.chat(f.request("second"))).status >= 400);
  assert.equal(f.s.koinWork.ledger.db.prepare("SELECT COUNT(*) AS n FROM quotes").get().n, 1, "declined requests leave no unused quotes");
  assert.equal(f.s.koinWork.ledger.status(f.session).remainingJobs, 0);
  assert.equal((await f.finish(await f.take())).status, 200); assert.equal((await pending).status, 200);
});

test("revoking or unlinking a grant stops queued rehearsal work and releases only unaccepted holds", async t => {
  for (const revoke of [f => f.accounts.revokeGrant(f.account, f.grant.id), f => f.accounts.unlinkWallet(f.account, owner.getAddress())]) {
    const f = await setup(t), request = f.request(), pending = f.chat(request); await f.waitJob(request.requestId);
    revoke(f);
    assert.ok((await pending).status >= 400);
    assert.equal(f.s.koinWork.ledger.get("jobs", request.requestId).state, "cancelled");
    assert.equal(f.s.koinWork.ledger.status(f.session).held, "0");
  }
});

test("timeout and consumer Stop cancel unaccepted work without retrying or charging", async t => {
  const f = await setup(t, { waitMs: 60 }); const request = f.request();
  assert.equal((await f.chat(request)).status, 504);
  assert.equal(f.s.koinWork.ledger.get("jobs", request.requestId).state, "cancelled");
  assert.equal(f.s.koinWork.ledger.status(f.session).held, "0");
  const g = await setup(t), body = g.request(), controller = new AbortController();
  const pending = g.chat(body, { signal: controller.signal }).catch(e => e); await g.waitJob(body.requestId);
  const work = await g.take(); controller.abort(); await pending;
  for (let i = 0; i < 100 && g.s.koinWork.ledger.get("jobs", body.requestId).state !== "cancelled"; i++) await pause(5);
  assert.equal(g.s.koinWork.ledger.get("jobs", body.requestId).state, "cancelled");
  assert.equal((await g.finish(work)).status, 400);
  assert.equal(g.s.koinWork.ledger.status(g.session).held, "0");
});

test("a revoked grant cannot accept an already dispatched worker answer", async t => {
  const f = await setup(t), request = f.request(), pending = f.chat(request);
  await f.waitJob(request.requestId); const work = await f.take();
  f.accounts.revokeGrant(f.account, f.grant.id);
  assert.equal((await f.finish(work)).status, 400);
  assert.ok((await pending).status >= 400);
  assert.equal(f.s.koinWork.ledger.status(f.session).held, "0");
});

test("restart keeps accepted holds and refuses to invent a new job when the transient answer is gone", async t => {
  const f = await setup(t), request = f.request(), pending = f.chat(request); await f.waitJob(request.requestId);
  const work = await f.take(); await f.finish(work); assert.equal((await pending).status, 200);
  const held = f.s.koinWork.ledger.status(f.session).held;
  // Configuration key order has no effect on persisted delegated authority.
  f.config.koinWork.consumerBindings = f.config.koinWork.consumerBindings.map(b => Object.fromEntries(Object.entries(b).reverse()));
  await f.restart();
  const r = await f.chat(request); assert.equal(r.status, 409); assert.match(r.text, /already accepted/);
  assert.equal(f.s.koinWork.ledger.status(f.session).held, held);
  assert.equal(f.s.koinWork.ledger.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  // The original signed worker retry may restore delivery without another run.
  assert.equal((await f.finish(work)).status, 200);
  assert.equal((await f.chat(request)).status, 200);
});
