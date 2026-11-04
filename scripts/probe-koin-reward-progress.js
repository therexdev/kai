"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { TestRuntime } = require("../lib/koin-network/test-runtime");
const { PinnedRpcProvider, rpcDiagnostics } = require("../lib/koin-network/rpc-provider");
const offline = () => Object.assign(Error("KOIN RPC is temporarily unavailable. Check confirmation again shortly."),
  { code: "koin_rpc_unavailable", retryable: true });
function runtime() {
  const calls = [], record = name => async () => { calls.push(name); };
  const r = Object.assign(Object.create(TestRuntime.prototype), {
    clock: () => 100000, errors: [], prepaid: true, lastSuccess: 90000,
    scheduler: { koinPrepaid: { purchases: { tick: record("purchases") } } },
    prepaidSettlement: { tick: record("usage") },
    client: { verify: record("verify"), read: async () => { calls.push("pool"); return { liquid: "10", liabilities: "0" }; } },
    signing: { reconcile: record("signatures") }, recoverPreparedRewards: record("recover"),
    ledger: { pendingJobs: () => [] }, submitter: { tick: record("payout") },
    prepareSettlements: record("prepare"), cycleRunner: { tick: record("cycles") }, collectRewards: record("collect"),
  });
  return { r, calls };
}
test("a transient payout RPC failure does not suppress prepaid daily rewards or claim full settlement health", async () => {
  const { r, calls } = runtime();
  r.submitter.tick = async () => { calls.push("payout"); throw offline(); };
  await r.tick();
  assert.deepEqual(calls, ["purchases", "usage", "verify", "signatures", "recover", "payout", "pool", "cycles", "collect"]);
  assert.equal(r.lastSuccess, 90000); assert.equal(r.lastRewardSuccess, 100000);
  assert.equal(r.errors[0].stage, "payout_confirmation"); assert.equal(r.processingStage, null); assert.equal(r.busy, false);
  r.submitter.tick = async () => {}; r.clock = () => 110000; await r.tick();
  assert.equal(r.lastSuccess, 110000); assert.equal(r.lastRewardSuccess, 110000);
});
test("financial validation failures and legacy combined settlement failures retain their gate", async () => {
  for (const legacy of [false, true]) {
    const { r, calls } = runtime(); r.prepaid = !legacy;
    r.submitter.tick = async () => { throw legacy ? offline() : Error("Damaged reward manifest"); };
    await r.tick();
    assert.ok(!calls.includes("cycles")); assert.ok(!calls.includes("collect"));
    assert.equal(r.lastSuccess, 90000); assert.equal(r.lastRewardSuccess, undefined);
    assert.equal(r.errors[0].stage, "payout_confirmation");
  }
});
test("contract, usage, signature and daily reward failures do not acquire successful progress timestamps", async () => {
  for (const kind of ["usage_settlement", "contract_verification", "signature_reconciliation", "reward_cycles", "reward_collection"]) {
    const { r } = runtime(), fail = async () => { throw offline(); };
    if (kind === "usage_settlement") r.prepaidSettlement.tick = fail;
    if (kind === "contract_verification") r.client.verify = fail;
    if (kind === "signature_reconciliation") r.signing.reconcile = fail;
    if (kind === "reward_cycles") r.cycleRunner.tick = fail;
    if (kind === "reward_collection") r.collectRewards = fail;
    await r.tick(); assert.equal(r.errors[0].stage, kind);
    assert.equal(r.lastSuccess, 90000); assert.equal(r.lastRewardSuccess, undefined); assert.equal(r.busy, false);
  }
});
test("the current stage is visible while a pass is blocked and concurrent ticks do not start another pass", async () => {
  const { r, calls } = runtime(); let release;
  r.submitter.tick = () => new Promise(resolve => { release = resolve; });
  const pending = r.tick(); while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.processingStage, "payout_confirmation"); assert.equal(r.processingStartedAt, 100000);
  await r.tick(); assert.equal(calls.filter(c => c === "verify").length, 1);
  release(); await pending; assert.equal(r.processingStage, null);
});
test("operator diagnostics retain HTTP fallback failures without retaining any secret payload", async () => {
  const urls = ["https://diag-one.invalid/rpc?key=private", "https://diag-two.invalid"], bodies = [];
  const p = new PinnedRpcProvider(urls, "chain", { fetchImpl: async (url, req) => {
    bodies.push(req.body); return new Response("private response and signature", { status: url === urls[0] ? 503 : 403 });
  } });
  let failure; try { await p.getChainId(); } catch (e) { failure = e; }
  const rows = rpcDiagnostics(failure);
  assert.deepEqual(rows.map(r => r.httpStatus), [503, 403]);
  assert.deepEqual(rows.map(r => r.endpoint), ["https://diag-one.invalid", "https://diag-two.invalid"]);
  assert.equal(bodies.length, 2); assert.doesNotMatch(JSON.stringify(rows), /private|signature|\?key/);
  const { r } = runtime(); r.submitter.tick = async () => { throw failure; }; await r.tick();
  assert.deepEqual(r.errors[0].rpc, rows); assert.equal(r.lastRewardSuccess, 100000);
});
test("network and upstream RPC failure details are restricted to safe categories and codes", async () => {
  for (const kind of ["network", "rpc"]) {
    const p = new PinnedRpcProvider(["https://" + kind + ".invalid"], "chain", { fetchImpl: async (_url, req) => {
      if (kind === "network") throw Object.assign(Error("private signature"), { cause: { code: "ECONNRESET", message: "secret key" } });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(req.body).id,
        error: { code: -32603, message: "private signature", data: "rpc failed, AMQP connection is not open" } }));
    } });
    let failure; try { await p.getChainId(); } catch (e) { failure = e; }
    const rows = rpcDiagnostics(failure); assert.equal(rows[0].kind, kind);
    if (kind === "network") assert.deepEqual(rows[0].networkCodes, ["ECONNRESET"]);
    else assert.equal(rows[0].rpcCode, -32603);
    assert.doesNotMatch(JSON.stringify(rows), /private|signature|secret|AMQP/);
  }
});
test("attempt timeouts identify the method and queued work without issuing a late broadcast", async () => {
  const p = new PinnedRpcProvider(["https://diag-timeout.invalid"], "chain", {
    timeoutMs: 20, attemptTimeoutMs: 20, fetchImpl: async (_url, req) => new Promise((_, reject) => {
      req.signal.addEventListener("abort", () => reject(Error("private request body")), { once: true });
    }),
  });
  let failure; try { await p.call("chain.submit_transaction", { broadcast: true, transaction: { signature: "private" } }); } catch (e) { failure = e; }
  const [row] = rpcDiagnostics(failure);
  assert.equal(row.kind, "timeout"); assert.equal(row.method, "chain.get_chain_id");
  assert.equal(row.elapsedMs, 20); assert.equal(row.active, 1);
  assert.doesNotMatch(JSON.stringify(row), /private|signature/);
});
