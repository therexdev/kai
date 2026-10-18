"use strict";
const assert = require("node:assert/strict");
const { providerReadiness } = require("../lib/koin-network/provider-readiness");
const now = Date.now(), address = "provider", tariff = { model: "approved", modelHash: "a".repeat(64) };
let approved = true;
const q = { address, ...tariff, expires: now + 3600000 };
const worker = { address, lastSeen: now, proof: "signed", capabilities: { koinFundedRehearsalJobs: 1 }, models: [tariff.model] };
const presence = { ready: true, at: now, ...tariff };
const runtime = { clock: () => now, config: { tariff }, target: { chainId: "test", domain: "shadow:test" }, qualifications: () => [q], qualified: () => approved,
  lastSuccess: now, scheduler: { workers: new Map([["token", worker]]), koinShadow: { ledger: { state: { presence: { [address]: presence } } } } } };
assert.equal(providerReadiness(runtime, address).state, "online");
assert.equal(providerReadiness(runtime, address).validUntil, now + 15000);
approved = false; assert.equal(providerReadiness(runtime, address).state, "qualification-expired"); approved = true;
for (const [object, key, value, expected] of [[worker, "proof", "unsigned", "update-required"], [worker, "lastSeen", now - 46000, "connecting"],
  [worker, "models", [], "model-required"], [presence, "at", now - 90001, "preparing"], [presence, "ready", false, "preparing"],
  [presence, "at", now + 1, "preparing"], [presence, "modelHash", "wrong", "preparing"], [runtime, "lastSuccess", now + 1, "network-paused"], [runtime, "lastSuccess", now - 60001, "network-paused"]]) {
  const prior = object[key]; object[key] = value; assert.equal(providerReadiness(runtime, address).state, expected); object[key] = prior;
}
assert.equal(providerReadiness(runtime, "other-wallet").state, "review-required");
console.log("Provider readiness: qualified, signed, fresh, model-pinned; stale/expired/unsigned never ONLINE");
