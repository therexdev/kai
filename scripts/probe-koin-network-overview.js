"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), { networkOverview } = require("../lib/koin-network/network-overview");
test("network overview excludes expired qualification and reports real pending/delivered observations without prompts", () => {
  let now = 1790000000000, qualified = true; const model = "approved", address = "provider", modelHash = "a".repeat(64);
  const worker = { address, lastSeen: now, proof: "signed", capabilities: { koinFundedRehearsalJobs: 1 }, models: [model] };
  const ledger = { busy: () => false, activeJobs: () => [{ state: "queued" }, { state: "running" }], jobs: () => [{ id: "job", state: "charged", chargedAt: now - 100, quote: { tariff: { model } }, prompt: "must remain private" }] };
  const r = { clock: () => now, prepaid: true, lastServing: now, config: { tariff: { model, modelHash }, freePolicy: { eligibleModels: [model] } }, target: { chainId: "test", domain: "shadow:test" },
    qualified: () => qualified, qualifications: () => [{ address, model, modelHash, expires: now + 5000 }], scheduler: { workers: new Map([[address, worker]]), koinPrepaid: { ledger }, koinShadow: { ledger: { state: { presence: { [address]: { at: now, model, modelHash, ready: true } } } } } } };
  r.scheduler.workers.set("earlier-connection", { ...worker, lastSeen: now - 80000 });
  r.scheduler.workers.set("future-connection", { ...worker, address: "invalid-future", lastSeen: now + 100000 });
  const first = networkOverview(r); assert.equal(first.providers.length, 1); assert.equal(first.readyProviders, 1); assert.equal(first.waitingRequests, 1); assert.equal(first.completedToday, 1); assert.equal(first.validUntil, now + 5000); assert.equal(first.models[0].freeEligible, true);
  assert.ok(!JSON.stringify(first).includes("must remain private")); assert.ok(!first.providers.some(p => p.address));
  qualified = false; const expired = networkOverview(r); assert.equal(expired.readyProviders, 0); assert.equal(expired.models[0].available, false); assert.equal(expired.providers[0].state, "qualification-expired");
  now += 90001; assert.equal(networkOverview(r).providers.length, 0); assert.equal(networkOverview(r).state, "paused");
});
