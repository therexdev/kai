"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
const { backoffMs, MAX_RETRY_AFTER_MS } = require("./rpc-backoff");
const CLASSES = ["availability", "interactive", "background"];
const WHEEL = ["availability", "availability", "availability", "availability",
  "interactive", "interactive", "interactive", "interactive", "background"];
const MAX_ACTIVE = 2, MAX_QUEUED = 128, OWNER_QUEUED = 16, BACKGROUND_QUEUED = 96, NON_AVAILABILITY_QUEUED = 112, START_INTERVAL_MS = 50;
const contexts = new AsyncLocalStorage();
const owner = trafficClass => Object.freeze({ id: Symbol("rpc-read-owner"), trafficClass });

// Internal callers choose a class; external request data never supplies it.
// Nested groups retain the outer owner and cannot promote their priority.
function readScope(trafficClass, callback) {
  if (!CLASSES.includes(trafficClass) || typeof callback !== "function") throw Error("Invalid RPC read scope");
  return contexts.run(contexts.getStore() || owner(trafficClass), callback);
}
function requestOwner(readOnly) {
  const scope = contexts.getStore();
  if (scope && !readOnly) throw Object.assign(Error("RPC writes are not permitted in a read-only group"), { code: "koin_rpc_read_scope" });
  return scope || owner("interactive");
}
const stopped = () => Object.assign(Error("RPC queue request stopped"), { code: "rpc_queue_stopped" });
const full = () => Object.assign(Error("RPC read queue is full"), { code: "rpc_queue_full" });
const cooling = (pool, now) => Object.assign(Error("RPC endpoint is cooling down"), {
  code: "rpc_endpoint_cooldown", cooldownRemainingMs: Math.max(0, Math.ceil(pool.until - now)),
});

// A dispatch wheel, not an exclusive lease: an empty owner never holds a slot
// while awaiting another endpoint. With all classes queued, background gets
// one of every nine starts, and each other class gets four. Owners rotate at
// each class turn (at most four starts; one for background) when contending.
// Empty classes are skipped rather than wasting capacity. These are dispatch
// bounds, not wall-clock guarantees: two active sockets may still await their
// existing deadline and physical close before any queued request can start.
class RpcScheduler {
  constructor({ now = () => performance.now(), schedule = setTimeout, random = Math.random } = {}) {
    this.now = now; this.schedule = schedule; this.random = random; this.pools = new Map(); this.attempts = new WeakMap();
  }
  stats(endpoint) {
    const pool = this.pools.get(endpoint);
    return { active: pool?.active || 0, queued: pool?.queued || 0,
      cooldownRemainingMs: pool ? Math.max(0, Math.ceil(pool.until - this.now())) : 0,
      recovering: !!pool?.probe,
      classes: Object.fromEntries(CLASSES.map(name => [name, { queued: pool?.lanes[name].queued || 0, owners: pool?.lanes[name].owners.length || 0 }])) };
  }
  pool(endpoint) {
    let pool = this.pools.get(endpoint);
    if (!pool) {
      pool = { active: 0, queued: 0, nextStart: 0, timer: null, cursor: 0,
        generation: 0, failures: 0, until: 0, probe: null, incidentGeneration: null,
        lanes: Object.fromEntries(CLASSES.map(name => [name, { queued: 0, owners: [], byOwner: new Map() }])) };
      this.pools.set(endpoint, pool);
    }
    return pool;
  }
  attempt(endpoint) {
    const pool = this.pool(endpoint);
    // A shared cooldown rejects new reads immediately so they can try their
    // pinned backup. A recovery lease spans chain pinning AND the operation;
    // a successful chain-id probe alone cannot establish operation recovery.
    if (pool.until > this.now() || pool.probe) throw cooling(pool, this.now());
    const state = { pool, generation: pool.generation, probe: pool.failures ? Symbol("rpc-recovery-probe") : null, closed: false };
    if (state.probe) pool.probe = state.probe;
    const lease = Object.freeze({
      throttle: retryAfterMs => { if (!state.closed) this.throttle(pool, state.generation, retryAfterMs); },
      success: () => {
        if (state.closed || !state.probe || pool.probe !== state.probe || state.generation !== pool.generation) return;
        pool.generation++; pool.failures = 0; pool.until = 0; pool.probe = null; pool.incidentGeneration = null;
      },
      close: () => {
        if (state.closed) return; state.closed = true;
        // Called only after the request task settles and its HTTP slot closes.
        // Cancellation never frees a recovery probe while its socket is alive.
        if (state.probe && pool.probe === state.probe && state.generation === pool.generation)
          this.throttle(pool, state.generation, null);
      },
    });
    this.attempts.set(lease, state); return lease;
  }
  valid(pool, lease) {
    if (!lease) return !pool.failures;
    const state = this.attempts.get(lease);
    return !!state && !state.closed && state.pool === pool && state.generation === pool.generation &&
      (!pool.probe || pool.probe === state.probe) && pool.until <= this.now();
  }
  slot(endpoint, signal, scope, lease) {
    if (signal.aborted) return Promise.reject(stopped());
    const pool = this.pool(endpoint);
    if (!this.valid(pool, lease)) return Promise.reject(cooling(pool, this.now()));
    const lane = pool.lanes[scope.trafficClass], existing = lane.byOwner.get(scope.id);
    // Background leaves 32 foreground places; mixed interactive/background
    // traffic leaves at least 16 places for current availability observations.
    if (pool.queued >= MAX_QUEUED || (existing?.waiters.length || 0) >= OWNER_QUEUED ||
        (scope.trafficClass !== "availability" && pool.queued - pool.lanes.availability.queued >= NON_AVAILABILITY_QUEUED) ||
        (scope.trafficClass === "background" && lane.queued >= BACKGROUND_QUEUED)) return Promise.reject(full());
    return new Promise((resolve, reject) => {
      const group = existing || { id: scope.id, served: 0, waiters: [] };
      if (!existing) { lane.byOwner.set(scope.id, group); lane.owners.push(group); }
      const waiter = { signal, resolve, reject, cancel: null, lease };
      waiter.cancel = () => {
        const index = group.waiters.indexOf(waiter);
        if (index < 0) return;
        group.waiters.splice(index, 1); lane.queued--; pool.queued--;
        if (!group.waiters.length) this.removeOwner(lane, group);
        reject(stopped()); this.pump(pool);
      };
      signal.addEventListener("abort", waiter.cancel, { once: true });
      group.waiters.push(waiter); lane.queued++; pool.queued++;
      this.pump(pool);
    });
  }
  removeOwner(lane, group) {
    lane.byOwner.delete(group.id);
    const index = lane.owners.indexOf(group); if (index >= 0) lane.owners.splice(index, 1);
  }
  rejectQueued(pool) {
    for (const lane of Object.values(pool.lanes)) {
      for (const group of lane.owners) for (const waiter of group.waiters) {
        waiter.signal.removeEventListener("abort", waiter.cancel);
        waiter.reject(cooling(pool, this.now()));
      }
      lane.queued = 0; lane.owners = []; lane.byOwner.clear();
    }
    pool.queued = 0;
  }
  throttle(pool, generation, retryAfterMs) {
    const requested = Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= MAX_RETRY_AFTER_MS ? retryAfterMs : 0;
    if (generation !== pool.generation) {
      // Concurrent errors belong to one incident: don't double its exponent,
      // but honor a later response asking for a longer quiet period. Results
      // preceding a completed recovery cannot affect a subsequent incident.
      if (pool.failures && generation >= pool.incidentGeneration && requested > 0 && this.now() + requested > pool.until) {
        pool.generation++; pool.probe = null; pool.until = this.now() + requested; this.rejectQueued(pool);
      }
      return;
    }
    if (!pool.failures) pool.incidentGeneration = generation;
    pool.generation++; pool.failures = Math.min(32, pool.failures + 1); pool.probe = null;
    pool.until = this.now() + Math.max(requested, backoffMs(pool.failures, this.random));
    this.rejectQueued(pool);
  }
  next(pool) {
    for (let i = 0; i < WHEEL.length; i++) {
      const name = WHEEL[pool.cursor]; pool.cursor = (pool.cursor + 1) % WHEEL.length;
      const lane = pool.lanes[name], group = lane.owners[0];
      if (!group) continue;
      const waiter = group.waiters.shift(); lane.queued--; pool.queued--;
      if (!group.waiters.length) this.removeOwner(lane, group);
      else if (++group.served >= (name === "background" ? 1 : 4)) {
        lane.owners.push(lane.owners.shift()); group.served = 0;
      }
      return waiter;
    }
  }
  pump(pool) {
    if (pool.timer || pool.active >= MAX_ACTIVE || !pool.queued) return;
    const delay = pool.nextStart - this.now();
    if (delay > 0) { pool.timer = this.schedule(() => { pool.timer = null; this.pump(pool); }, delay); return; }
    const waiter = this.next(pool);
    waiter.signal.removeEventListener("abort", waiter.cancel);
    if (waiter.signal.aborted || !this.valid(pool, waiter.lease)) {
      waiter.reject(waiter.signal.aborted ? stopped() : cooling(pool, this.now())); this.pump(pool); return;
    }
    pool.active++; pool.nextStart = this.now() + START_INTERVAL_MS;
    let released = false;
    waiter.resolve(() => { if (!released) { released = true; pool.active--; this.pump(pool); } });
    this.pump(pool);
  }
}
const scheduler = new RpcScheduler();
module.exports = { readScope, requestOwner, RpcScheduler,
  endpointAttempt: endpoint => scheduler.attempt(endpoint),
  endpointSlot: (endpoint, signal, scope, lease) => scheduler.slot(endpoint, signal, scope, lease),
  endpointStats: endpoint => scheduler.stats(endpoint), version: 1 };
