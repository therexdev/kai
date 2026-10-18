"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("path");
const { fixture } = require("./helpers/koin-prepaid-fixture"), P = require("../lib/koin-network/job-protocol"), Q = require("../lib/koin-network/qualification-protocol");
const { ProviderQualification, policy } = require("../lib/koin-network/provider-qualification");
function setup(t) {
  const f = fixture(t), config = { schema: 1, model: "fixture", modelHash: f.tariff.modelHash, modelWeight: "1", coverageBps: 10000,
    reviewedEvidenceHash: P.hash("reviewed fixture only"), maxLatencyMs: 4000, minPass: 2, renewBeforeMs: 60000, retryMs: 60000,
    cases: ["first", "second"].map(id => ({ id, messages: [{ role: "user", content: "Reply exactly OK." }], expected: ["OK"], maxOutput: 16 })) };
  const options = { file: path.join(f.dir, "qualification.json"), policy: config, target: f.target, meter: f.meter, clock: () => f.ledger.clock() };
  const worker = { address: f.provider, fingerprint: "a".repeat(16), proof: "signed", capabilities: { koinQualification: 1 }, models: ["fixture"] };
  const body = async (job, output = "OK") => ({ jobId: job.challenge.id, output, signature: Buffer.from(await f.worker.signHash(Q.resultHash(job, P.hash(output)))).toString("base64") });
  return { ...f, config, options, worker, body, engine: new ProviderQualification(options) };
}
test("qualification uses fresh signed quality results, survives restart, and renews before one-day expiry", async t => {
  const f = setup(t), first = f.engine.next(f.worker); assert.equal(f.engine.records().length, 0); assert.equal(f.engine.busy(f.provider), true);
  assert.equal(f.engine.next(f.worker), null, "no duplicate challenge while awaiting its result");
  const result = await f.body(first); f.engine.result(f.worker, result); f.engine.result(f.worker, result);
  assert.equal(f.engine.status(f.provider).completed, 1);
  f.engine = new ProviderQualification(f.options); const second = f.engine.next(f.worker); assert.notEqual(second.challenge.id, first.challenge.id);
  f.engine.result(f.worker, await f.body(second)); const [record] = f.engine.records(); assert.equal(record.fingerprint, f.worker.fingerprint);
  assert.equal(record.expires, f.ledger.clock() + 86400000); assert.equal(f.engine.next(f.worker), null);
  assert.equal(f.ledger.purchases(f.owner).length, 0); assert.equal(f.ledger.jobs().length, 0, "benchmark requests never create paid usage");
  f.time(86400000 - 60000); const renewed = f.engine.next(f.worker); assert.ok(renewed); assert.notEqual(renewed.challenge.id, first.challenge.id);
  await assert.rejects(async () => f.engine.result(f.worker, result), /expired or changed/);
  f.engine.result(f.worker, await f.body(renewed)); f.engine.result(f.worker, await f.body(f.engine.next(f.worker)));
  assert.ok(f.engine.records()[0].expires > record.expires);
});
test("incorrect, expired or forged benchmark responses never create eligibility", async t => {
  const f = setup(t), first = f.engine.next(f.worker);
  const forged = await f.body(first); forged.output = "changed"; assert.throws(() => f.engine.result(f.worker, forged), /signature/i);
  f.engine.result(f.worker, await f.body(first, "Wrong"));
  const second = f.engine.next(f.worker); f.time(4001);
  assert.throws(() => f.engine.result(f.worker, { jobId: second.challenge.id, output: "OK", signature: "invalid" }), /expired/);
  assert.equal(f.engine.next(f.worker), null); assert.equal(f.engine.records().length, 0); assert.equal(f.engine.status(f.provider).state, "failed");
  assert.equal(f.engine.next(f.worker), null, "failed qualification has a persisted retry bound");
  f.engine = new ProviderQualification(f.options); assert.equal(f.engine.next(f.worker), null);
  f.time(60000); assert.ok(f.engine.next(f.worker));
});
test("renewal requires explicit reviewed criteria, a signed registered capacity and matching deployment", t => {
  const f = setup(t);
  for (const delta of [{ reviewedEvidenceHash: "" }, { minPass: 0 }, { minPass: 3 }, { maxLatencyMs: 5001 }, { cases: [] }, { modelHash: P.hash("different") }]) assert.throws(() => policy({ ...f.config, ...delta }, f.tariff));
  assert.equal(f.engine.next({ ...f.worker, proof: "unsigned" }), null); assert.equal(f.engine.next({ ...f.worker, capabilities: {} }), null);
  const job = f.engine.next(f.worker), catalog = { aliases: { fixture: { package: "model" } }, packages: { model: { sha256: f.tariff.modelHash } } };
  assert.equal(Q.validate(job, catalog, f.target, f.ledger.clock()).type, "koin-provider-qualification");
  assert.throws(() => Q.validate(job, catalog, { ...f.target, policyHash: P.hash("wrong") }, f.ledger.clock()), /target changed/);
  assert.equal(f.engine.next({ ...f.worker, fingerprint: "b".repeat(16) }), null); assert.equal(f.engine.status(f.provider).state, "failed");
});
test("real scheduler polling and result routes isolate benchmark work and authenticate the signed capacity", async t => {
  const f = setup(t), http = require("node:http"), Scheduler = require("../lib/scheduler").Scheduler;
  const scheduler = Object.assign(Object.create(Scheduler.prototype), { providerQualification: f.engine, _rehearsalPolls: new Set(), pending: new Map(), workers: new Map(), queue: [],
    _auth: req => new URL(req.url, "http://fixture").searchParams.get("token") === "signed-fixture" ? f.worker : null });
  const server = http.createServer((req, res) => scheduler.handle(req, res));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/worker/next-job")).status, 401);
  const first = await (await fetch(base + "/worker/next-job?token=signed-fixture")).json();
  assert.equal(first.job.type, "koin-provider-qualification");
  assert.equal((await fetch(base + "/worker/next-job?token=signed-fixture")).status, 204);
  const body = await f.body(first.job), send = token => fetch(base + "/koin/provider/qualification/result?token=" + token,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await send("wrong")).status, 401);
  assert.equal((await send("signed-fixture")).status, 200); assert.equal((await send("signed-fixture")).status, 200);
  assert.equal(f.engine.status(f.provider).completed, 1); assert.equal(f.ledger.jobs().length, 0);
});
