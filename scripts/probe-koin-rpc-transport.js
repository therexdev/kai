"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { provider, withSignal, submitter } = require("../lib/koin-network/rpc-transport");
const { fixture } = require("./helpers/koin-cycle-fixture");
const { RewardCycleRunner } = require("../lib/koin-network/reward-cycle-runner");
const reply = (request, result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(request.body).id, result }));
const urls = ["https://one.invalid", "https://two.invalid"];
test("a cancelled verification never sends a late transaction", async () => {
  let release, sends = 0;
  const client = { verify: () => new Promise(r => { release = r; }), provider: { call: async () => { sends++; return {}; } } };
  const controller = new AbortController(), pending = submitter(client)({ id: "saved" }, { signal: controller.signal });
  controller.abort(Error("deadline")); release();
  await assert.rejects(pending, /deadline/); assert.equal(sends, 0);
});
test("the transport aborts HTTP, does not replay a broadcast, and retains the rejection", async () => {
  let calls = 0;
  const p = provider(urls, { timeoutMs: 25, fetch: async (_url, req) => {
    calls++; return new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }));
  } });
  await assert.rejects(p.call("chain.submit_transaction", { transaction: { id: "saved" }, broadcast: true }), /timeout/);
  assert.equal(calls, 1); assert.equal(p.readGeneration, 1);
  const q = provider(urls, { fetch: async (_url, req) => {
    calls++; return new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(req.body).id, error: { message: "insufficient mana", code: -1 } }));
  } });
  await assert.rejects(q.call("chain.submit_transaction", {}), /insufficient mana/);
  assert.equal(calls, 2); assert.equal(q.readGeneration, 0);
});
test("parallel calls have separate identities and cancellation scopes", async () => {
  const requests = [], p = provider(urls, { fetch: async (_url, req) => { requests.push(req); return reply(req, { ok: true }); } });
  const controller = new AbortController(); controller.abort(Error("cancelled"));
  assert.throws(() => withSignal(controller.signal, () => p.call("chain.get_head_info", {})), /cancelled/);
  const values = await Promise.all([p.call("chain.get_head_info", {}), p.call("chain.get_chain_id", {})]);
  assert.equal(requests.length, 2); assert.notEqual(JSON.parse(requests[0].body).id, JSON.parse(requests[1].body).id);
  assert.deepEqual(values, [{ ok: true }, { ok: true }]);
});
test("a failed read changes endpoint only for future calls and invalidates observation generation", async () => {
  const seen = [], p = provider(urls, { fetch: async (url, req) => {
    seen.push(url); if (seen.length === 1) throw Error("offline"); return reply(req, {});
  } });
  await assert.rejects(p.call("chain.get_head_info", {}), /offline/);
  assert.deepEqual(seen, [urls[0]]); assert.equal(p.readGeneration, 1);
  await p.call("chain.get_head_info", {}); assert.deepEqual(seen, urls);
});
test("missing or reverted broadcast receipts remain uncertain", async () => {
  for (const value of [{}, { receipt: { id: "other" } }, { receipt: { id: "saved", reverted: true } }]) {
    const client = { verify: async () => {}, provider: { call: async () => value } };
    await assert.rejects(submitter(client)({ id: "saved" }), /reconciliation/);
  }
});
test("submission errors survive restart without changing attempts, signatures or recovery fences", async t => {
  const f = await fixture(t, { maxAttempts: 1 });
  await f.runner({ submit: async () => { throw Error("insufficient mana at https://private.invalid/secret " + "a".repeat(100)); } }).tick({ openCurrentDay: false });
  const before = f.cycle.status("1").steps[0];
  assert.equal(before.attempts, 1); assert.match(before.lastSubmission.error, /insufficient mana/);
  assert.doesNotMatch(before.lastSubmission.error, /private.invalid|a{80}/);
  f.reopen(); f.advance(1001);
  assert.equal((await f.runner().tick({ openCurrentDay: false })).results[0].reason, "attempt_limit");
  const after = f.cycle.status("1").steps[0];
  assert.deepEqual(after.lastSubmission, before.lastSubmission); assert.equal(after.txId, before.txId);
  assert.equal(after.attempts, 1); assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 0);
});
test("low Mana and read failures do not consume lifecycle attempts; the same saved signature resumes", async t => {
  const f = await fixture(t); let ready = false, offline = false;
  const cycle = f.open({ preflight: async () => { if (offline) throw Error("resource read offline"); return ready ? null : "lifecycle_mana_recharging"; } });
  const runner = new RewardCycleRunner({ mode: "isolated-rehearsal", cycle, prepare: f.prepare, submit: f.submit });
  for (let n = 0; n < 4; n++) {
    const d = (await runner.tick({ openCurrentDay: false })).results[0];
    assert.equal(d.reason, "lifecycle_mana_recharging"); assert.equal(cycle.status("1").steps[0].attempts, 0);
  }
  const txId = cycle.status("1").steps[0].txId;
  offline = true; await assert.rejects(runner.tick({ openCurrentDay: false }), /resource read offline/);
  assert.equal(cycle.status("1").steps[0].attempts, 0);
  offline = false; ready = true;
  assert.equal((await runner.tick({ openCurrentDay: false })).results[0].action, "await_finality");
  assert.equal(f.sent.length, 1); assert.equal(f.signed.length, 1); assert.equal(f.sent[0].id, txId);
});
