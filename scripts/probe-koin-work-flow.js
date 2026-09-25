"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os");
const { Signer } = require("koilib");
const { Scheduler } = require("../lib/scheduler");
const { Meter } = require("../lib/koin-network/metering");
const { hash, authorizeHash, resultHash, validateJob } = require("../lib/koin-network/job-protocol");
const { loadTokenizer } = require("../lib/koin-network/tokenizer");
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
