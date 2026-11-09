"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
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

// A dispatch wheel, not an exclusive lease: an empty owner never holds a slot
// while awaiting another endpoint. With all classes queued, background gets
// one of every nine starts, and each other class gets four. Owners rotate at
// each class turn (at most four starts; one for background) when contending.
// Empty classes are skipped rather than wasting capacity. These are dispatch
// bounds, not wall-clock guarantees: two active sockets may still await their
// existing deadline and physical close before any queued request can start.
class RpcScheduler {
  constructor({ now = () => performance.now(), schedule = setTimeout } = {}) {
    this.now = now; this.schedule = schedule; this.pools = new Map();
  }
  stats(endpoint) {
    const pool = this.pools.get(endpoint);
    return { active: pool?.active || 0, queued: pool?.queued || 0,
      classes: Object.fromEntries(CLASSES.map(name => [name, { queued: pool?.lanes[name].queued || 0, owners: pool?.lanes[name].owners.length || 0 }])) };
  }
  slot(endpoint, signal, scope) {
    if (signal.aborted) return Promise.reject(stopped());
    let pool = this.pools.get(endpoint);
    if (!pool) {
      pool = { active: 0, queued: 0, nextStart: 0, timer: null, cursor: 0,
        lanes: Object.fromEntries(CLASSES.map(name => [name, { queued: 0, owners: [], byOwner: new Map() }])) };
      this.pools.set(endpoint, pool);
    }
    const lane = pool.lanes[scope.trafficClass], existing = lane.byOwner.get(scope.id);
    // Background leaves 32 foreground places; mixed interactive/background
    // traffic leaves at least 16 places for current availability observations.
    if (pool.queued >= MAX_QUEUED || (existing?.waiters.length || 0) >= OWNER_QUEUED ||
        (scope.trafficClass !== "availability" && pool.queued - pool.lanes.availability.queued >= NON_AVAILABILITY_QUEUED) ||
        (scope.trafficClass === "background" && lane.queued >= BACKGROUND_QUEUED)) return Promise.reject(full());
    return new Promise((resolve, reject) => {
      const group = existing || { id: scope.id, served: 0, waiters: [] };
      if (!existing) { lane.byOwner.set(scope.id, group); lane.owners.push(group); }
      const waiter = { signal, resolve, reject, cancel: null };
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
    if (waiter.signal.aborted) { waiter.reject(stopped()); this.pump(pool); return; }
    pool.active++; pool.nextStart = this.now() + START_INTERVAL_MS;
    let released = false;
    waiter.resolve(() => { if (!released) { released = true; pool.active--; this.pump(pool); } });
    this.pump(pool);
  }
}
const scheduler = new RpcScheduler();
module.exports = { readScope, requestOwner, RpcScheduler,
  endpointSlot: (endpoint, signal, scope) => scheduler.slot(endpoint, signal, scope),
  endpointStats: endpoint => scheduler.stats(endpoint), version: 1 };
