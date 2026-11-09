"use strict";
const P = require("./policy"), Protocol = require("./shadow-worker-protocol");
const parse = row => JSON.parse(row.data);
// Runs only in the storage worker. The client receives bounded metadata and
// committed deltas, never samples, intervals, observations or archived work.
class ShadowWorkerEngine {
  constructor(store, { clock = Date.now, limits } = {}) {
    this.store = store; this.clock = clock; this.limits = Protocol.limits(limits); this.revision = 0; this.failed = false;
    this.qualifications = new Map(); this.nextExpiry = Infinity; this.transaction = null;
    const write = store.guard.write.bind(store.guard);
    store.guard.write = (db, fn) => {
      const tracked = this.transaction; let callbackError;
      try {
        const result = write(db, () => { try { return fn(); } catch (e) { callbackError = e; throw e; } });
        if (tracked) tracked.commits++; return result;
      } catch (error) {
        // JournalSet propagates the same callback error only after both
        // rollbacks succeeded. A different error may be in either commit.
        if (tracked && (!callbackError || error !== callbackError || error.code)) tracked.uncertain = true;
        throw error;
      }
    };
  }
  _rows(sql, ...args) {
    const rows = this.store.db.prepare(sql).all(...args, this.limits.maxRows + 1);
    if (rows.length > this.limits.maxRows) throw Protocol.failure("SHADOW_PROJECTION_LIMIT", "Shadow projection exceeds row limit");
    return rows;
  }
  _day(now) {
    const epoch = Math.floor(now / P.DAY), budget = this.store.getBudget(epoch), progress = this.store.getDayProgress(epoch);
    const availability = this._rows("SELECT address,atoms FROM availability WHERE epoch=? ORDER BY address LIMIT ?", epoch).map(r => ({ ...r }));
    const work = this._rows("SELECT address,atoms FROM work_totals WHERE epoch=? ORDER BY address LIMIT ?", epoch).map(r => ({ ...r }));
    return { epoch, budget, progress, availability, work };
  }
  initialize() {
    const now = Protocol.time(this.clock());
    const qualifications = this._rows("SELECT data FROM qualifications WHERE expires>? ORDER BY rowid LIMIT ?", now).map(parse);
    const presence = this._rows("SELECT address,data FROM presence_latest ORDER BY rowid LIMIT ?").map(r => ({ address: r.address, value: parse(r) }));
    for (const q of qualifications) { this.qualifications.set(q.capacityId, q); this.nextExpiry = Math.min(this.nextExpiry, q.expires); }
    const day = this._day(now); this.epoch = day.epoch;
    const snapshot = { observedAt: now, ...day, qualifications, presence };
    Protocol.bytes(snapshot, this.limits.maxProjectionBytes, "projection");
    return { revision: this.revision, snapshot };
  }
  _advance(now) {
    const delta = { epoch: Math.floor(now / P.DAY), observedAt: now };
    if (delta.epoch !== this.epoch) { delta.day = this._day(now); this.epoch = delta.epoch; }
    if (now >= this.nextExpiry) {
      this.nextExpiry = Infinity;
      for (const [id, q] of this.qualifications) {
        if (q.expires <= now) { this.qualifications.delete(id); (delta.qualifications ||= []).push({ capacityId: id, value: null }); }
        else this.nextExpiry = Math.min(this.nextExpiry, q.expires);
      }
    }
    return delta;
  }
  _qualification(delta, id, now) {
    const row = this.store.getQualification(id), value = row && row.expires > now ? row : null;
    if (value) { this.qualifications.set(id, value); this.nextExpiry = Math.min(this.nextExpiry, value.expires); }
    else this.qualifications.delete(id);
    (delta.qualifications ||= []).push({ capacityId: id, value });
  }
  _presence(delta, addresses) {
    for (const address of new Set(addresses)) { const value = this.store.getPresence(address); if (value) (delta.presence ||= []).push({ address, value }); }
  }
  _updatedDay(delta, method, args, before) {
    const current = this.epoch;
    if (method === "tick") {
      const progress = this.store.getDayProgress(current); delta.progress = progress;
      if (progress.intervalCount > before.intervalCount) {
        const addresses = new Set();
        for (const row of this.store.db.prepare("SELECT data FROM intervals WHERE epoch=? AND ordinal>=? ORDER BY ordinal").iterate(current, before.intervalCount)) {
          for (const slot of parse(row).slots) if (slot.verified && slot.eligible === true) addresses.add(slot.address);
          if (addresses.size > this.limits.maxRows) throw Protocol.failure("SHADOW_PROJECTION_LIMIT", "Shadow interval exceeds projection capacity");
        }
        delta.availability = [...addresses].map(address => ({ address, atoms: this.store.getAvailability(current, address).availability }));
      }
    } else if (method === "open" || (method === "importBudget" && Protocol.epoch(args[0]) === current)) delta.day = this._day(this.clock());
    else if (method === "commitWork" && Protocol.epoch(args[0]) === current) {
      delta.work = this._rows("SELECT address,atoms FROM work_totals WHERE epoch=? ORDER BY address LIMIT ?", current).map(r => ({ ...r })); delta.replaceWork = true;
    } else if ((method === "markSealed" && Protocol.epoch(args[0]) === current) || (method === "markSealedMany" && args[0].some(e => Protocol.epoch(e) === current))) delta.progress = this.store.getDayProgress(current);
  }
  _read(method, args) {
    const s = this.store;
    const validId = value => { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw Protocol.failure("SHADOW_INVALID_ARGUMENT", "Valid qualification ID required"); };
    if (["readBudget", "readDayProgress", "readAvailability", "getManifestEvidence", "readManifest"].includes(method)) Protocol.epoch(args[0]);
    if (method === "readQualification") validId(args[0]);
    if (method === "readAvailability" && (typeof args[1] !== "string" || !args[1] || args[1].length > 80)) throw Protocol.failure("SHADOW_INVALID_ARGUMENT", "Valid provider address required");
    if (method === "getManifestEvidence" || method === "readManifest") {
      if (!s.getBudget(args[0])) throw Protocol.failure("SHADOW_NOT_FOUND", "Shadow day is unavailable");
      if (method === "readManifest" && Protocol.epoch(args[0]) >= Math.floor(this.clock() / P.DAY)) throw Protocol.failure("SHADOW_INVALID_ARGUMENT", "Closed shadow day required");
      if (method === "getManifestEvidence" && args[1] !== undefined && (!args[1] || typeof args[1] !== "object" || ![undefined, "usd-pool"].includes(args[1].workBasis))) throw Protocol.failure("SHADOW_INVALID_ARGUMENT", "Known reward basis required");
    }
    if (method === "readBudget") return s.getBudget(...args);
    if (method === "readDayProgress") return s.getDayProgress(...args);
    if (method === "readQualification") return s.getQualification(...args);
    if (method === "readAvailability") return s.getAvailability(...args);
    if (method === "readUnsealedEpochs") {
      const rows = s.db.prepare("SELECT epoch FROM days WHERE sealed=0 ORDER BY epoch LIMIT ?").all(this.limits.maxRows + 1);
      if (rows.length > this.limits.maxRows) throw Protocol.failure("SHADOW_PAYLOAD_LIMIT", "Too many unsealed epochs for one response");
      return rows.map(row => String(row.epoch));
    }
    if (method === "readQualifications") {
      const ids = args[0]; if (!Array.isArray(ids) || ids.length > this.limits.maxRows) throw Protocol.failure("SHADOW_INVALID_ARGUMENT", "Bounded qualification IDs required");
      ids.forEach(validId);
      return ids.map(capacityId => ({ capacityId, qualification: s.getQualification(capacityId) }));
    }
    if (method === "getManifestEvidence") return s.getManifestEvidence(...args);
    if (method === "readManifest") return s.manifest(...args);
    if (method === "qualificationProjection") {
      const byWallet = new Map(); for (const q of this.qualifications.values()) if (q.expires > this.clock()) byWallet.set(q.address, Math.max(byWallet.get(q.address) || 0, q.expires));
      return [...byWallet].map(([address, expires]) => ({ address, expires }));
    }
    if (method === "refreshProjection") return { epoch: this.epoch, observedAt: this.clock() };
    throw Protocol.failure("SHADOW_INVALID_ARGUMENT", "Unknown shadow read");
  }
  execute(method, args) {
    if (this.failed) throw Protocol.failure("SHADOW_WORKER_UNAVAILABLE", "Shadow worker is unavailable");
    if (!Protocol.METHODS.has(method) || !Array.isArray(args)) throw Protocol.failure("SHADOW_PROTOCOL_ERROR", "Known shadow command required");
    Protocol.bytes(args, this.limits.maxRequestBytes, "request");
    const now = Protocol.time(this.clock()), delta = this._advance(now), mutation = Protocol.MUTATIONS.has(method);
    this.transaction = { commits: 0, uncertain: false };
    let result, phase = "invoke";
    try {
      if (!mutation) result = this._read(method, args);
      else {
        if (method === "tick") {
          const requested = args[0]?.maxIntervals ?? this.limits.maxTickIntervals;
          if (!Number.isInteger(requested) || requested < 1 || requested > this.limits.maxTickIntervals) throw Protocol.failure("SHADOW_INVALID_ARGUMENT", "Bounded worker tick required");
          args = [{ ...args[0], maxIntervals: requested, currentFirst: true }];
        }
        const before = this.store.getDayProgress(this.epoch);
        if (typeof this.store[method] !== "function") throw Protocol.failure("SHADOW_PROTOCOL_ERROR", "Shadow store capability missing: " + method);
        result = this.store[method](...args);
        if (result && typeof result.then === "function") throw Protocol.failure("SHADOW_PROTOCOL_ERROR", "Synchronous shadow store required inside worker");
        phase = "projection";
        if (method === "qualify") this._qualification(delta, args[0].capacityId, now);
        else if (method === "expireQualifications") for (const id of new Set(args[0])) this._qualification(delta, id, now);
        else if (method === "applyQualificationRefresh") for (const id of new Set([...(args[0].retired || []), ...(args[0].qualifications || []).map(q => q.capacityId)])) this._qualification(delta, id, now);
        else if (method === "retireUnmatchedQualifications") for (const id of [...this.qualifications.keys()]) this._qualification(delta, id, now);
        else if (method === "observe") this._presence(delta, [args[0]]);
        else if (method === "ingestPresence") this._presence(delta, [args[0].address]);
        else if (method === "ingestPresenceBatch") this._presence(delta, args[0].map(e => e.address));
        else if (method === "acceptLegacyPresence") this._presence(delta, [args[0].address]);
        this._updatedDay(delta, method, args, before);
      }
      const end = this._advance(Protocol.time(this.clock()));
      delta.observedAt = end.observedAt;
      if (end.qualifications) (delta.qualifications ||= []).push(...end.qualifications);
      if (delta.qualifications) delta.qualifications = [...new Map(delta.qualifications.map(row => [row.capacityId, row])).values()];
      if (end.day) { delta.epoch = end.epoch; delta.day = end.day; delete delta.availability; delete delta.work; delete delta.replaceWork; delete delta.progress; }
      if (this.qualifications.size > this.limits.maxRows) throw Protocol.failure("SHADOW_PROJECTION_LIMIT", "Shadow active qualification projection exceeds capacity");
      Protocol.bytes(delta, this.limits.maxProjectionBytes, "projection delta"); Protocol.bytes(result === undefined ? null : result, this.limits.maxResponseBytes, "response");
      return { ok: true, result, revision: ++this.revision, delta };
    } catch (error) {
      const tracking = this.transaction;
      const expected = phase === "invoke" && !tracking.uncertain && tracking.commits === 0 &&
        ((!mutation && ["SHADOW_INVALID_ARGUMENT", "SHADOW_PAYLOAD_LIMIT", "SHADOW_NOT_FOUND"].includes(error.code)) ||
         (mutation && (!error.code || error.code === "SHADOW_INVALID_ARGUMENT")));
      if (expected) return { ok: false, error: Protocol.serializeError(error, { uncertain: false }), revision: ++this.revision, delta };
      this.failed = true;
      return { fatal: true, error: Protocol.serializeError(error, { uncertain: mutation && (tracking.uncertain || tracking.commits > 0) }) };
    } finally { this.transaction = null; }
  }
  close() { this.failed = true; this.store.close(); }
}
module.exports = { ShadowWorkerEngine };
