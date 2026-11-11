"use strict";
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const { getHeapStatistics } = require("node:v8");
const WINDOW_MS = 60000, RESOLUTION_MS = 20;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const milliseconds = value => number(value) === null ? null : Math.round(value * 1000) / 1000;
function windowFields(value) {
  if (!value || typeof value !== "object") return null;
  return { durationMs: milliseconds(value.durationMs), samples: integer(value.samples),
    maxMs: milliseconds(value.maxMs), p99Ms: milliseconds(value.p99Ms),
    utilization: number(value.utilization) !== null && value.utilization <= 1 ? value.utilization : null };
}
function sanitizeEventLoopSnapshot(value) {
  return { available: value?.available === true, resolutionMs: RESOLUTION_MS, windowMs: WINDOW_MS,
    current: windowFields(value?.current), previous: windowFields(value?.previous) };
}
function sanitizeProcessTelemetry(value) {
  const memory = value?.memory;
  return { version: 1, pid: integer(value?.pid), memory: {
    rssBytes: integer(memory?.rssBytes), heapUsedBytes: integer(memory?.heapUsedBytes), heapTotalBytes: integer(memory?.heapTotalBytes),
    heapLimitBytes: integer(memory?.heapLimitBytes), externalBytes: integer(memory?.externalBytes),
  }, eventLoop: sanitizeEventLoopSnapshot(value?.eventLoop), qualificationModelCount: integer(value?.qualificationModelCount) };
}

// One process-wide monitor, with no per-request timers or history lists. These
// are explicitly current/previous tumbling windows, not a rolling percentile.
// A delayed rotation reports its actual duration rather than claiming 60 s.
class RuntimeMetrics {
  constructor({ histogram = options => monitorEventLoopDelay(options), now = () => performance.now(),
    utilization = previous => performance.eventLoopUtilization(previous),
    every = setInterval, cancel = clearInterval, rss = () => process.memoryUsage.rss(),
    heap = getHeapStatistics, pid = process.pid } = {}) {
    Object.assign(this, { histogram, now, utilization, every, cancel, rss, heap, pid });
    this.leases = 0; this.monitor = null; this.timer = null; this.previous = null;
  }
  acquire() {
    if (++this.leases === 1) {
      try {
        this.monitor = this.histogram({ resolution: RESOLUTION_MS });
        this.monitor.enable(); this.startedAt = this.now(); this.baseline = this.utilization(); this.previous = null;
        this.timer = this.every(() => this.rotate(), WINDOW_MS); this.timer?.unref?.();
      } catch { this.disposeMonitor(); }
    }
    let released = false;
    return () => { if (!released) { released = true; if (--this.leases === 0) this.disposeMonitor(); } };
  }
  disposeMonitor() {
    if (this.timer !== null) { try { this.cancel(this.timer); } catch {} }
    try { this.monitor?.disable(); } catch {}
    this.timer = null; this.monitor = null; this.previous = null; this.baseline = null;
  }
  captureWindow() {
    const samples = integer(this.monitor.count) || 0;
    return windowFields({ durationMs: Math.max(0, this.now() - this.startedAt), samples,
      maxMs: samples ? this.monitor.max / 1e6 : null,
      p99Ms: samples ? this.monitor.percentile(99) / 1e6 : null,
      utilization: this.utilization(this.baseline).utilization });
  }
  rotate() {
    if (!this.monitor) return;
    try {
      const completed = this.captureWindow();
      this.monitor.reset(); this.startedAt = this.now(); this.baseline = this.utilization(); this.previous = completed;
    } catch { this.disposeMonitor(); }
  }
  eventLoopSnapshot() {
    try {
      return sanitizeEventLoopSnapshot({ available: !!this.monitor,
        current: this.monitor ? this.captureWindow() : null, previous: this.previous });
    } catch { return sanitizeEventLoopSnapshot(null); }
  }
  snapshot() {
    let rss = null, heap = {};
    try { rss = this.rss(); } catch {}
    try { heap = this.heap() || {}; } catch {}
    return { version: 1, pid: integer(this.pid), memory: {
      rssBytes: integer(rss), heapUsedBytes: integer(heap.used_heap_size), heapTotalBytes: integer(heap.total_heap_size),
      heapLimitBytes: integer(heap.heap_size_limit), externalBytes: integer(heap.external_memory),
    }, eventLoop: this.eventLoopSnapshot() };
  }
}
const runtimeMetrics = new RuntimeMetrics();
const eventLoopSnapshot = () => runtimeMetrics.eventLoopSnapshot();

// Runner output can include signed envelopes and operation arguments. Retain
// only these bounded diagnostic tokens, never the original result objects.
const token = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
function rewardCycleObservation(value, observedAt, openCurrentDay) {
  if (integer(observedAt) === null || typeof openCurrentDay !== "boolean") return null;
  return { observedAt, openCurrentDay, results: (Array.isArray(value?.results) ? value.results : []).slice(0, 16).map(row => ({
    epoch: typeof row?.epoch === "string" && /^\d{1,12}$/.test(row.epoch) ? row.epoch : null,
    method: token(row?.method), action: token(row?.action), reason: token(row?.reason), state: token(row?.state),
  })) };
}
module.exports = { RuntimeMetrics, runtimeMetrics, eventLoopSnapshot, sanitizeEventLoopSnapshot, sanitizeProcessTelemetry, rewardCycleObservation, WINDOW_MS, RESOLUTION_MS };
