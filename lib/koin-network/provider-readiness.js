"use strict";
// Read-only: the UI cannot extend a qualification or change reward eligibility.
function providerReadiness(runtime, address) {
  const now = runtime.clock(), { model, modelHash } = runtime.config.tariff;
  const base = { address, model, asOf: now, validUntil: now + 15000 };
  const result = (state, detail, extra = {}) => ({ ...base, state, detail, ...extra });
  const renewal = runtime.qualifier?.status(address);
  if (renewal?.state === "testing") return result("qualifying", `Checking the approved model: ${renewal.completed} of ${renewal.total} benchmark checks completed.`, { qualification: renewal });
  if (renewal?.state === "failed") return result("qualification-failed", "The model did not meet the reviewed quality or latency requirements. The app will retry after the bounded recovery interval.", { qualification: renewal });
  const approved = runtime.qualifications().filter(q => q.address === address && q.model === model && q.modelHash === modelHash);
  if (!approved.length) return result("review-required", "This computer needs its provider qualification before it can receive paid requests.");
  if (!runtime.qualified(address, model, modelHash, now)) return result("qualification-expired", runtime.qualifier
    ? "The provider qualification has expired. Keep sharing on to run the approved model checks automatically. Paid work waits for a passing result."
    : "The provider qualification has expired. Reviewed automatic qualification criteria are unavailable; this computer cannot receive paid requests yet.");
  const worker = [...runtime.scheduler.workers.values()].filter(w => w.address === address && Number.isSafeInteger(w.lastSeen) && w.lastSeen <= now).sort((a, b) => b.lastSeen - a.lastSeen)[0];
  const capability = require("./payment-network").protocol(runtime.target).capability;
  if (!worker || worker.lastSeen < now - 45000) return result("connecting", "Waiting for this computer to connect to the network.");
  if (worker.proof !== "signed" || worker.capabilities?.[capability] !== 1) return result("update-required", "Start the provider in the current Test app to enable paid work.");
  if (!worker.models?.includes(model)) return result("model-required", "Install the approved model on this computer before providing AI.");
  const presence = runtime.scheduler.koinShadow.ledger.state.presence[address];
  if (!presence?.ready || !Number.isSafeInteger(presence.at) || presence.at > now || presence.at <= now - 90000 || presence.model !== model || presence.modelHash !== modelHash)
    return result("preparing", "Waiting for a fresh report that the approved model is ready.");
  const serving = runtime.prepaid ? runtime.lastServing : runtime.lastSuccess;
  if (!Number.isSafeInteger(serving) || serving > now || serving < now - 60000) return result("network-paused", "Network payment processing is reconnecting. Availability is not confirmed yet.");
  const qualificationUntil = Math.max(...approved.map(q => q.expires));
  return result("online", "Connected and eligible to receive network AI requests. Rewards depend on verified availability and completed work.",
    { validUntil: Math.min(base.validUntil, qualificationUntil, presence.at + 90000, worker.lastSeen + 45000, serving + 60000) });
}
module.exports = { providerReadiness };
