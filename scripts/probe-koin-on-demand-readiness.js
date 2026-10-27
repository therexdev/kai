"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const P = require("../lib/koin-network/job-protocol");
const { providerReadiness } = require("../lib/koin-network/provider-readiness");
const { networkOverview } = require("../lib/koin-network/network-overview");
const { TestRuntime } = require("../lib/koin-network/test-runtime");

function fixture({ delegated = true } = {}) {
  const now = 1800000000000, address = "provider", target = { chainId: "test", domain: "shadow:test" };
  const tariffs = ["alpha", "beta"].map(model => ({ model, modelHash: P.hash(model) }));
  const worker = { address, lastSeen: now - 1000, proof: "signed", fingerprint: "a".repeat(16), models: ["alpha", "beta"],
    capabilities: { koinFundedRehearsalJobs: 1, koinQualification: 1, koinModelOnDemand: 1 },
    ...(delegated ? { providerAuthorization: "auth-a", providerDeviceId: "device-a" } : {}) };
  const qualifications = tariffs.map(t => ({ address, ...t, fingerprint: worker.fingerprint, expires: now + 3600000,
    capacityId: "capacity-" + t.model + "-" + worker.fingerprint, benchmarkHash: P.hash("benchmark-" + t.model),
    ...(delegated ? { providerAuthorization: worker.providerAuthorization, providerDeviceId: worker.providerDeviceId } : {}) }));
  const presence = { ...tariffs[0], ready: true, at: now }, presences = new Map([["auth-a", presence]]), revoked = new Set();
  const shadow = { state: { qualifications: {}, presence: { [address]: presence } }, save() {},
    qualify(q) { this.state.qualifications[q.capacityId] = q; } };
  const runtime = Object.assign(Object.create(TestRuntime.prototype), { clock: () => now, target, config: { models: tariffs.map(tariff => ({ tariff })) },
    reviewedQualifications: () => qualifications, prepaid: true, lastServing: now, cycle: { days: () => [] },
    providerDevices: delegated ? { active: id => !revoked.has(id), workerActive: w => !revoked.has(w.providerAuthorization), presence: w => presences.get(w.providerAuthorization) || null } : null,
    scheduler: { workers: new Map([["a", worker]]), koinShadow: { ledger: shadow }, koinPrepaid: { ledger: { busy: () => false, jobs: () => [], activeJobs: () => [] } } } });
  return { runtime, now, address, worker, presence, qualifications, tariffs, presences, revoked, shadow };
}

test("all separately qualified selected models are available on demand, but only loaded capacity earns availability", async () => {
  const f = fixture(), result = providerReadiness(f.runtime, f.address);
  assert.deepEqual(result.readyModels, ["alpha", "beta"]);
  assert.equal(result.models.find(m => m.model === "alpha").onDemand, false);
  assert.equal(result.models.find(m => m.model === "beta").onDemand, true);
  const network = networkOverview(f.runtime);
  assert.equal(network.readyProviders, 1);
  assert.deepEqual(network.models.map(m => [m.id, m.providers, m.available]), [["alpha", 1, true], ["beta", 1, true]]);
  await f.runtime.collectRewards();
  assert.deepEqual(Object.values(f.shadow.state.qualifications).map(q => q.model), ["alpha"]);
  f.presence.model = "beta"; f.presence.modelHash = f.tariffs[1].modelHash;
  await f.runtime.collectRewards();
  assert.deepEqual(Object.values(f.shadow.state.qualifications).filter(q => q.expires > f.now).map(q => q.model), ["beta"]);
});

test("on-demand visibility still requires fresh qualification, selected pins, active authority and a ready device", () => {
  for (const [name, mutate] of [
    ["capability", f => { delete f.worker.capabilities.koinModelOnDemand; }],
    ["unsigned", f => { f.worker.proof = "unsigned"; }],
    ["selected target", f => { f.worker.models = ["alpha"]; }],
    ["selected loaded model", f => { f.worker.models = ["beta"]; }],
    ["loaded pin", f => { f.presence.modelHash = P.hash("changed"); }],
    ["unknown loaded model", f => { f.presence.model = "unknown"; }],
    ["presence not ready", f => { f.presence.ready = false; }],
    ["stale presence", f => { f.presence.at = f.now - 90000; }],
    ["future presence", f => { f.presence.at = f.now + 1; }],
    ["stale worker", f => { f.worker.lastSeen = f.now - 45001; }],
    ["expired qualification", f => { f.qualifications[1].expires = f.now; }],
    ["missing qualification", f => { f.qualifications.splice(1); }],
    ["changed target pin", f => { f.qualifications[1].modelHash = P.hash("other"); }],
    ["other device qualification", f => { f.qualifications[1].providerAuthorization = "auth-b"; }],
    ["revoked", f => { f.revoked.add("auth-a"); }],
    ["processing paused", f => { f.runtime.lastServing = f.now - 60001; }],
  ]) {
    const f = fixture(); mutate(f);
    assert.notEqual(providerReadiness(f.runtime, f.address, "beta").state, "online", name);
  }
  const f = fixture(); f.qualifications[1].expires = f.now + 2000;
  assert.equal(providerReadiness(f.runtime, f.address, "beta").validUntil, f.now + 2000);
});

test("legacy providers remain loaded-model-only even if they claim on-demand support", () => {
  const f = fixture({ delegated: false });
  assert.deepEqual(providerReadiness(f.runtime, f.address).readyModels, ["alpha"]);
  assert.equal(providerReadiness(f.runtime, f.address, "beta").state, "preparing");
});

test("another device cannot borrow readiness or hide an older authorized ready device", () => {
  const f = fixture(), other = { ...f.worker, lastSeen: f.now, fingerprint: "b".repeat(16), providerAuthorization: "auth-b", providerDeviceId: "device-b" };
  f.runtime.scheduler.workers.set("b", other);
  assert.deepEqual(providerReadiness(f.runtime, f.address).readyModels, ["alpha", "beta"]);
  assert.notEqual(providerReadiness(f.runtime, f.address, "beta", "device-b").state, "online");
  f.runtime.qualifier = { records: () => [], status: (_address, model) => model === "beta" ? { state: "failed", deviceId: "device-b" } : null };
  assert.equal(providerReadiness(f.runtime, f.address, "beta").state, "online");
  assert.equal(providerReadiness(f.runtime, f.address, "beta", "device-b").state, "qualification-failed");
  f.revoked.add("auth-a");
  assert.notEqual(providerReadiness(f.runtime, f.address, "beta").state, "online");
});
