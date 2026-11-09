"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { operatorProgress } = require("../lib/koin-network/operator-progress");
const { createHandler } = require("../test-server");
const DAY = 86400000, now = 20766 * DAY + 120000;
function fixture() {
  const forbidden = () => { throw Error("Financial history must not be read by progress"); };
  const state = { budgets: { 20766: { openedAt: 20766 * DAY } },
    days: { 20766: { intervals: [{ end: 20766 * DAY + 60000 }] } } };
  state.qualifications = state.presence = new Proxy({}, { ownKeys: forbidden });
  return { clock: () => now, busy: true, stopped: false, processingStage: "reward_cycles",
    processingStartedAt: now - 10000, lastServing: now - 1000, lastSuccess: now - 3600000,
    lastRewardSuccess: now - 3600000, errors: [], scheduler: { koinShadow: { ledger: { state } } },
    status: forbidden, ledger: { settledJobs: forbidden }, cycle: { days: forbidden },
    signing: { resourceUsage: forbidden }, claims: { sponsorshipStatus: forbidden } };
}
test("progress reads bounded memory even when every financial status scan is unavailable", () => {
  const r = fixture(), p = operatorProgress(r);
  assert.equal(p.rewardRuntimeVersion, 3); assert.equal(p.busy, true);
  assert.equal(p.processTelemetry.version, 1); assert.ok(Number.isSafeInteger(p.processTelemetry.pid));
  assert.equal(p.processTelemetry.qualificationModelCount, null); assert.equal(p.lastRewardCycle, null);
  r.qualifier = { engines: new Map([["approved", {}]]) }; assert.equal(operatorProgress(r).processTelemetry.qualificationModelCount, 1);
  assert.equal(p.processingStage, "reward_cycles"); assert.equal(p.lastRewardSuccess, now - 3600000);
  assert.equal(p.lastSettlementSuccess, now - 3600000); assert.equal(p.lastServing, now - 1000);
  assert.deepEqual(p.currentEpoch, { epoch: "20766", budgetPresent: true, dayPresent: true,
    openedAt: 20766 * DAY, intervalCount: 1, lastIntervalEnd: 20766 * DAY + 60000 });
  delete r.scheduler.koinShadow.ledger.state.days[20766];
  delete r.scheduler.koinShadow.ledger.state.budgets[20766];
  const missing = operatorProgress(r).currentEpoch;
  assert.equal(missing.budgetPresent, false); assert.equal(missing.dayPresent, false);
  assert.equal(missing.openedAt, null); assert.equal(missing.lastIntervalEnd, null);
});
test("progress bounds and sanitizes errors, returns detached data and retains fresh rollover state", () => {
  const r = fixture(), secret = "a".repeat(64);
  r.errors = Array.from({ length: 30 }, (_, i) => ({ at: now - 30 + i, stage: "contract_verification",
    message: `Read https://rpc.invalid/?key=private failed ${secret}`,
    rpc: [{ endpoint: "https://rpc.invalid/?key=private", kind: "timeout", method: "chain.get_chain_id", active: 2, queued: 8,
      headers: { authorization: "private" }, body: secret }], privateKey: secret }));
  const p = operatorProgress(r);
  assert.equal(p.errors.length, 20); assert.equal(p.errors[0].at, now - 20);
  assert.doesNotMatch(JSON.stringify(p), /private|[a]{64}|authorization|\?key/);
  assert.equal(p.errors[0].rpc[0].endpoint, "https://rpc.invalid");
  p.errors[0].rpc[0].active = 99; assert.equal(r.errors[10].rpc[0].active, 2);
  r.clock = () => 20767 * DAY;
  assert.equal(operatorProgress(r).currentEpoch.epoch, "20767");
  assert.equal(operatorProgress(r).currentEpoch.budgetPresent, false);
});
test("HTTP progress requires the existing operator secret and never invokes full status", async t => {
  const r = fixture(), secret = "b".repeat(64);
  const config = { mode: "mainnet-pilot", schedulerUrl: "https://credits.invalid/scheduler",
    deployment: { chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: "fixture", product: "prepaid-usd-v1" } };
  r.prepaid = true;
  const server = http.createServer(createHandler({ runtime: r, config, secret }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = "http://127.0.0.1:" + server.address().port;
  for (const headers of [{}, { "x-operator-secret": "wrong" }]) {
    const denied = await fetch(url + "/operator/progress", { headers });
    assert.equal(denied.status, 403); assert.doesNotMatch(await denied.text(), /reward_cycles|20766/);
  }
  const response = await fetch(url + "/operator/progress", { headers: { "x-operator-secret": secret } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const p = await response.json(); assert.equal(p.processingStage, "reward_cycles");
  assert.equal(p.currentEpoch.budgetPresent, true);
  assert.equal((await fetch(url + "/operator/progress", { method: "POST", headers: { "x-operator-secret": secret } })).status, 404);
  const health = await (await fetch(url + "/health")).json();
  assert.equal(health.rewardRuntimeVersion, 3); assert.equal(health.lastRewardSuccess, now - 3600000);
  assert.equal(health.processingStage, undefined); assert.equal(health.errors, undefined);
  assert.equal(health.processTelemetry, undefined); assert.equal(health.lastRewardCycle, undefined);
  const stale = await fetch(url + "/health/earnings");
  assert.equal(stale.status, 503); assert.equal(stale.headers.get("cache-control"), "no-store");
  assert.deepEqual((await stale.json()).reasons, ["availability_processing_stale"]);
  r.lastAvailabilitySuccess = now;
  const tracking = await fetch(url + "/health/earnings");
  assert.equal(tracking.status, 200); assert.equal((await tracking.json()).ready, true);
  assert.equal((await fetch(url + "/health/earnings", { method: "POST" })).status, 404);
});
