"use strict";
// Read-only: the UI cannot extend a qualification or change reward eligibility.
function providerReadiness(runtime, address) {
  const now = runtime.clock(), { model, modelHash } = runtime.config.tariff;
  const base = { address, model, asOf: now, validUntil: now + 15000 };
  const result = (state, detail, extra = {}) => ({ ...base, state, detail, ...extra });
  const approved = runtime.qualifications().filter(q => q.address === address && q.model === model && q.modelHash === modelHash);
  if (!approved.length) return result("review-required", "This computer needs its provider qualification before it can receive paid requests.");
  if (!runtime.qualified(address, model, modelHash, now)) return result("qualification-expired", "The provider qualification has expired. Network operator renewal is required before this computer can receive paid requests.");
  const worker = [...runtime.scheduler.workers.values()].filter(w => w.address === address && Number.isSafeInteger(w.lastSeen) && w.lastSeen <= now).sort((a, b) => b.lastSeen - a.lastSeen)[0];
  const capability = require("./payment-network").protocol(runtime.target).capability;
  if (!worker || worker.lastSeen < now - 45000) return result("connecting", "Waiting for this computer to connect to the network.");
  if (worker.proof !== "signed" || worker.capabilities?.[capability] !== 1) return result("update-required", "Start the provider in the current Test app to enable paid work.");
  if (!worker.models?.includes(model)) return result("model-required", "Install the approved model on this computer before providing AI.");
  const presence = runtime.scheduler.koinShadow.ledger.state.presence[address];
  if (!presence?.ready || presence.at <= now - 90000 || presence.model !== model || presence.modelHash !== modelHash)
    return result("preparing", "Waiting for a fresh report that the approved model is ready.");
  const serving = runtime.prepaid ? runtime.lastServing : runtime.lastSuccess;
  if (!serving || serving < now - 60000) return result("network-paused", "Network payment processing is reconnecting. Availability is not confirmed yet.");
  const qualificationUntil = Math.max(...approved.map(q => q.expires));
  return result("online", "Connected and eligible to receive network AI requests. Rewards depend on verified availability and completed work.",
    { validUntil: Math.min(base.validUntil, qualificationUntil, presence.at + 90000, worker.lastSeen + 45000, serving + 60000) });
}
module.exports = { providerReadiness };
