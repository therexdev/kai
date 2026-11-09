"use strict";
const { DAY } = require("./policy");

// This local pass consumes already-validated qualification and presence
// evidence. It never reads RPC, opens a budget, signs, or submits a transaction.
// An unavailable chain therefore cannot stop closing funded earning minutes.
function refreshQualifications(runtime) {
  if (runtime.qualificationRefresh) return runtime.qualificationRefresh;
  const pending = refreshQualificationSnapshot(runtime);
  runtime.qualificationRefresh = pending;
  const clear = () => { if (runtime.qualificationRefresh === pending) runtime.qualificationRefresh = null; };
  pending.then(clear, clear);
  return pending;
}
async function refreshQualificationSnapshot(runtime) {
  const shadow = runtime.scheduler.koinShadow.ledger;
  // Day rollover or a delayed pass can invalidate the bounded synchronous
  // projection. Refresh it without closing intervals before eligibility updates.
  if (shadow.refreshProjection) await shadow.refreshProjection();
  const now = runtime.clock();
  const qualifications = runtime.qualifications(), byAuthorization = new Map(), byWallet = new Map(), byModel = new Map();
  const key = q => JSON.stringify([q.address, q.model, q.modelHash]);
  for (const q of qualifications) { const k = key(q); if (!byModel.has(k)) byModel.set(k, []); byModel.get(k).push(q); }
  for (const worker of (runtime.scheduler.workers || new Map()).values()) {
    if (runtime.providerDevices && !runtime.providerDevices.workerActive(worker)) continue;
    if (worker.providerAuthorization && !byAuthorization.has(worker.providerAuthorization)) byAuthorization.set(worker.providerAuthorization, worker);
    if (worker.lastSeen <= now && (!byWallet.has(worker.address) || worker.lastSeen > byWallet.get(worker.address).lastSeen)) byWallet.set(worker.address, worker);
  }
  const candidates = [], devicePresence = new Map();
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
    candidates.push({ q, at: presence?.at || 0 });
  }
  // Latest expired records still select the benchmark winner when competing
  // authorizations share a capacity. They cannot be treated as a cache miss.
  const latest = new Map();
  if (shadow.readQualifications) {
    const ids = [...new Set(candidates.map(({ q }) => q.capacityId))];
    for (let offset = 0; offset < ids.length; offset += 10000) {
      const batch = ids.slice(offset, offset + 10000), rows = await shadow.readQualifications(batch);
      if (!Array.isArray(rows) || rows.length !== batch.length || rows.some((row, index) => row?.capacityId !== batch[index] || row.qualification === undefined))
        throw Object.assign(Error("Incomplete reward qualification snapshot"), { code: "SHADOW_INVALID_RESPONSE", statusCode: 503 });
      for (const row of rows) latest.set(row.capacityId, row.qualification);
    }
  }
  const previous = id => shadow.readQualifications ? latest.get(id) : shadow.getQualification(id), effective = new Map();
  for (const { q, at } of candidates) {
    const old = effective.get(q.capacityId), selected = previous(q.capacityId)?.benchmarkHash;
    if (!old || q.benchmarkHash === selected || (old.q.benchmarkHash !== selected && at > old.at)) effective.set(q.capacityId, { q, at });
  }
  // Cold reads can advance both time and the committed projection. Use one
  // fresh cutoff for the active rows and their retirement, not a historic view.
  const retirementAt = runtime.clock();
  const retired = shadow.listQualifications({ expiresAfter: retirementAt }).filter(q => q.expires > retirementAt && !effective.has(q.capacityId)).map(q => q.capacityId);
  const changed = [];
  for (const { q } of effective.values()) {
    const old = previous(q.capacityId);
    if (!old || old.benchmarkHash !== q.benchmarkHash || old.expires !== q.expires) changed.push(q);
  }
  if (shadow.applyQualificationRefresh) {
    // One coordinator turn and database transaction prevents an earning tick
    // or a presence report from observing half of this refreshed capacity set.
    if (retired.length || changed.length) await shadow.applyQualificationRefresh({ retired, qualifications: changed, cutoff: retirementAt });
  } else {
    if (retired.length) await shadow.expireQualifications(retired, retirementAt);
    for (const q of changed) await shadow.qualify(q);
  }
}
async function refreshAvailability(runtime) {
  await refreshQualifications(runtime);
  await runtime.scheduler.koinShadow.ledger.tick();
}
module.exports = { refreshAvailability, refreshQualifications };
