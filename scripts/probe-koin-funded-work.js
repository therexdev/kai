"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Signer } = require("koilib"), { setup } = require("./helpers/koin-delegation-fixture");
const P = require("../lib/koin-network/job-protocol"), { fundedResultHash } = require("../lib/koin-network/funded-protocol");
const signer = Signer.fromSeed("funded-work-provider"), provider = signer.getAddress();
async function fixture(t) {
  const f = await setup(t, { work: { qualify: a => a === provider, waitMs: 3000 } }), approval = await f.authorize();
  const worker = { address: provider, proof: "signed", models: ["fixture"], capabilities: { koinFundedRehearsalJobs: 1 } };
  const body = (n, extra = {}) => ({ billing: "koin-funded-rehearsal", sessionToken: f.token, grantId: f.grant.id,
    delegationId: approval.delegationId, observationId: f.observationId, requestId: P.hash(n),
    model: "fixture", messages: [{ role: "user", content: "2+2?" }], max_tokens: 16, ...extra });
  const chat = async (n, extra, signal) => {
    const r = await fetch(f.base + "/consume/chat/completions", { method: "POST", headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify(body(n, extra)), signal });
    return { status: r.status, body: extra?.stream ? await r.text() : await r.json() };
  };
  const wait = async n => {
    for (let i = 0; i < 200; i++) { const h = f.ledger.job(P.hash(n)); if (h) return h; await new Promise(r => setTimeout(r, 5)); }
    throw Error("No reservation");
  };
  const result = async (job, change = {}) => {
    const b = { jobId: job.id, output: "4", signature: Buffer.from(await signer.signHash(fundedResultHash(f.target, job, "4"))).toString("base64"), ...change };
    const r = await fetch(f.base + "/koin/funded/rehearsal/result?token=fixture-worker", { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  };
  f.scheduler.workers.set("fixture-worker", worker);
  return { ...f, live: f, worker, approval, chat, wait, result, body };
}

test("funded grant chat dispatches once, verifies worker tokens and prepares an unsigned settlement", async t => {
  const f = await fixture(t), pending = f.chat("one"); await f.wait("one");
  const polls = await Promise.all([f.scheduler.koinFundedSessions.work.next(f.worker), f.scheduler.koinFundedSessions.work.next(f.worker)]);
  const job = polls.find(Boolean); assert.equal(polls.filter(Boolean).length, 1);
  assert.equal(job.type, "koin-funded-rehearsal-chat"); assert.equal(job.paymentsEnabled, false);
  for (const privateValue of [f.token, f.grant.id, f.account.id, f.approval.signature]) assert.ok(!JSON.stringify(job).includes(privateValue));
  assert.equal((await f.result(job)).status, 200);
  const answer = await pending; assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.choices[0].message.content, "4"); assert.equal(answer.body.koin.state, "prepared");
  assert.equal(answer.body.koin.settlement.intent.nonce, "1"); assert.equal(answer.body.koin.settlement.intent.amount, String(job.quote.inputTokens + 1));
  assert.equal(answer.body.koin.paymentsEnabled, false); assert.equal(answer.body.costUsd, 0);
  assert.equal(f.ledger.job(job.id).txId, undefined);
  assert.equal((await f.result(job)).status, 200); assert.deepEqual((await f.chat("one")).body, answer.body);
  assert.equal((await f.chat("one", { grantId: "other_grant" })).status, 400);
  assert.equal(f.accounts.spendableGrant(f.account.id, f.grant.id).remainingMicro, 1000000);
  assert.match((await f.chat("one", { stream: true })).body, /data: \[DONE\]/);
  const second = f.chat("two"); await f.wait("two"); const j2 = await f.scheduler.koinFundedSessions.work.next(f.worker);
  await f.result(j2); const a2 = await second;
  assert.equal(a2.body.koin.state, "verified"); assert.equal(a2.body.koin.settlement.state, "waiting", "nonce cannot skip unresolved settlement");
});

test("duplicate intent, account theft and unqualified workers cannot start extra funded work", async t => {
  const f = await fixture(t), pending = f.chat("one"); await f.wait("one");
  assert.equal((await f.chat("one")).status, 409);
  assert.equal((await f.chat("one", { messages: [{ role: "user", content: "different" }] })).status, 409);
  const other = f.accounts._newAccount({ email: "other@example.invalid" }), token = f.accounts._issueSession(other.id, "other");
  assert.ok((await f.chat("one", { sessionToken: token })).status >= 400);
  for (const change of [{ proof: "unsigned" }, { capabilities: { koinShadowJobs: 1 } }, { address: f.owner }, { models: [] }]) {
    assert.equal(await f.scheduler.koinFundedSessions.work.next({ ...f.worker, ...change }), null);
  }
  await f.post("revoke", { id: f.approval.delegationId }); assert.equal((await pending).status, 409);
  assert.equal(f.ledger.job(P.hash("one")).amount, "0");
  assert.ok((await f.chat("new")).status >= 400);
});

test("revoke after dispatch preserves liability and accepts already authorized work", async t => {
  const f = await fixture(t), pending = f.chat("one"); await f.wait("one");
  const job = await f.scheduler.koinFundedSessions.work.next(f.worker);
  await f.post("revoke", { id: f.approval.delegationId });
  assert.equal(f.ledger.job(job.id).amount, job.quote.maxCharge);
  assert.equal((await f.result(job)).status, 200); assert.equal((await pending).status, 200);
  assert.equal(f.ledger.job(job.id).state, "prepared");
});

test("Stop releases queued work but never refunds or repeats dispatched work", async t => {
  const f = await fixture(t);
  for (const dispatched of [false, true]) {
    const n = String(dispatched), controller = new AbortController();
    const pending = f.chat(n, {}, controller.signal).catch(e => e); await f.wait(n);
    const job = dispatched && await f.scheduler.koinFundedSessions.work.next(f.worker);
    controller.abort(); await pending;
    for (let i = 0; i < 100 && !dispatched && f.ledger.job(P.hash(n)).state !== "cancelled"; i++) await new Promise(r => setTimeout(r, 5));
    const h = f.ledger.job(P.hash(n)); assert.equal(h.state, dispatched ? "dispatched" : "cancelled");
    assert.equal(h.amount, dispatched ? job.quote.maxCharge : "0");
    if (dispatched) {
      await f.result(job); let reply;
      for (let i = 0; i < 100; i++) { reply = await f.chat(n); if (reply.status === 200) break; await new Promise(r => setTimeout(r, 5)); }
      assert.equal(reply.status, 200, JSON.stringify(reply));
    }
    else assert.equal((await f.chat(n)).status, 409);
  }
});

test("fresh funding and account revocation are rechecked at asynchronous dispatch", async t => {
  const f = await fixture(t), pending = f.chat("one"); await f.wait("one");
  f.metadata.value.hash = "0x1220" + P.hash("changed");
  await assert.rejects(f.scheduler.koinFundedSessions.work.next(f.worker), /bytecode/);
  assert.equal(f.ledger.job(P.hash("one")).state, "reserved");
  f.metadata.value.hash = f.target.creditsHash;
  const read = f.rpc.readContract; let revoke = true;
  f.rpc.readContract = async op => { if (revoke) { revoke = false; f.accounts.revokeGrant(f.account, f.grant.id); } return read(op); };
  await assert.rejects(f.scheduler.koinFundedSessions.work.next(f.worker));
  assert.equal((await pending).status, 409); assert.equal(f.ledger.job(P.hash("one")).amount, "0");
});

test("wrong domain, tampered outputs and failed acceptance retain the dispatched hold", async t => {
  const f = await fixture(t), pending = f.chat("one"); await f.wait("one"); const job = await f.scheduler.koinFundedSessions.work.next(f.worker);
  const signature = Buffer.from(await signer.signHash(P.resultHash(job.quote.domain, job.id, job.attempt, job.quote.hash, "4"))).toString("base64");
  assert.ok((await f.result(job, { signature })).status >= 400);
  assert.ok((await f.result(job, { output: "5" })).status >= 400);
  const bad = Buffer.from(await signer.signHash(fundedResultHash(f.target, job, "5"))).toString("base64");
  assert.ok((await f.result(job, { output: "5", signature: bad })).status >= 400);
  assert.equal(f.ledger.job(job.id).amount, job.quote.maxCharge);
  await f.result(job); assert.equal((await pending).status, 200);
});

test("restart preserves holds and cannot redispatch lost work", async t => {
  const f = await fixture(t), pending = f.chat("one").catch(e => e); await f.wait("one"); const job = await f.scheduler.koinFundedSessions.work.next(f.worker);
  await f.restart(); await pending;
  f.live.scheduler.workers.set("fixture-worker", f.worker);
  assert.equal((await f.chat("one")).status, 409);
  assert.ok((await f.result(job)).status >= 400, "missing challenge context cannot accept new output after restart");
  assert.equal(f.live.ledger.job(job.id).amount, job.quote.maxCharge);
});


test("accepted signed-result replay can restore a lost answer after restart without a new charge", async t => {
  const f = await fixture(t), pending = f.chat("one"); await f.wait("one"); const job = await f.scheduler.koinFundedSessions.work.next(f.worker);
  await f.result(job); const first = await pending;
  await f.restart(); f.live.scheduler.workers.set("fixture-worker", f.worker);
  assert.equal((await f.chat("one")).status, 409);
  assert.equal((await f.result(job)).status, 200);
  assert.deepEqual((await f.chat("one")).body, first.body);
  assert.equal(f.live.ledger.delegationStatus({ id: f.approval.delegationId, accountId: f.account.id }).remainingJobs, 2);
});
