"use strict";
const path = require("path");
const P = require("./job-protocol");
const { ProviderQualification, policy } = require("./provider-qualification");

// Each model keeps its own immutable evidence and recovery journal. One wallet
// receives at most one benchmark challenge at a time, regardless of model.
class ProviderQualificationSet {
  constructor({ file, policies, target, meter, clock = Date.now, reviewed = () => [] }) {
    if (!Array.isArray(policies) || !policies.length || policies.length > 64) throw Error("Bounded per-model qualification policies required");
    const validated = new Map();
    for (const value of policies) {
      const p = policy(value, meter.tariffs().find(t => t.model === value?.model && t.modelHash === value?.modelHash));
      if (validated.has(p.model)) throw Error("Duplicate model qualification policy");
      validated.set(p.model, p);
    }
    this.engines = new Map();
    for (const [model, p] of [...validated].sort(([a], [b]) => a.localeCompare(b))) {
      const engine = new ProviderQualification({ file: path.join(file + ".models", P.hash(model) + ".json"),
        policy: p, target, meter, clock, modelCapacity: true,
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
    }
    for (const e of this.engines.values()) { const job = e.next(worker); if (job) return job; }
    return null;
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
