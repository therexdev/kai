"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os");
const { Signer } = require("koilib");
const { Scheduler } = require("../lib/scheduler");
const { Meter } = require("../lib/koin-network/metering");
const { hash, authorizeHash, resultHash, validateJob } = require("../lib/koin-network/job-protocol");
const { loadTokenizer } = require("../lib/koin-network/tokenizer");
const { ShadowConsumerReview, displayKoin } = require("../lib/koin-network/consumer-review");
const owner = Signer.fromSeed("shadow-flow-owner"), worker = Signer.fromSeed("shadow-flow-worker");
const modelHash = hash("fixture public model"), domain = "shadow:flow", secret = "fixture-operator";
const encode = (s) => [...Buffer.from(s)], input = [{ role: "user", content: "2 + 2?" }];
const catalog = { aliases: { "koinos-fast": { package: "approved" } }, packages: { approved: { sha256: modelHash } } };
const tariff = { model: "koinos-fast", version: 1, modelHash, tokenizerHash: hash("bytes"), templateHash: hash("json"),
  inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 32, contextTokens: 4096, maxLatencyMs: 60000 };
const meter = () => new Meter([{ tariff, adapter: { ...tariff, render: JSON.stringify, encode,
  input: (m) => encode(JSON.stringify(m)).length, output: (s) => encode(s).length } }]);
const sign = async (who, digest) => Buffer.from(await who.signHash(digest)).toString("base64");
async function setup(t, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koin-work-flow-")), m = meter();
  const s = new Scheduler({ dataDir: dir, operatorSecret: secret,
    ...(enabled ? { koinWork: { domain, meter: m,
      qualify: (address, model, pin) => address === worker.getAddress() && model === tariff.model && pin === modelHash,
      accept: ({ output }) => output === "4" } } : {}) });
  const port = await s.listen(0, "127.0.0.1");
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body, headers = { "x-operator-secret": secret }) => {
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const register = async (capability) => {
    const address = worker.getAddress(), ts = Date.now();
    const signature = await sign(worker, Buffer.from(hash(`register|${address}|${ts}`), "hex"));
    const r = await post("/worker/register", { address, ts, signature, models: ["koinos-fast"], capabilities: { ramGb: 8, koinShadowJobs: capability } });
    assert.equal(r.status, 200); return r.body.token;
  };
  const session = hash("grant"), id = hash("job");
  const prepare = async () => {
    assert.equal((await post("/koin/shadow/jobs/grant", { id: session, owner: owner.getAddress(), amount: "10000", perJob: "1000", maxJobs: 4,
      expires: Date.now() + 3600000, policyHash: m.policyHash })).status, 200);
    const q = (await post("/koin/shadow/jobs/quote", { model: "koinos-fast", version: 1, messages: input, maxOutput: 16 })).body.quote;
    const signature = await sign(owner, authorizeHash(domain, session, id, q.hash));
    const request = { id, session, quoteHash: q.hash, messages: input, signature };
    assert.equal((await post("/koin/shadow/jobs/reserve", request)).status, 200);
    return { q, request };
  };
  return { s, post, register, prepare, base, id, session };
}
test("canonical scheduler serves only opted-in qualified workers and keeps shadow receipts out of billing", async (t) => {
  const f = await setup(t), { q, request } = await f.prepare();
  assert.equal((await f.post("/koin/shadow/jobs/quote", { messages: input }, {})).status, 403);
  let token = await f.register(0);
  assert.equal(f.s.koinWork.next(f.s.workers.get(token)), null);
  await new Promise((r) => setTimeout(r, 2));
  token = await f.register(1);
  const poll = await fetch(`${f.base}/worker/next-job?token=${token}`), job = (await poll.json()).job;
  validateJob(job, catalog);
  assert.equal(job.quote.hash, q.hash);
  assert.equal((await fetch(`${f.base}/worker/next-job?token=${token}`)).status, 204, "duplicate poll cannot allocate legacy work");
  assert.equal((await f.post("/koin/shadow/jobs/reserve", { ...request, messages: [{ role: "user", content: "changed" }] })).status, 400);
  const signature = await sign(worker, resultHash(domain, job.id, job.attempt, q.hash, "4"));
  assert.equal((await f.post(`/koin/shadow/jobs/result?token=${token}`, { jobId: job.id, output: "4", signature: await sign(worker, Buffer.from(hash("legacy|4"), "hex")) }, {})).status, 400);
  const body = { jobId: job.id, output: "4", signature, usage: { completion_tokens: 999999 }, accepted: true };
  const first = await f.post(`/koin/shadow/jobs/result?token=${token}`, body, {});
  assert.equal(first.status, 200); assert.equal(first.body.paymentsEnabled, false);
  assert.deepEqual((await f.post(`/koin/shadow/jobs/result?token=${token}`, body, {})).body, first.body);
  const status = (await f.post("/koin/shadow/jobs/status", { id: job.id })).body;
  assert.equal(status.state, "verified"); assert.equal(status.usage.outputTokens, 1);
  assert.equal(f.s.receipts.length, 0); assert.deepEqual(f.s.usage, {}); assert.deepEqual(f.s.perf, {});
  assert.equal(f.s.koinWork.ledger.status(f.session).spent, "0");
});
test("shadow service is absent by default; signed worker results cannot supply the acceptance verdict", async (t) => {
  const off = await setup(t, false);
  assert.equal((await off.post("/koin/shadow/jobs/quote", {})).status, 404);
  const f = await setup(t); await f.prepare(); const token = await f.register(1);
  const job = (await (await fetch(`${f.base}/worker/next-job?token=${token}`)).json()).job;
  const signature = await sign(worker, resultHash(domain, job.id, job.attempt, job.quote.hash, "wrong"));
  assert.equal((await f.post(`/koin/shadow/jobs/result?token=${token}`, { jobId: job.id, output: "wrong", signature, accepted: true }, {})).status, 400);
  assert.equal((await f.post("/koin/shadow/jobs/cancel", { id: job.id })).body.state, "cancelled");
  assert.equal((await f.post(`/koin/shadow/jobs/result?token=${token}`, { jobId: job.id, output: "wrong", signature }, {})).status, 400);
  assert.equal(f.s.koinWork.ledger.status(f.session).held, "0");
});
test("tokenizer refuses changed files before parsing or using declared calibration", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koin-tokenizer-refuse-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "tokenizer.json"), "{}");
  const manifest = require("../lib/koin-network/tokenizers/qwen25-1.5b.json");
  assert.throws(() => loadTokenizer(dir, manifest), /hash mismatch/);
});

async function consumer(t, options = {}) {
  const f = await setup(t); let signatures = 0;
  await f.post("/koin/shadow/jobs/grant", { id: f.session, owner: owner.getAddress(), amount: "10000", perJob: "1000", maxJobs: 4,
    expires: Date.now() + 3600000, policyHash: meter().policyHash });
  const transport = async (route, body) => {
    const r = await f.post("/koin/shadow/jobs/" + route, body);
    if (r.status !== 200) throw Error(r.body.error);
    return r.body;
  };
  const client = new ShadowConsumerReview({ owner: owner.getAddress(), domain, policyHash: meter().policyHash,
    sign: async (digest) => { signatures++; return sign(owner, digest); },
    transport: options.transport ? (route, body) => options.transport(route, body, transport) : transport,
    ...(options.clock ? { clock: options.clock } : {}) });
  const review = () => client.review({ session: f.session, model: tariff.model, version: 1, messages: input, maxOutput: 16 });
  return { ...f, client, review, signatures: () => signatures };
}
test("consumer previews exact maximum and rejects without signing or reserving", async (t) => {
  const f = await consumer(t), preview = await f.review();
  assert.equal(preview.maximumChargeKoin, displayKoin(preview.maximumChargeAtoms));
  assert.equal(preview.paymentsEnabled, false); assert.equal(f.signatures(), 0);
  assert.equal(f.s.koinWork.ledger.status(f.session).held, "0");
  preview.maximumChargeAtoms = "1";
  f.client.reject(preview.reviewId);
  await assert.rejects(() => f.client.approve(preview.reviewId, preview.quoteHash));
  assert.equal(f.signatures(), 0);
  assert.equal(displayKoin("18446744073709551615"), "184467440737.09551615");
});
test("consumer explicit approval reaches scheduler once; lost response retries exact signed intent", async (t) => {
  let dropped = false; const sent = [];
  const f = await consumer(t, { transport: async (route, body, next) => {
    const r = await next(route, body);
    if (route === "reserve") {
      sent.push(body);
      if (!dropped) { dropped = true; throw Error("lost response"); }
    }
    return r;
  } });
  const p = await f.review();
  await assert.rejects(() => f.client.approve(p.reviewId, p.quoteHash), /lost response/);
  assert.equal(f.s.koinWork.ledger.status(f.session).held, p.maximumChargeAtoms);
  assert.equal((await f.client.retry(p.reviewId)).state, "reserved");
  assert.deepEqual(sent[0], sent[1]); assert.equal(f.signatures(), 1);
  assert.equal(f.s.koinWork.ledger.status(f.session).remainingJobs, 3);
  await assert.rejects(() => f.client.approve(p.reviewId, p.quoteHash));
});
test("consumer blocks stale, substituted and revoked quotes before signing", async (t) => {
  let offset = 0;
  const f = await consumer(t, { clock: () => Date.now() + offset });
  const p = await f.review();
  offset = 300001;
  await assert.rejects(() => f.client.approve(p.reviewId, p.quoteHash), /expired/);
  assert.equal(f.signatures(), 0);
  const g = await consumer(t); const q = await g.review();
  await assert.rejects(() => g.client.approve(q.reviewId, hash("different")), /changed/);
  await g.client.revoke(g.session);
  await assert.rejects(() => g.client.approve(q.reviewId, q.quoteHash));
  await assert.rejects(() => g.review(), /revoked/);
  assert.equal(g.signatures(), 0);
  const h = await consumer(t, { transport: async (route, body, next) => {
    const r = await next(route, body); if (route === "quote") r.quote.maxCharge = "1"; return r;
  } });
  await assert.rejects(() => h.review(), /price mismatch/);
  assert.equal(h.signatures(), 0);
});
test("double approval cannot sign twice and approval rechecks remaining session limits", async (t) => {
  const f = await consumer(t), p = await f.review();
  const attempts = await Promise.allSettled([f.client.approve(p.reviewId, p.quoteHash), f.client.approve(p.reviewId, p.quoteHash)]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.signatures(), 1);
  const g = await consumer(t), q = await g.review();
  // Simulate another approved job consuming the available session slots.
  const grant = g.s.koinWork.ledger.get("grants", g.session);
  grant.settledJobs = grant.maxJobs; g.s.koinWork.ledger.putGrant(grant);
  await assert.rejects(() => g.client.approve(q.reviewId, q.quoteHash), /exhausted/);
  assert.equal(g.signatures(), 0);
  assert.notEqual((await g.client.revoke(g.session)).revokedAt, null, "exhausted sessions can still be revoked");
});
test("session routes require operator auth and revocation retains verified holds", async (t) => {
  const f = await consumer(t), p = await f.review();
  await f.client.approve(p.reviewId, p.quoteHash);
  for (const route of ["session", "revoke"]) assert.equal((await f.post("/koin/shadow/jobs/" + route, { id: f.session }, {})).status, 403);
  const token = await f.register(1);
  const job = (await (await fetch(`${f.base}/worker/next-job?token=${token}`)).json()).job;
  const signature = await sign(worker, resultHash(domain, job.id, job.attempt, job.quote.hash, "4"));
  assert.equal((await f.post(`/koin/shadow/jobs/result?token=${token}`, { jobId: job.id, output: "4", signature }, {})).status, 200);
  const held = f.s.koinWork.ledger.status(f.session).held;
  const revoked = await f.client.revoke(f.session);
  assert.equal(revoked.held, held); assert.notEqual(held, "0");
  assert.equal((await f.client.revoke(f.session)).revokedAt, revoked.revokedAt);
});
test("consumer refuses another owner, policy or live-mode transport", async (t) => {
  for (const change of [
    (r) => { r.session.owner = worker.getAddress(); },
    (r) => { r.session.policyHash = hash("other-policy"); },
    (r) => { r.paymentsEnabled = true; },
  ]) {
    const f = await consumer(t, { transport: async (route, body, next) => {
      const r = await next(route, body); if (route === "session") change(r); return r;
    } });
    await assert.rejects(() => f.review()); assert.equal(f.signatures(), 0);
  }
});
test("revocation releases undispatched reservation and invalidates pending review", async (t) => {
  const f = await consumer(t), first = await f.review(), second = await f.review();
  await f.client.approve(first.reviewId, first.quoteHash);
  assert.notEqual(f.s.koinWork.ledger.status(f.session).held, "0");
  const result = await f.client.revoke(f.session);
  assert.equal(result.held, "0"); assert.equal(result.available, result.amount);
  assert.equal(f.s.koinWork.ledger.get("jobs", first.reviewId).state, "cancelled");
  await assert.rejects(() => f.client.approve(second.reviewId, second.quoteHash));
  assert.equal(f.signatures(), 1);
});
