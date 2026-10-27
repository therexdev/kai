"use strict";
// Read-only: the UI cannot extend a qualification or change reward eligibility.
function configuredTariffs(runtime) {
  return (runtime.config.models ? runtime.config.models.map(e => e.tariff) : [runtime.config.tariff]).slice().sort((a, b) => a.model.localeCompare(b.model));
}
function modelReadiness(runtime, address, tariff, deviceId) {
  const now = runtime.clock(), { model, modelHash } = tariff;
  const base = { address, model, asOf: now, validUntil: now + 15000 };
  const result = (state, detail, extra = {}) => ({ ...base, state, detail, ...extra });
  const approved = runtime.qualifications().filter(q => q.address === address && q.model === model && q.modelHash === modelHash);
  const workers = [...runtime.scheduler.workers.values()].filter(w => w.address === address && Number.isSafeInteger(w.lastSeen) && w.lastSeen <= now && (!deviceId || w.providerDeviceId === deviceId) && (!runtime.providerDevices || runtime.providerDevices.workerActive(w))).sort((a, b) => b.lastSeen - a.lastSeen);
  function observe(worker) {
    const renewal = runtime.qualifier?.status(address, model, worker);
    const renewalDevice = deviceId || worker?.providerDeviceId;
    if (renewal?.state === "testing" && (!renewalDevice || !renewal.deviceId || renewal.deviceId === renewalDevice)) return result("qualifying", `Checking the approved model: ${renewal.completed} of ${renewal.total} benchmark checks completed.`, { qualification: renewal });
    if (renewal?.state === "failed" && (!renewalDevice || !renewal.deviceId || renewal.deviceId === renewalDevice)) return result("qualification-failed",
      renewal.failure?.code === "preparation_timeout" ? "The model did not finish preparing before its load deadline. Already qualified models remain usable while this model waits to retry." :
      renewal.failure?.code === "unknown" ? "This model's last network check did not complete successfully. The saved result does not identify its cause." :
      `The model passed ${renewal.passed} of ${renewal.total} checks; ${renewal.required || renewal.total} are required. Already qualified models remain usable while this model waits to retry.`, { qualification: renewal });
    if (!approved.length) return result("review-required", "This computer needs its provider qualification before it can receive paid requests.");
    if (!runtime.qualified(address, model, modelHash, now, worker)) return result("qualification-expired", runtime.qualifier
      ? "The provider qualification has expired. Keep sharing on to run the approved model checks automatically. Paid work waits for a passing result."
      : "The provider qualification has expired. Reviewed automatic qualification criteria are unavailable; this computer cannot receive paid requests yet.");
    const capability = require("./payment-network").protocol(runtime.target).capability;
    if (!worker || worker.lastSeen < now - 45000) return result("connecting", "Waiting for this computer to connect to the network.");
    if (worker.proof !== "signed" || worker.capabilities?.[capability] !== 1) return result("update-required", "Start the provider in the current Test app to enable paid work.");
    if (!worker.models?.includes(model)) return result("model-required", "Install the approved model on this computer before providing AI.");
    const presence = worker.providerAuthorization ? runtime.providerDevices?.presence(worker) : runtime.scheduler.koinShadow.ledger.state.presence[address];
    const loaded = presence?.model === model && presence.modelHash === modelHash;
    // New scoped devices can load a selected, separately qualified model when a
    // request arrives. Its signed ready report must still identify a real pinned
    // model on this same device. This affects dispatch visibility only: reward
    // collection continues to require presence for the actually loaded model.
    const onDemand = !loaded && !!worker.providerAuthorization && worker.capabilities?.koinModelOnDemand === 1 &&
      worker.models.includes(presence?.model) && configuredTariffs(runtime).some(t => t.model === presence?.model && t.modelHash === presence?.modelHash);
    if (!presence?.ready || !Number.isSafeInteger(presence.at) || presence.at > now || presence.at <= now - 90000 || (!loaded && !onDemand))
      return result("preparing", "Waiting for a fresh report that the approved model is ready.");
    const serving = runtime.prepaid ? runtime.lastServing : runtime.lastSuccess;
    if (!Number.isSafeInteger(serving) || serving > now || serving < now - 60000) return result("network-paused", "Network payment processing is reconnecting. Availability is not confirmed yet.");
    const validQualifications = approved.filter(q => (!q.providerAuthorization || q.providerAuthorization === worker.providerAuthorization) && Number.isSafeInteger(q.expires) && q.expires > now && q.expires <= now + 86400000 &&
      (!q.fingerprint || q.fingerprint === worker.fingerprint) && (worker.capabilities?.koinQualification !== 1 || q.fingerprint === worker.fingerprint || q.capacityId?.endsWith(worker.fingerprint)));
    if (!validQualifications.length) return result("qualification-expired", "A fresh qualification for this model and computer is required.");
    const qualificationUntil = Math.max(...validQualifications.map(q => q.expires));
    return result("online", onDemand ? "Connected and qualified. This selected model loads automatically when a request arrives." : "Connected and eligible to receive network AI requests. Rewards depend on verified availability and completed work.",
      { onDemand, validUntil: Math.min(base.validUntil, qualificationUntil, presence.at + 90000, worker.lastSeen + 45000, serving + 60000) });
  }
  // A newer heartbeat from another device must not hide qualified capacity or
  // borrow its presence. Each candidate is evaluated with its own evidence.
  const observations = workers.length ? workers.map(observe) : [observe(undefined)];
  return observations.find(r => r.state === "online") || observations[0];
}
function providerReadiness(runtime, address, model, deviceId) {
  const tariffs = configuredTariffs(runtime);
  if (model !== undefined) {
    const tariff = tariffs.find(t => t.model === model);
    if (!tariff) throw Error("Unknown provider model");
    return modelReadiness(runtime, address, tariff, deviceId);
  }
  if (tariffs.length === 1) return modelReadiness(runtime, address, tariffs[0], deviceId);
  const models = tariffs.map(t => modelReadiness(runtime, address, t, deviceId)), online = models.filter(m => m.state === "online");
  const activeModel = runtime.scheduler.koinShadow.ledger.state.presence[address]?.model;
  const primary = online[0] || models.find(m => m.state === "qualifying") || models.find(m => m.model === activeModel) || models[0];
  if (!primary) throw Error("Configured provider models required");
  return { ...primary, ...(online.length ? { detail: "Connected and eligible to receive network AI requests on the ready model(s). Rewards depend on verified availability and completed work.",
    validUntil: Math.min(...online.map(m => m.validUntil)) } : {}), models, readyModels: online.map(m => m.model) };
}
module.exports = { providerReadiness, modelReadiness, configuredTariffs };
