"use strict";
const path = require("path");
const P = require("./job-protocol");
const { ProviderQualification, policy } = require("./provider-qualification");

// Each model keeps its own immutable evidence and recovery journal. One wallet
// receives at most one benchmark challenge at a time, regardless of model.
class ProviderQualificationSet {
  constructor({ file, policies, target, meter, clock = Date.now, reviewed = () => [], providerDevices, preparePresence }) {
    if (!Array.isArray(policies) || !policies.length || policies.length > 64) throw Error("Bounded per-model qualification policies required");
    const validated = new Map();
    for (const value of policies) {
      const p = policy(value, meter.tariffs().find(t => t.model === value?.model && t.modelHash === value?.modelHash));
      if (validated.has(p.model)) throw Error("Duplicate model qualification policy");
      validated.set(p.model, p);
    }
    this.engines = new Map();
    Object.assign(this, { clock, providerDevices, preparePresence });
    for (const [model, p] of [...validated].sort(([a], [b]) => a.localeCompare(b))) {
      const engine = new ProviderQualification({ file: path.join(file + ".models", P.hash(model) + ".json"),
        policy: p, target, meter, clock, modelCapacity: true, providerDevices, preparePresence,
        reviewed: () => [...reviewed(), ...this.records()] });
      this.engines.set(model, engine);
    }
  }
  records() { return [...this.engines.values()].flatMap(e => e.records()); }
  status(address, model) {
    if (model !== undefined) return this.engines.get(model)?.status(address) || null;
    const statuses = [...this.engines].map(([model, e]) => ({ model, ...e.status(address) })).filter(s => s.state);
    if (!statuses.length) return null;
    return statuses.find(s => s.state === "testing") || statuses.find(s => s.state === "qualified") || statuses[0];
  }
  busy(address) { return [...this.engines.values()].some(e => e.busy(address)); }
  next(worker) {
    if (this.busy(worker.address)) return null;
    // A device cannot qualify through two wallets while both runs are pending.
    for (const e of this.engines.values()) for (const run of Object.values(e.state.runs)) {
      if (run.address !== worker.address && run.fingerprint === worker.fingerprint && e.busy(run.address)) return null;
      if (run.state === "testing" && e.targetMatches(run) && run.policyHash === e.policyHash && run.preparation?.expiresAt > this.clock() &&
          (!run.providerAuthorization || this.providerDevices?.workerActive(run)) &&
          ((run.address === worker.address && run.providerAuthorization !== worker.providerAuthorization) ||
            (run.address !== worker.address && run.fingerprint === worker.fingerprint))) return null;
    }
    // Finish one model's run before loading another. A slow failing model must
    // not restart every five minutes ahead of models that have never been
    // checked, otherwise an all-model provider can remain stuck on the first.
    const rank = e => {
      const run = e.state.runs[worker.address];
      if (!run || run.policyHash !== e.policyHash || !e.targetMatches(run)) return 1;
      if (run.state === "testing") return 0;
      return run.state === "qualified" ? 2 : 3;
    };
    const ordered = [...this.engines.values()].sort((a, b) => rank(a) - rank(b) ||
      Number(b.policy.model === worker.capabilities?.preferredModel) - Number(a.policy.model === worker.capabilities?.preferredModel));
    for (const e of ordered) { const job = e.next(worker); if (job) return job; }
    return this.restoreQualifiedModel(worker, ordered);
  }
  restoreQualifiedModel(worker, ordered) {
    if (!worker.providerAuthorization || worker.proof !== "signed" || worker.capabilities?.koinModelOnDemand !== 1 ||
        !this.providerDevices?.workerActive(worker) || typeof this.preparePresence !== "function") return null;
    const now = this.clock(), candidates = ordered.filter(e => worker.models?.includes(e.policy.model) &&
      e.records().some(q => q.address === worker.address && q.providerAuthorization === worker.providerAuthorization && q.fingerprint === worker.fingerprint) &&
      !(e.status(worker.address)?.state === "failed" && (!e.status(worker.address)?.deviceId || e.status(worker.address).deviceId === worker.providerDeviceId)) && !e.fingerprintOwnedElsewhere(worker));
    if (!candidates.length) return null;
    const presence = this.preparePresence(worker);
    if (presence?.ready && Number.isSafeInteger(presence.at) && presence.at <= now && presence.at > now - 90000 &&
        candidates.some(e => e.policy.model === presence.model && e.policy.modelHash === presence.modelHash)) {
      for (const e of candidates) if (e.state.restores?.[worker.providerAuthorization]) { delete e.state.restores[worker.providerAuthorization]; e.save(); }
      return null;
    }
    // The last attempted model may have failed. Return to an already qualified
    // selected model so availability earning does not depend on buyer traffic.
    const e = candidates[0], records = e.state.restores ||= {}, id = worker.providerAuthorization;
    let restore = records[id];
    if (restore && (restore.policyHash !== e.policyHash || restore.targetHash !== e.targetHash)) restore = null;
    if (restore?.expiresAt <= now) {
      if (!restore.retryAt) { restore.retryAt = now + e.policy.retryMs; e.save(); }
      if (restore.retryAt > now) return null;
      restore = null;
    }
    if (!restore) {
      for (const [key, value] of Object.entries(records)) if (key !== id && value.expiresAt + e.policy.retryMs < now) delete records[key];
      if (!Object.hasOwn(records, id) && Object.keys(records).length >= 256) return null;
      restore = records[id] = { policyHash: e.policyHash, targetHash: e.targetHash, issuedAt: now, expiresAt: now + 120000 }; e.save();
    }
    return { type: "koin-provider-prepare", target: structuredClone(e.target), policyHash: e.policyHash,
      model: e.policy.model, modelHash: e.policy.modelHash, issuedAt: restore.issuedAt, expiresAt: restore.expiresAt };
  }
  result(worker, body) {
    P.digest(body?.jobId);
    const matches = [...this.engines.values()].filter(e => {
      const run = e.state.runs[worker.address];
      return run?.pending?.challenge.id === body.jobId || run?.results.some(r => r.id === body.jobId);
    });
    if (matches.length !== 1) throw Error("Qualification attempt expired or changed");
    return matches[0].result(worker, body);
  }
}
module.exports = { ProviderQualificationSet };
