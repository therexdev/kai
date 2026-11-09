"use strict";
const { DAY } = require("./policy");

// This local pass consumes already-validated qualification and presence
// evidence. It never reads RPC, opens a budget, signs, or submits a transaction.
// An unavailable chain therefore cannot stop closing funded earning minutes.
async function refreshQualifications(runtime) {
  const now = runtime.clock(), shadow = runtime.scheduler.koinShadow.ledger;
  const qualifications = runtime.qualifications(), byAuthorization = new Map(), byWallet = new Map(), byModel = new Map();
  const key = q => JSON.stringify([q.address, q.model, q.modelHash]);
  for (const q of qualifications) { const k = key(q); if (!byModel.has(k)) byModel.set(k, []); byModel.get(k).push(q); }
  for (const worker of (runtime.scheduler.workers || new Map()).values()) {
    if (runtime.providerDevices && !runtime.providerDevices.workerActive(worker)) continue;
    if (worker.providerAuthorization && !byAuthorization.has(worker.providerAuthorization)) byAuthorization.set(worker.providerAuthorization, worker);
    if (worker.lastSeen <= now && (!byWallet.has(worker.address) || worker.lastSeen > byWallet.get(worker.address).lastSeen)) byWallet.set(worker.address, worker);
  }
  const effective = new Map(), devicePresence = new Map();
  for (const q of qualifications) {
    if (q.expires <= now || q.expires > now + DAY) continue;
    const worker = q.providerAuthorization ? byAuthorization.get(q.providerAuthorization) : byWallet.get(q.address);
    if (q.providerAuthorization && !worker) continue;
    if (!runtime.qualified(q.address, q.model, q.modelHash, now, worker, byModel.get(key(q)))) continue;
    let presence;
    if (q.providerAuthorization) {
      if (!devicePresence.has(q.providerAuthorization)) devicePresence.set(q.providerAuthorization, runtime.providerDevices.presence(worker));
      presence = devicePresence.get(q.providerAuthorization);
      if (!presence?.ready || presence.at < now - 90000 || presence.model !== q.model || presence.modelHash !== q.modelHash) continue;
    } else presence = shadow.getPresence(q.address);
    const old = effective.get(q.capacityId), selected = shadow.getQualification(q.capacityId)?.benchmarkHash;
    if (!old || q.benchmarkHash === selected || (old.q.benchmarkHash !== selected && (presence?.at || 0) > old.at)) effective.set(q.capacityId, { q, at: presence?.at || 0 });
  }
  const retired = shadow.listQualifications({ expiresAfter: now }).filter(q => q.expires > now && !effective.has(q.capacityId)).map(q => q.capacityId);
  if (retired.length) await shadow.expireQualifications(retired, now);
  for (const { q } of effective.values()) {
    const old = shadow.getQualification(q.capacityId);
    if (!old || old.benchmarkHash !== q.benchmarkHash || old.expires !== q.expires) await shadow.qualify(q);
  }
}
async function refreshAvailability(runtime) {
  await refreshQualifications(runtime);
  await runtime.scheduler.koinShadow.ledger.tick();
}
module.exports = { refreshAvailability, refreshQualifications };
