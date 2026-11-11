"use strict";
const owners = new WeakMap();
const READS = new Set(["getBudget", "getQualification", "listQualifications", "qualificationProjection", "getPresence", "hasQualifiedCapacity", "getUnsealedEpochs", "getDayProgress", "getClosedEvidence", "getManifestEvidence", "getAvailability", "status", "manifest", "descriptor"]);
const READ_ALIASES = { getBudget: "readBudget", getQualification: "readQualification", getDayProgress: "readDayProgress", getAvailability: "readAvailability", getUnsealedEpochs: "readUnsealedEpochs", status: "readStatus", manifest: "readManifest" };
for (const name of [...Object.values(READ_ALIASES), "readQualifications", "refreshProjection"]) READS.add(name);
const MUTATIONS = new Set(["qualify", "expireQualifications", "retireUnmatchedQualifications", "applyQualificationRefresh", "open", "importBudget", "commitWork", "markSealed", "markSealedMany", "tick"]);
const QUALIFICATIONS = new Set(["qualify", "expireQualifications", "retireUnmatchedQualifications", "applyQualificationRefresh"]);
function unavailable(message, code = "SHADOW_STORAGE_UNAVAILABLE") { return Object.assign(Error(message), { status: 503, code }); }
function positive(value, max, label) { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error("Invalid coordinator " + label); return value; }
// This single ordering owner is the only caller allowed to mutate its worker or
// accept source presence. A queue slot is reserved before any source write, and
// an outstanding worker call never releases that slot on a timer or HTTP abort.
class PresenceCoordinator {
  constructor({ source = null, client, audience, clock = Date.now, maxPending = 128, batchSize = 64,
    maxQueuedBytes = 8 * 1024 * 1024, maxOperationBytes = 4 * 1024 * 1024 } = {}) {
    if (!client || typeof client.close !== "function" || typeof audience !== "string" || !audience || typeof clock !== "function") throw Error("Explicit presence coordinator dependencies required");
    if (source && (!source.pendingPresenceStatus().enabled || owners.has(source))) throw Error("One coordinator requires an exclusive durable presence source");
    Object.assign(this, { source, client, audience, clock, maxPending: positive(maxPending, 4096, "queue size"), batchSize: positive(batchSize, 128, "batch size"),
      maxQueuedBytes: positive(maxQueuedBytes, 64 * 1024 * 1024, "queue bytes"), maxOperationBytes: positive(maxOperationBytes, 4 * 1024 * 1024, "operation bytes") });
    this.queue = []; this.pending = 0; this.queuedBytes = 0; this.running = false; this.accepting = true; this.initialized = false;
    this.failure = null; this.qualifications = new Map(); this.idleWaiters = [];
    if (source) owners.set(source, this);
  }
  _enqueue(payload, fn) {
    if (!this.accepting) return Promise.reject(unavailable("Shadow storage coordinator is closing"));
    if (this.failure) return Promise.reject(unavailable("Shadow storage requires restart and ordered replay"));
    let encoded, bytes;
    try { encoded = JSON.stringify(payload); bytes = Buffer.byteLength(encoded); }
    catch (_) { return Promise.reject(Error("Serializable coordinator arguments required")); }
    if (bytes > this.maxOperationBytes || this.pending >= this.maxPending || this.queuedBytes + bytes > this.maxQueuedBytes)
      return Promise.reject(unavailable("Shadow storage admission queue is full. Retry shortly.", "SHADOW_STORAGE_BACKPRESSURE"));
    const copy = JSON.parse(encoded);
    this.pending++; this.queuedBytes += bytes;
    return new Promise((resolve, reject) => { this.queue.push({ copy, fn, bytes, resolve, reject }); this._run(); });
  }
  async _run() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const task = this.queue.shift();
      try {
        if (this.failure) throw unavailable("Shadow storage requires restart and ordered replay");
        task.resolve(await task.fn(task.copy));
      } catch (error) { task.reject(error); }
      finally { this.pending--; this.queuedBytes -= task.bytes; }
    }
    this.running = false;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
  _fail(error) { this.failure ||= error; this.initialized = false; this.qualifications.clear(); }
  async _call(method, args = []) {
    try {
      await this.client.ready;
      if (typeof this.client[method] !== "function") throw Error("Worker method unavailable: " + method);
      return await this.client[method](...args);
    } catch (error) {
      const health = typeof this.client.health === "function" ? this.client.health() : null;
      const unavailableCode = ["SHADOW_STORAGE_UNAVAILABLE", "SHADOW_WORKER_UNAVAILABLE"].includes(error.code);
      if (health?.state === "failed" || health?.failure || health?.available === false || error.code === "SHADOW_WRITE_UNCERTAIN" ||
          (unavailableCode && health?.available !== true)) this._fail(error);
      throw error;
    }
  }
  _requireReady() {
    if (!this.initialized || this.failure) throw unavailable("Shadow storage initialization and replay are required");
    const health = typeof this.client.health === "function" ? this.client.health() : null;
    if (health?.failure || health?.state === "failed" || health?.available === false) {
      const error = unavailable("Shadow storage worker is unavailable before admission"); this._fail(error); throw error;
    }
  }
  async _projection() {
    try {
      const rows = await this._call("qualificationProjection"), next = new Map();
      if (!Array.isArray(rows) || rows.length > 10000) throw Error("Bounded committed qualification projection required");
      for (const row of rows) {
        if (!row || typeof row.address !== "string" || !Number.isSafeInteger(row.expires) || row.expires < 0 || next.has(row.address)) throw Error("Invalid committed qualification projection");
        next.set(row.address, row.expires);
      }
      this.qualifications = next;
    } catch (error) { this._fail(error); throw error; }
  }
  async _drain() {
    if (!this.source) return;
    try {
      for (;;) {
        const events = this.source.pendingPresenceEvents(this.batchSize);
        if (!events.length) {
          if (this.source.pendingPresenceStatus().pending !== 0) throw Error("Provider presence barrier did not drain");
          return;
        }
        const outcomes = await this._call("ingestPresenceBatch", [events]);
        if (!Array.isArray(outcomes) || outcomes.length !== events.length || outcomes.some(value => typeof value?.applied !== "boolean" || (!value.applied && typeof value.reason !== "string")))
          throw Error("Durable provider presence consumer acknowledgment missing");
        // A lost worker response deliberately leaves this entire source batch
        // pending. The next process obtains the consumer's immutable receipts.
        this.source.ackPresenceEvents(events.map(({ eventId, digest }) => ({ eventId, digest })));
      }
    } catch (error) { this._fail(error); throw error; }
  }
  initialize({ sealedEpochs = [], retirement } = {}) {
    return this._enqueue({ sealedEpochs, retirement: retirement || null }, async options => {
      if (this.initialized) throw Error("Shadow coordinator is already initialized");
      try {
        if (!Array.isArray(options.sealedEpochs) || options.sealedEpochs.length > 10000) throw Error("Bounded startup sealed epochs required");
        await this._call("markSealedMany", [options.sealedEpochs]);
        if (options.retirement) await this._call("retireUnmatchedQualifications", [options.retirement.models, options.retirement.verified]);
        await this._projection(); await this._drain(); this.initialized = true;
        return this.storageStatus();
      } catch (error) { this._fail(error); throw error; }
    });
  }
  read(method, args = []) {
    if (!READS.has(method) || !Array.isArray(args)) return Promise.reject(Error("Read-only shadow method required"));
    return this._enqueue(args, values => this._call(READ_ALIASES[method] && typeof this.client[READ_ALIASES[method]] === "function" ? READ_ALIASES[method] : method, values));
  }
  mutate(method, args = []) {
    if (!MUTATIONS.has(method) || !Array.isArray(args)) return Promise.reject(Error("Ordered shadow mutation required"));
    return this._enqueue(args, async values => {
      this._requireReady(); await this._drain();
      const value = await this._call(method, values);
      if (QUALIFICATIONS.has(method)) await this._projection();
      return value;
    });
  }
  tick(options = {}) { return this.mutate("tick", [options]); }
  acceptDelegated(body) {
    return this._enqueue(body, async value => {
      this._requireReady(); if (!this.source) throw Error("Delegated provider presence is unavailable");
      await this._drain();
      // No await separates this synchronized eligibility decision from source
      // verification, server acceptedAt capture and its durable transaction.
      let accepted;
      try { accepted = this.source.observePresence(value.signature, value.address, value.report, {
        rewardQualified: acceptedAt => (this.qualifications.get(value.address) || 0) > acceptedAt }); }
      catch (error) {
        if (["PROVIDER_PRESENCE_WRITE_UNCERTAIN", "PROVIDER_PRESENCE_STORAGE_INVALID", "ERR_SQLITE_ERROR"].includes(error.code)) {
          Object.assign(error, { status: 503 }); this._fail(error);
        }
        throw error;
      }
      await this._drain(); await this._call("tick", [{ maxIntervals: 8 }]); return accepted;
    });
  }
  acceptLegacy(body) {
    return this._enqueue(body, async value => {
      this._requireReady(); await this._drain();
      const accepted = await this._call("acceptLegacyPresence", [value, { audience: this.audience }]);
      await this._call("tick", [{ maxIntervals: 8 }]); return accepted;
    });
  }
  storageStatus() {
    const worker = typeof this.client.health === "function" ? this.client.health() : null;
    return { ready: this.initialized && !this.failure && worker?.state !== "failed" && worker?.ready !== false,
      initialized: this.initialized, pending: this.pending, queuedBytes: this.queuedBytes, limit: this.maxPending,
      closing: !this.accepting, failure: this.failure ? String(this.failure.message).slice(0, 220) : null, worker };
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    this.closePromise = (async () => {
      try {
        if (this.running || this.queue.length) await new Promise(resolve => this.idleWaiters.push(resolve));
        if (this.initialized && !this.failure) await this._drain();
      } finally {
        this.initialized = false;
        try { await this.client.close(); }
        finally { if (this.source && owners.get(this.source) === this) owners.delete(this.source); }
      }
    })();
    return this.closePromise;
  }
}
module.exports = { PresenceCoordinator };
