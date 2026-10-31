"use strict";
const path = require("path");
const P = require("./job-protocol");
const { ProviderQualification, policy } = require("./provider-qualification");
const SERVING_GAP_MS = 30000;

// Each model keeps its own immutable evidence and recovery journal. One wallet
// receives at most one benchmark challenge at a time, regardless of model.
class ProviderQualificationSet {
  get recoveryVersion() { return 1; }
  get readinessVersion() { return this.engines.size && [...this.engines.values()].every(e => require("./runtime-readiness").isPolicy(e.policy)) ? 1 : 0; }
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
      // Preserve every legacy quality run, including failed/incomplete evidence.
      // Schema-2 admission starts fresh; a failed old run is never promoted.
      const directory = require("./runtime-readiness").isPolicy(p) ? path.join(file + ".models", "runtime-readiness-v1", P.hash(JSON.stringify(p))) : file + ".models";
      const engine = new ProviderQualification({ file: path.join(directory, P.hash(model) + ".json"),
        policy: p, target: require("./additive-catalog").targetForModel(target,meter,model), meter, clock, modelCapacity: true, providerDevices, preparePresence,
        reviewed: () => [...reviewed(), ...this.records()] });
      this.engines.set(model, engine);
    }
  }
  records() { return [...this.engines.values()].flatMap(e => e.records()); }
  status(address, model, worker) {
    if (model !== undefined) {
      const status = this.engines.get(model)?.status(address) || null;
      if (status?.state === "failed" && worker?.address === address && this.sameRun(this.engines.get(model), worker)) {
        const bounds = this.servingBounds(worker);
        status.retryAt = Math.max(status.retryAt || 0, bounds.retryAt, bounds.serveUntil) || null;
      }
      return status;
    }
    const statuses = [...this.engines].map(([model, e]) => ({ model, ...e.status(address) })).filter(s => s.state);
    if (!statuses.length) return null;
    return statuses.find(s => s.state === "testing") || statuses.find(s => s.state === "qualified") || statuses[0];
  }
  busy(address) { return [...this.engines.values()].some(e => e.busy(address)); }
  assigned(address) { return [...this.engines.values()].some(e => e.assigned(address)); }
  sameRun(engine, worker) {
    const run = engine?.state.runs[worker.address];
    return run && run.policyHash === engine.policyHash && engine.targetMatches(run) && run.fingerprint === worker.fingerprint &&
      run.providerAuthorization === worker.providerAuthorization && run.providerDeviceId === worker.providerDeviceId ? run : null;
  }
  qualifiedEngines(worker, ordered = [...this.engines.values()]) {
    if (!worker.providerAuthorization || worker.proof !== "signed" || worker.capabilities?.koinModelOnDemand !== 1 ||
        !this.providerDevices?.workerActive(worker) || typeof this.preparePresence !== "function") return [];
    return ordered.filter(e => worker.models?.includes(e.policy.model) &&
      e.records().some(q => q.address === worker.address && q.providerAuthorization === worker.providerAuthorization && q.providerDeviceId === worker.providerDeviceId && q.fingerprint === worker.fingerprint) &&
      !(e.status(worker.address)?.state === "failed" && (!e.status(worker.address)?.deviceId || e.status(worker.address).deviceId === worker.providerDeviceId)) && !e.fingerprintOwnedElsewhere(worker));
  }
  servingBounds(worker) {
    if (!this.qualifiedEngines(worker).length) return { retryAt: 0, serveUntil: 0 };
    let retryAt = 0, serveUntil = 0;
    for (const e of this.engines.values()) {
      if (!worker.models?.includes(e.policy.model)) continue;
      const run = this.sameRun(e, worker);
      if (!run || !["qualified", "failed"].includes(run.state) || !Number.isSafeInteger(run.retryAt)) continue;
      // Existing retry timestamps survive restarts. A short serving interval
      // after each first-time model check prevents a long catalog pass from
      // keeping already qualified capacity unloaded for the entire pass.
      serveUntil = Math.max(serveUntil, run.retryAt - e.policy.retryMs + SERVING_GAP_MS);
      if (run.state === "failed") retryAt = Math.max(retryAt, run.retryAt);
      const restore = e.state.restores?.[worker.providerAuthorization];
      if (restore?.policyHash === e.policyHash && restore.targetHash === e.targetHash && Number.isSafeInteger(restore.readyAt) &&
          restore.readyAt >= restore.issuedAt && restore.readyAt <= restore.expiresAt)
        serveUntil = Math.max(serveUntil, restore.readyAt + SERVING_GAP_MS);
    }
    return { retryAt, serveUntil };
  }
  observeRestoredCapacity(worker) {
    const candidates = this.qualifiedEngines(worker);
    if (!candidates.length) return;
    const now = this.clock(), presence = this.preparePresence(worker);
    if (!presence?.ready || !Number.isSafeInteger(presence.at) || presence.at > now || presence.at <= now - 90000) return;
    for (const e of candidates) {
      const restore = e.state.restores?.[worker.providerAuthorization];
      if (restore?.policyHash !== e.policyHash || restore.targetHash !== e.targetHash || restore.readyAt !== undefined ||
          presence.model !== e.policy.model || presence.modelHash !== e.policy.modelHash ||
          presence.at < restore.issuedAt || presence.at > restore.expiresAt) continue;
      // A cold reload may consume the original post-check serving interval.
      // Record its first accepted ready observation in the existing restore
      // journal; polling and restart cannot move that observation forward.
      restore.readyAt = presence.at; e.save();
    }
  }
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
    this.observeRestoredCapacity(worker);
    // Finish one model's run before loading another. A slow failing model must
    // not restart every five minutes ahead of models that have never been
    // checked, otherwise an all-model provider can remain stuck on the first.
    const rank = e => {
      const run = this.sameRun(e, worker);
      if (!run) return 1;
      if (run.state === "testing") return 0;
      return run.state === "qualified" ? 2 : 3;
    };
    const ordered = [...this.engines.values()].sort((a, b) => rank(a) - rank(b) ||
      (rank(a) === 3 ? (this.sameRun(a, worker)?.retryAt || 0) - (this.sameRun(b, worker)?.retryAt || 0) : 0) ||
      Number(b.policy.model === worker.capabilities?.preferredModel) - Number(a.policy.model === worker.capabilities?.preferredModel));
    for (const e of ordered) {
      // next() can finish an expired preparation or the final timed-out
      // answer. Recompute before the following model so that transition also
      // restores qualified serving time in this same poll.
      const priority = rank(e), now = this.clock(), bounds = this.servingBounds(worker);
      if ((priority !== 0 && now < bounds.serveUntil) || (priority === 3 && now < bounds.retryAt)) continue;
      const job = e.next(worker); if (job) return job;
    }
    return this.restoreQualifiedModel(worker, ordered);
  }
  restoreQualifiedModel(worker, ordered) {
    const now = this.clock(), candidates = this.qualifiedEngines(worker, ordered);
    if (!candidates.length) return null;
    const presence = this.preparePresence(worker);
    if (presence?.ready && Number.isSafeInteger(presence.at) && presence.at <= now && presence.at > now - 90000 &&
        candidates.some(e => e.policy.model === presence.model && e.policy.modelHash === presence.modelHash)) {
      for (const e of candidates) {
        const restore = e.state.restores?.[worker.providerAuthorization];
        if (restore && (!Number.isSafeInteger(restore.readyAt) || now >= restore.readyAt + SERVING_GAP_MS)) {
          delete e.state.restores[worker.providerAuthorization]; e.save();
        }
      }
      return null;
    }
    // The last attempted model may have failed. Return to an already qualified
    // selected model so availability earning does not depend on buyer traffic.
    const e = candidates[0], records = e.state.restores ||= {}, id = worker.providerAuthorization;
    let restore = records[id];
    if (restore && (restore.policyHash !== e.policyHash || restore.targetHash !== e.targetHash)) restore = null;
    if (restore?.readyAt !== undefined) restore = null; // a completed reload is not an unfinished request to extend
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
    const result = matches[0].result(worker, body);
    return { ...result, qualification: this.status(worker.address, matches[0].policy.model, worker) };
  }
}
module.exports = { ProviderQualificationSet };
