"use strict";
const path = require("node:path"), { Worker } = require("node:worker_threads"), P = require("./policy"), Protocol = require("./shadow-worker-protocol");
const clone = value => structuredClone(value);
const unavailable = (message = "Shadow worker is unavailable", extra = {}) => Protocol.failure("SHADOW_WORKER_UNAVAILABLE", message, extra);
// No worker or database opens in this constructor. Runtime initialization must
// await ready before listening, and close must finish before source journals close.
class WorkerShadow {
  constructor(directory, { identity, markerFile, staging = false, clock = Date.now, limits = {}, workerFactory = (entry, options) => new Worker(entry, options) } = {}) {
    if (typeof directory !== "string" || !identity || typeof identity !== "object" || typeof clock !== "function" || typeof workerFactory !== "function") throw Error("Explicit shadow worker configuration required");
    this.directory = directory; this.storeOptions = clone({ identity, markerFile, staging }); this.clock = clock; this.workerFactory = workerFactory;
    this.limits = Protocol.limits(limits); this.state = "new"; this.queue = []; this.pendingBytes = 0; this.sequence = 0; this.revision = -1;
    this.inFlight = null; this.projection = null; this.waiters = []; this.failure = null; this.worker = null; this.exitSeen = false; this.closeAck = false;
  }
  get ready() { return this.start(); }
  start() {
    if (this.startPromise) return this.startPromise;
    if (this.state !== "new") return Promise.reject(unavailable("Shadow worker is closed"));
    this.state = "starting";
    this.startPromise = new Promise((resolve, reject) => { this.startResolve = resolve; this.startReject = reject; });
    try {
      this.worker = this.workerFactory(path.join(__dirname, "shadow-worker-thread.js"), { workerData: { directory: this.directory, storeOptions: this.storeOptions,
        now: Protocol.time(this.clock()), advanceClock: this.clock === Date.now, limits: this.limits }, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 } });
      this.worker.on("message", message => this._message(message));
      this.worker.on("error", error => this._fail(error));
      this.worker.on("exit", code => {
        this.exitSeen = true; this.exitCode = code;
        if (!this.closeAck || code !== 0) this._fail(unavailable("Shadow worker exited before a clean close", { exitCode: code }));
        this._finishClose();
      });
    } catch (error) { this.exitSeen = true; this._fail(error); }
    return this.startPromise;
  }
  health() {
    const now = this.clock(), currentEpoch = Number.isSafeInteger(now) && now >= 0 ? Math.floor(now / P.DAY) : null;
    const available = this.state === "ready", projectionAgeMs = this.projection ? now - this.projection.observedAt : null;
    const projectionReady = !!this.projection && currentEpoch === this.projection.epoch && projectionAgeMs >= 0 && projectionAgeMs <= this.limits.projectionMaxAgeMs;
    return { schema: 1, state: this.state, available, ready: available && projectionReady, currentEpoch,
      projectionEpoch: this.projection?.epoch ?? null, projectionObservedAt: this.projection?.observedAt ?? null,
      projectionAgeMs, revision: this.revision, queueDepth: this.queue.length + (this.inFlight ? 1 : 0), pendingBytes: this.pendingBytes,
      inFlight: this.inFlight?.method || null, limits: { ...this.limits }, failure: this.failure ? { code: this.failure.code, message: this.failure.message } : null };
  }
  _requireProjection() { if (!this.health().ready) throw unavailable("Committed shadow projection is unavailable or stale"); return this.projection; }
  _current(epoch) {
    const n = Protocol.epoch(epoch), projection = this._requireProjection();
    if (n !== projection.epoch) throw Protocol.failure("SHADOW_ASYNC_READ_REQUIRED", "Historical shadow data requires an asynchronous read");
    return projection;
  }
  getBudget(epoch) { return clone(this._current(epoch).budget); }
  getDayProgress(epoch) { return clone(this._current(epoch).progress); }
  getAvailability(epoch, address) {
    const p = this._current(epoch);
    return { availability: p.budget ? p.availability.get(address) || "0" : null, asOf: p.budget ? p.progress.lastIntervalEnd ?? p.budget.openedAt : null };
  }
  getPresence(address) { return clone(this._requireProjection().presence.get(address) || null); }
  getQualification(id) {
    const p = this._requireProjection(), q = p.qualifications.get(id);
    if (!q || q.expires <= this.clock()) throw Protocol.failure("SHADOW_ASYNC_READ_REQUIRED", "Uncached or expired qualification requires an asynchronous read");
    return clone(q);
  }
  listQualifications({ expiresAfter = this.clock() } = {}) {
    const p = this._requireProjection(); Protocol.time(expiresAfter);
    if (expiresAfter < p.observedAt) throw Protocol.failure("SHADOW_ASYNC_READ_REQUIRED", "Historical qualifications require an asynchronous read");
    return [...p.qualifications.values()].filter(q => q.expires > expiresAfter).map(clone);
  }
  hasQualifiedCapacity(address, at = this.clock()) {
    const p = this._requireProjection(); Protocol.time(at);
    if (at < p.observedAt) throw Protocol.failure("SHADOW_ASYNC_READ_REQUIRED", "Historical qualification requires an asynchronous read");
    return (p.walletExpiry.get(address) || 0) > at;
  }
  status(address) {
    const p = this._requireProjection(), now = this.clock(), presence = p.presence.get(address);
    let qualified = false;
    if (presence?.ready && presence.at > now - 90000) for (const id of p.walletQualifications.get(address) || []) {
      const q = p.qualifications.get(id); if (q && q.expires > now && q.model === presence.model && q.modelHash === presence.modelHash) { qualified = true; break; }
    }
    const row = p.availability.has(address) || p.work.has(address);
    return { schema: 1, mode: "shadow", asset: "KOIN", paymentsEnabled: false, claimable: null, usageCredit: null,
      estimate: row ? { availability: p.availability.get(address) || "0", work: p.work.get(address) || "0", simulated: true } : null,
      qualification: qualified ? "qualified-shadow" : presence ? "awaiting-verification" : "unreported", model: presence?.model || null,
      budget: clone(p.budget), policy: P.DEFAULTS, asOf: now };
  }
  _validateRows(rows, label, maximum = this.limits.maxRows) { if (!Array.isArray(rows) || rows.length > maximum) throw Protocol.failure("SHADOW_PROTOCOL_ERROR", "Invalid " + label + " projection"); return rows; }
  _validateDay(day) {
    Protocol.epoch(day?.epoch);
    if (!day.progress || typeof day.progress.present !== "boolean" || typeof day.progress.sealed !== "boolean" || !Number.isSafeInteger(day.progress.intervalCount) ||
        (day.budget !== null && (!day.budget || day.budget.epoch !== day.epoch))) throw Protocol.failure("SHADOW_PROTOCOL_ERROR", "Invalid current shadow day projection");
    for (const key of ["availability", "work"]) for (const row of this._validateRows(day[key], key)) { if (typeof row.address !== "string") throw Error("Invalid projected wallet"); P.uint(row.atoms); }
  }
  _validateQualification(id, value) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error("Invalid projected qualification ID");
    if (value !== null && (!value || value.capacityId !== id || typeof value.address !== "string" || !Number.isSafeInteger(value.expires))) throw Error("Invalid projected qualification");
  }
  _snapshot(snapshot) {
    Protocol.bytes(snapshot, this.limits.maxProjectionBytes, "projection"); this._validateDay(snapshot); Protocol.time(snapshot.observedAt);
    const qualifications = new Map(), presence = new Map();
    for (const q of this._validateRows(snapshot.qualifications, "qualification")) { this._validateQualification(q?.capacityId, q); if (qualifications.has(q.capacityId)) throw Error("Duplicate projected qualification"); qualifications.set(q.capacityId, q); }
    for (const row of this._validateRows(snapshot.presence, "presence")) { if (typeof row.address !== "string" || !row.value || Object.hasOwn(row.value, "samples") || presence.has(row.address)) throw Error("Invalid latest presence projection"); presence.set(row.address, row.value); }
    const p = { epoch: snapshot.epoch, observedAt: snapshot.observedAt, budget: snapshot.budget, progress: snapshot.progress, qualifications, presence,
      availability: new Map(snapshot.availability.map(r => [r.address, r.atoms])), work: new Map(snapshot.work.map(r => [r.address, r.atoms])), walletQualifications: new Map(), walletExpiry: new Map() };
    for (const q of qualifications.values()) { let ids = p.walletQualifications.get(q.address); if (!ids) p.walletQualifications.set(q.address, ids = new Set()); ids.add(q.capacityId); p.walletExpiry.set(q.address, Math.max(p.walletExpiry.get(q.address) || 0, q.expires)); }
    return p;
  }
  _delta(delta) {
    Protocol.bytes(delta, this.limits.maxProjectionBytes, "projection delta"); Protocol.time(delta?.observedAt); Protocol.epoch(delta.epoch);
    const p = this.projection; if (!p || (!delta.day && p.epoch !== delta.epoch)) throw Error("Missing current-day projection reset");
    if (delta.day) { this._validateDay(delta.day); if (delta.day.epoch !== delta.epoch) throw Error("Projection epoch changed"); }
    const qualifications = delta.qualifications || [], presence = delta.presence || [], availability = delta.availability || [], work = delta.work || [];
    let qCount = p.qualifications.size, pCount = p.presence.size; const pendingQualifications = new Map(), pendingPresence = new Set();
    for (const row of this._validateRows(qualifications, "qualification delta", this.limits.maxRows * 2)) { this._validateQualification(row.capacityId, row.value); pendingQualifications.set(row.capacityId, row.value); }
    for (const [id, value] of pendingQualifications) { if (!p.qualifications.has(id) && value) qCount++; if (p.qualifications.has(id) && !value) qCount--; }
    for (const row of this._validateRows(presence, "presence delta")) { if (typeof row.address !== "string" || !row.value || Object.hasOwn(row.value, "samples")) throw Error("Invalid latest presence delta"); if (!p.presence.has(row.address)) pendingPresence.add(row.address); }
    pCount += pendingPresence.size;
    if (qCount > this.limits.maxRows || pCount > this.limits.maxRows) throw Error("Shadow metadata projection capacity exceeded");
    const baseA = delta.day ? new Map(delta.day.availability.map(r => [r.address, r.atoms])) : p.availability,
      baseW = delta.replaceWork ? new Map() : delta.day ? new Map(delta.day.work.map(r => [r.address, r.atoms])) : p.work,
      addedA = new Set(), addedW = new Set();
    for (const row of this._validateRows(availability, "availability delta")) { if (typeof row.address !== "string") throw Error("Invalid projected wallet"); P.uint(row.atoms); if (!baseA.has(row.address)) addedA.add(row.address); }
    for (const row of this._validateRows(work, "work delta")) { if (typeof row.address !== "string") throw Error("Invalid projected wallet"); P.uint(row.atoms); if (!baseW.has(row.address)) addedW.add(row.address); }
    if (baseA.size + addedA.size > this.limits.maxRows || baseW.size + addedW.size > this.limits.maxRows) throw Error("Shadow amount projection capacity exceeded");
    if (delta.progress && (typeof delta.progress.present !== "boolean" || typeof delta.progress.sealed !== "boolean" || !Number.isSafeInteger(delta.progress.intervalCount))) throw Error("Invalid shadow progress delta");
    // All checks precede synchronous application. No await or callback can
    // expose half a committed delta to a request handler.
    const wallets = new Set();
    for (const [id, value] of pendingQualifications) {
      const old = p.qualifications.get(id);
      if (old) { wallets.add(old.address); p.walletQualifications.get(old.address)?.delete(id); }
      if (value) { p.qualifications.set(id, value); let ids = p.walletQualifications.get(value.address); if (!ids) p.walletQualifications.set(value.address, ids = new Set()); ids.add(id); wallets.add(value.address); }
      else p.qualifications.delete(id);
    }
    for (const wallet of wallets) { const ids = p.walletQualifications.get(wallet); let expires = 0; for (const id of ids || []) expires = Math.max(expires, p.qualifications.get(id).expires); if (expires) p.walletExpiry.set(wallet, expires); else { p.walletQualifications.delete(wallet); p.walletExpiry.delete(wallet); } }
    for (const row of presence) p.presence.set(row.address, row.value);
    if (delta.day) { p.epoch = delta.day.epoch; p.budget = delta.day.budget; p.progress = delta.day.progress; p.availability = new Map(delta.day.availability.map(r => [r.address, r.atoms])); p.work = new Map(delta.day.work.map(r => [r.address, r.atoms])); }
    if (delta.progress) p.progress = delta.progress;
    for (const row of availability) p.availability.set(row.address, row.atoms);
    if (delta.replaceWork) p.work.clear(); for (const row of work) p.work.set(row.address, row.atoms);
    p.observedAt = delta.observedAt;
  }
  _message(message) {
    try {
      if (message?.type === "ready") {
        if (!["starting", "closing"].includes(this.state) || message.revision !== 0) throw Error("Unexpected shadow initialization response");
        this.projection = this._snapshot(message.snapshot); this.revision = 0; this.state = this.closePromise ? "closing" : "ready"; this.startResolve(this); this._pump(); return;
      }
      if (message?.type === "fatal") { this._fail(Object.assign(Error(message.error?.message || "Shadow worker failed"), message.error)); return; }
      if (message?.type === "closed") {
        if (!this.closeSent || message.id !== this.closeId) throw Error("Unexpected shadow close response");
        this.closeAck = message.ok === true; if (!this.closeAck) this._fail(Object.assign(Error(message.error?.message || "Shadow worker close failed"), message.error)); return;
      }
      if (this.failure) return; // A late result cannot revive invalid projections.
      if (message?.type !== "result" || !this.inFlight || message.id !== this.inFlight.id || message.revision !== this.revision + 1 || typeof message.ok !== "boolean") throw Error("Shadow worker response sequence changed");
      Protocol.bytes(message.result === undefined ? null : message.result, this.limits.maxResponseBytes, "response"); this._delta(message.delta); this.revision = message.revision;
      const call = this.inFlight; this.inFlight = null; this.pendingBytes -= call.bytes;
      if (message.ok) call.resolve(message.result); else call.reject(Object.assign(Error(message.error?.message || "Shadow command rejected"), message.error));
      this._pump();
    } catch (error) { this._fail(error); }
  }
  invoke(method, args = []) {
    if (!Protocol.METHODS.has(method) || !Array.isArray(args)) return Promise.reject(Protocol.failure("SHADOW_INVALID_ARGUMENT", "Known shadow command required"));
    if (this.state !== "ready") return Promise.reject(unavailable("Shadow worker is not accepting commands", { uncertain: false }));
    let size, copied;
    try { size = Protocol.bytes(args, this.limits.maxRequestBytes, "request"); if (this.queue.length + (this.inFlight ? 1 : 0) >= this.limits.queueLimit || this.pendingBytes + size > this.limits.queueBytes) throw Protocol.failure("SHADOW_QUEUE_FULL", "Shadow worker admission capacity reached", { uncertain: false }); copied = clone(args); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => { this.queue.push({ id: ++this.sequence, method, args: copied, bytes: size, resolve, reject }); this.pendingBytes += size; this._pump(); });
  }
  _pump() {
    if (this.failure || this.inFlight || !["ready", "closing"].includes(this.state)) return;
    const call = this.queue.shift();
    if (call) {
      this.inFlight = call;
      try { this.worker.postMessage({ id: call.id, method: call.method, args: call.args, now: Protocol.time(this.clock()) }); }
      catch (error) { this._fail(error); }
    } else {
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
      if (this.state === "closing") this._sendClose();
    }
  }
  drain() { if (this.failure) return Promise.reject(this.failure); if (!this.inFlight && !this.queue.length) return Promise.resolve(); return new Promise((resolve, reject) => this.waiters.push({ resolve, reject })); }
  _fail(error) {
    if (this.failure) return;
    const inFlight = this.inFlight;
    this.failure = unavailable(String(error?.message || error).slice(0, 240), { causeCode: error?.code, uncertain: !!inFlight && Protocol.MUTATIONS.has(inFlight.method) });
    this.state = "failed"; this.projection = null; this.startReject?.(this.failure);
    if (inFlight) inFlight.reject(Protocol.MUTATIONS.has(inFlight.method) ? Protocol.failure("SHADOW_WRITE_UNCERTAIN", "Shadow write outcome is unknown; reconcile durable records before retrying", { uncertain: true, cause: this.failure }) : this.failure);
    for (const call of this.queue.splice(0)) call.reject(unavailable("Shadow command was not dispatched", { uncertain: false }));
    this.inFlight = null; this.pendingBytes = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
    this._sendClose(); this._finishClose();
  }
  _sendClose() {
    if (this.closeSent || !this.worker || this.exitSeen) return;
    this.closeSent = true; this.closeId = ++this.sequence;
    try { this.worker.postMessage({ id: this.closeId, method: "close", args: [], now: this.clock() }); } catch (error) { if (!this.failure) this._fail(error); }
  }
  close() {
    if (this.closePromise) return this.closePromise;
    if (this.state === "new") { this.state = "closed"; return this.closePromise = Promise.resolve(); }
    this.closePromise = new Promise((resolve, reject) => { this.closeResolve = resolve; this.closeReject = reject; });
    if (!this.failure) this.state = "closing";
    if (this.failure) this._sendClose(); else if (this.startPromise && !this.projection) this.startPromise.then(() => { this.state = "closing"; this._pump(); }, () => this._sendClose());
    else this._pump();
    this._finishClose(); return this.closePromise;
  }
  _finishClose() {
    if (!this.exitSeen || !this.closePromise) return;
    if (this.failure || !this.closeAck || this.exitCode !== 0) this.closeReject(this.failure || unavailable("Shadow worker did not close cleanly"));
    else { this.state = "closed"; this.projection = null; this.closeResolve(); }
  }
  getUnsealedEpochs() { return this.readUnsealedEpochs(); }
  manifest(epoch) { return this.readManifest(epoch); }
}
for (const method of Protocol.METHODS) WorkerShadow.prototype[method] = function (...args) { return this.invoke(method, args); };
module.exports = { WorkerShadow, SHADOW_WORKER_LIMITS: Protocol.DEFAULT_LIMITS };
