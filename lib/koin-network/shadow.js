"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  { utils } = require("koilib");
const P = require("./policy");
const checkedHistories = new WeakSet(), emptyHistory = Object.freeze([]);
function orderedSamples(samples) {
  if (samples == null) return emptyHistory;
  if (!Array.isArray(samples)) throw Error("Invalid KOIN shadow sample history");
  if (!checkedHistories.has(samples)) {
    let previous = -1;
    for (const sample of samples) {
      if (!Number.isSafeInteger(sample?.at) || sample.at < 0 || sample.at <= previous)
        throw Error("KOIN shadow samples must be strictly chronological; original data was preserved");
      previous = sample.at;
    }
    checkedHistories.add(samples);
  }
  return samples;
}
function sampleBound(samples, at, after = false) {
  let low = 0, high = samples.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2), time = samples[middle].at;
    if (time < at || (after && time === at)) low = middle + 1;
    else high = middle;
  }
  return low;
}
const blank = () => ({
  schema: 1,
  mode: "shadow",
  qualifications: {},
  presence: {},
  observations: {},
  budgets: {},
  days: {},
});
// A separate durable, read-only-money ledger. Never derives a KOIN balance
// from legacy receipts, device fingerprints, advertisements or test-token USD.
class KoinShadow {
  constructor(dir, { clock = Date.now } = {}) {
    this.file = path.join(dir, "koin-shadow.json");
    this.clock = clock;
    this.state = blank();
    try {
      const s = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (s.schema !== 1 || s.mode !== "shadow")
        throw Error("Invalid KOIN shadow ledger");
      // Binary lookup needs the order observe() establishes. Validate persisted
      // histories once without sorting or rewriting any accounting evidence.
      for (const presence of Object.values(s.presence || {})) orderedSamples(presence?.samples);
      this.state = s;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  // Compatibility surface for the active JSON backend. Mutations are safe to
  // await, and snapshots never expose mutable accounting objects to callers.
  getBudget(epoch) { return structuredClone(this.state.budgets[String(epoch)] || null); }
  getQualification(capacityId) { return structuredClone(this.state.qualifications[capacityId] || null); }
  listQualifications() { return structuredClone(Object.values(this.state.qualifications)); }
  getPresence(address) {
    const p = this.state.presence[address];
    if (!p) return null;
    const { samples, ...latest } = p; return structuredClone(latest);
  }
  hasQualifiedCapacity(address, at = this.clock()) {
    return Object.values(this.state.qualifications).some(q => q.address === address && q.expires > at);
  }
  getUnsealedEpochs() {
    return Object.keys(this.state.budgets).filter(epoch => this.state.days[epoch] && !this.state.days[epoch].sealed)
      .sort((a, b) => Number(a) - Number(b));
  }
  getDayProgress(epoch) {
    const b = this.state.budgets[String(epoch)], d = this.state.days[String(epoch)];
    return { present: !!(b && d), sealed: d?.sealed === true, intervalCount: d?.intervals?.length || 0,
      nextStart: b && d ? d.intervals.at(-1)?.end ?? Math.ceil(b.openedAt / 60000) * 60000 : null,
      lastIntervalEnd: d?.intervals?.at(-1)?.end ?? null };
  }
  importBudget(epoch, budget) {
    if (!Number.isSafeInteger(budget?.epoch) || String(budget.epoch) !== String(epoch)) throw Error("Shadow budget epoch mismatch");
    P.allocate({ budget, intervals: [], work: [] });
    const old = this.state.budgets[String(epoch)];
    if (old) {
      if (JSON.stringify(old) !== JSON.stringify(budget) || !this.state.days[String(epoch)]) throw Error("Existing shadow budget differs");
      return false;
    }
    this.state.budgets[String(epoch)] = structuredClone(budget);
    this.state.days[String(epoch)] = { intervals: [], work: [] }; this.save(); return true;
  }
  getClosedEvidence(epoch) {
    const budget = this.state.budgets[String(epoch)], day = this.state.days[String(epoch)];
    if (!budget || !day) throw Error("Shadow day is unavailable");
    // Field order is part of the existing manifest evidence-hash input.
    return structuredClone({ budget, intervals: day.intervals, work: day.work });
  }
  commitWork(epoch, work) {
    const b = this.state.budgets[String(epoch)], d = this.state.days[String(epoch)];
    if (!b || !d || !Array.isArray(work)) throw Error("Shadow day and verified work required");
    const bytes = JSON.stringify(work);
    if (JSON.stringify(d.work) === bytes) return false;
    if (d.sealed) throw Error("Sealed shadow evidence cannot change");
    P.allocate({ budget: b, intervals: d.intervals, work });
    d.work = structuredClone(work); this.save(); return true;
  }
  markSealed(epoch) {
    const d = this.state.days[String(epoch)];
    if (!d) throw Error("Shadow day is unavailable");
    if (d.sealed === true) return false;
    d.sealed = true; this.save(); return true;
  }
  _allocationCache(epoch) {
    const b = this.state.budgets[String(epoch)], d = this.state.days[String(epoch)];
    if (!b || !d) return null;
    const caches = this.availabilityCaches ||= new Map(), key = String(epoch), budget = JSON.stringify(b);
    let cache = caches.get(key);
    if (!cache || cache.budget !== budget || cache.intervals !== d.intervals || cache.processed > d.intervals.length) {
      cache = { budget, intervals: d.intervals, processed: 0, previousEnd: b.openedAt, amounts: new Map() };
      caches.delete(key); caches.set(key, cache);
      while (caches.size > 2) caches.delete(caches.keys().next().value);
    }
    for (; cache.processed < d.intervals.length; cache.processed++) {
      const interval = d.intervals[cache.processed];
      if (interval.start < cache.previousEnd) throw Error("Overlapping or invalid interval");
      const result = P.allocate({ budget: b, intervals: [interval], work: [] });
      const updates = result.allocations.map(row => [row.address, P.add(cache.amounts.get(row.address) || 0n, row.availability)]);
      for (const [address, amount] of updates) cache.amounts.set(address, amount);
      cache.previousEnd = interval.end;
    }
    return cache;
  }
  getAvailability(epoch, address) {
    const cache = this._allocationCache(epoch), b = this.state.budgets[String(epoch)];
    return { availability: cache ? String(cache.amounts.get(address) || 0n) : null,
      asOf: cache ? cache.processed ? cache.previousEnd : b.openedAt : null };
  }
  _accountAllocation(epoch, address) {
    const cache = this._allocationCache(epoch), b = this.state.budgets[String(epoch)], d = this.state.days[String(epoch)];
    if (!cache) return null;
    if (cache.work !== d.work || cache.workLength !== d.work.length) {
      cache.workAmounts = new Map(P.allocate({ budget: b, intervals: [], work: d.work }).allocations.map(row => [row.address, row.work]));
      cache.work = d.work; cache.workLength = d.work.length;
    }
    return cache.amounts.has(address) || cache.workAmounts.has(address)
      ? { availability: String(cache.amounts.get(address) || 0n), work: cache.workAmounts.get(address) || "0" } : null;
  }
  qualify(q) {
    if (q && ["__proto__", "constructor", "prototype"].includes(q.capacityId)) throw Error("Invalid capacity ID");
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw Error("Valid qualification activation time required");
    if (
      !q ||
      !utils.isChecksumAddress(q.address) ||
      typeof q.capacityId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(q.capacityId) ||
      typeof q.model !== "string" ||
      q.model.length > 100 ||
      !q.model ||
      !/^([a-f0-9]{64})$/.test(q.modelHash) ||
      !/^([a-f0-9]{64})$/.test(q.benchmarkHash)
    )
      throw Error("Verified benchmark identity required");
    if (
      !Number.isSafeInteger(q.expires) ||
      q.expires <= now ||
      q.expires > now + P.DAY ||
      P.uint(q.modelWeight) === 0n
    )
      throw Error("Qualification must expire within a day");
    if (
      !Number.isInteger(q.coverageBps) ||
      q.coverageBps < 7500 ||
      q.coverageBps > 15000
    )
      throw Error("Invalid coverage");
    const previous = Object.hasOwn(this.state.qualifications, q.capacityId) ? this.state.qualifications[q.capacityId] : undefined;
    if ((!previous || previous.expires <= now) && Object.values(this.state.qualifications).filter(row => row.expires > now).length >= 10000)
      throw Error("Qualification capacity reached");
    // One effective service slot per verified capacity ID across addresses.
    this.state.qualifications[q.capacityId] = {
      address: q.address,
      capacityId: q.capacityId,
      model: q.model,
      modelHash: q.modelHash,
      modelWeight: q.modelWeight,
      coverageBps: q.coverageBps,
      benchmarkHash: q.benchmarkHash,
      expires: q.expires,
      approvedAt: now,
    };
    this.save();
  }
  expireQualifications(capacityIds, cutoff = this.clock()) {
    if (!Array.isArray(capacityIds) || capacityIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) ||
        !Number.isSafeInteger(cutoff) || cutoff < 0)
      throw Error("Valid capacity IDs and retirement cutoff required");
    const selected = [...new Set(capacityIds)].filter(id => Object.hasOwn(this.state.qualifications, id));
    let changed = false;
    for (const id of selected) {
      const q = this.state.qualifications[id];
      if (q.expires > cutoff) { q.expires = cutoff; changed = true; }
    }
    if (changed) this.save();
    return changed;
  }
  retireUnmatchedQualifications(models, verified) {
    if (!Array.isArray(models) || models.length > 64 || models.some(m => typeof m !== "string" || !m) || !Array.isArray(verified))
      throw Error("Configured admission models and verified evidence required");
    const selected = new Set(models), now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw Error("Valid admission activation time required");
    const byCapacity = new Map();
    for (const q of verified) { const list = byCapacity.get(q.capacityId) || []; list.push(q); byCapacity.set(q.capacityId, list); }
    const retired = [];
    for (const q of Object.values(this.state.qualifications)) {
      if (!selected.has(q.model) || q.expires <= now) continue;
      const matching = (byCapacity.get(q.capacityId) || []).some(current => ["address", "capacityId", "model", "modelHash", "benchmarkHash", "modelWeight", "coverageBps", "expires"]
        .every(key => current[key] === q[key]));
      if (matching) continue;
      // End future accrual before any presence handler can tick the ledger.
      // Keep the original identity/approvedAt and every historical interval,
      // work record, budget and manifest. Historical catch-up may still close
      // an interval ending before this exact activation cutoff.
      retired.push(q.capacityId);
    }
    return this.expireQualifications(retired, now);
  }
  observe(address, report) {
    if (
      !utils.isChecksumAddress(address) ||
      !report ||
      report.schema !== 1 ||
      !Number.isSafeInteger(report.at) ||
      Math.abs(report.at - this.clock()) > 60000 ||
      !Number.isSafeInteger(report.sequence) ||
      report.sequence < 0 ||
      typeof report.session !== "string" ||
      !/^[a-f0-9]{32}$/.test(report.session)
    )
      throw Error("Invalid presence report");
    if (
      typeof report.model !== "string" ||
      report.model.length > 100 ||
      !(report.modelHash === "" || /^[a-f0-9]{64}$/.test(report.modelHash)) ||
      typeof report.ready !== "boolean"
    )
      throw Error("Invalid model report");
    if (
      !Object.values(this.state.qualifications).some(
        (q) => q.address === address && q.expires > this.clock(),
      )
    )
      throw Error("Capacity qualification required before shadow collection");
    const old = this.state.presence[address];
    if (old?.session === report.session && report.sequence <= old.sequence)
      throw Error("Replayed presence");
    if (old && report.at <= old.signedAt) throw Error("Stale presence");
    if (old && this.clock() - old.at < 10000)
      throw Error("Presence rate exceeded");
    if (!old && Object.keys(this.state.presence).length >= 10000)
      throw Error("Presence capacity reached");
    const sample = {
      session: report.session,
      sequence: report.sequence,
      model: report.model,
      modelHash: report.modelHash,
      ready: report.ready,
      at: this.clock(),
      signedAt: report.at,
    };
    // Retain evidence needed by every unclosed interval, including catch-up
    // after restart. Pruning only the returning provider before tick would
    // make historical rewards depend on which provider returns first.
    let retainFrom = this.clock() - 180000;
    for (const [epoch, budget] of Object.entries(this.state.budgets)) {
      const day = this.state.days[epoch]; if (!day || day.sealed) continue;
      const start = day.intervals.at(-1)?.end ?? Math.ceil(budget.openedAt / 60000) * 60000;
      if (start + 60000 <= (Number(epoch) + 1) * P.DAY) retainFrom = Math.min(retainFrom, start - 45000);
    }
    const retained = orderedSamples(old?.samples).filter(p => p.at >= retainFrom);
    if (!Number.isSafeInteger(sample.at) || sample.at < 0 || (retained.length && sample.at <= retained.at(-1).at))
      throw Error("KOIN shadow samples must be strictly chronological; original data was preserved");
    sample.samples = [...retained, { ...sample }];
    checkedHistories.add(sample.samples);
    this.state.presence[address] = sample;
    this.save();
  }
  open(balance, { liabilities = "0" } = {}) {
    const openedAt = this.clock();
    const budget = P.dailyBudget({ balance, liabilities, openedAt });
    if (this.state.budgets[budget.epoch])
      throw Error("Shadow budget already opened");
    this.state.budgets[budget.epoch] = budget;
    this.state.days[budget.epoch] = { intervals: [], work: [] };
    this.save();
    return budget;
  }
  tick() {
    // A minute closes only after the existing 45-second heartbeat-gap bound.
    // Strictly pass the watermark so arrivals at its exact boundary cannot
    // race the timer. Persisted intervals and signed days are never rewritten.
    const now = this.clock(), watermark = Math.floor((now - 45001) / 60000) * 60000;
    let remaining = 120, changed = false, qualifications;
    for (const epoch of Object.keys(this.state.budgets).sort((a, b) => Number(a) - Number(b))) {
      const budget = this.state.budgets[epoch], day = this.state.days[epoch];
      if (!day || day.sealed) continue;
      let start = day.intervals.at(-1)?.end ?? Math.ceil(budget.openedAt / 60000) * 60000;
      const limit = Math.min(watermark, (Number(epoch) + 1) * P.DAY);
      for (; start + 60000 <= limit && remaining > 0; start += 60000, remaining--) {
        const end = start + 60000, slots = [];
        // One stable qualification snapshot for this synchronous catch-up pass.
        // Idle ticks still do no qualification/sample work.
        for (const q of (qualifications ||= Object.values(this.state.qualifications))) {
          if (q.approvedAt > start || q.expires < end) continue;
          const samples = orderedSamples(this.state.presence[q.address]?.samples);
          const first = sampleBound(samples, start, true) - 1, last = sampleBound(samples, end);
          if (first < 0 || last < first || last >= samples.length || samples[last].at > end + 45000) continue;
          let valid = true;
          for (let i = first; i <= last; i++) {
            const p = samples[i];
            if (!p.ready || p.model !== q.model || p.modelHash !== q.modelHash ||
                (i > first && (p.at - samples[i - 1].at > 45000 || p.session !== samples[i - 1].session))) { valid = false; break; }
          }
          if (!valid) continue;
          slots.push({ ...q, verified: true, eligible: true, reliabilityBps: P.reliability((this.state.observations[q.address] || []).filter(o => o.at <= end), end) });
        }
        slots.sort((a, b) => a.address.localeCompare(b.address) || a.capacityId.localeCompare(b.capacityId));
        day.intervals.push({ start, end, slots }); changed = true;
      }
      if (!remaining) break;
    }
    if (changed) this.save();
  }
  status(address) {
    const now = this.clock(),
      epoch = Math.floor(now / P.DAY),
      b = this.state.budgets[epoch],
      d = this.state.days[epoch],
      p = this.state.presence[address];
    const q = Object.values(this.state.qualifications).find(
      (x) =>
        x.address === address &&
        x.expires > now &&
        p?.ready &&
        p.at > now - 90000 &&
        p.model === x.model &&
        p.modelHash === x.modelHash,
    );
    const row = this._accountAllocation(epoch, address);
    return {
      schema: 1,
      mode: "shadow",
      asset: "KOIN",
      paymentsEnabled: false,
      claimable: null,
      usageCredit: null,
      estimate: row
        ? { availability: row.availability, work: row.work, simulated: true }
        : null,
      qualification: q
        ? "qualified-shadow"
        : p
          ? "awaiting-verification"
          : "unreported",
      model: p?.model || null,
      budget: b || null,
      policy: P.DEFAULTS,
      asOf: now,
    };
  }
  manifest(epoch) {
    const b = this.state.budgets[epoch],
      d = this.state.days[epoch];
    if (!b || !d || epoch >= Math.floor(this.clock() / P.DAY))
      throw Error("Closed shadow day required");
    const result = P.allocate({
      budget: b,
      intervals: d.intervals,
      work: d.work,
    });
    const data = { schema: 1, mode: "shadow", epoch, budget: b, ...result };
    return {
      ...data,
      hash: crypto
        .createHash("sha256")
        .update(JSON.stringify(data))
        .digest("hex"),
    };
  }
}
module.exports = { KoinShadow };
