"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { RuntimeMetrics, sanitizeEventLoopSnapshot, sanitizeProcessTelemetry, rewardCycleObservation, WINDOW_MS } = require("../lib/koin-network/runtime-metrics");
const { TestRuntime } = require("../lib/koin-network/test-runtime");
function fixture() {
  const f = { now: 1000, utilization: 0.25, created: 0, enabled: 0, disabled: 0, unref: 0, cancelled: 0, resets: 0, timers: new Set() };
  f.metrics = new RuntimeMetrics({ now: () => f.now, utilization: () => ({ utilization: f.utilization }), pid: 123,
    histogram: options => {
      assert.deepEqual(options, { resolution: 20 }); f.created++;
      return f.histogram = { count: 0, max: 0, p99: 511,
        enable: () => f.enabled++, disable: () => f.disabled++, percentile: n => { assert.equal(n, 99); return f.histogram.p99; },
        reset: () => { f.resets++; f.histogram.count = 0; f.histogram.max = 0; f.histogram.p99 = 511; } };
    }, every: (fn, ms) => { assert.equal(ms, WINDOW_MS); const timer = { fn, unref: () => f.unref++ }; f.timers.add(timer); return timer; },
    cancel: timer => { f.cancelled++; f.timers.delete(timer); },
    rss: () => 1000, heap: () => ({ used_heap_size: 200, total_heap_size: 300, heap_size_limit: 4000, external_memory: 40, private: "do not copy" }),
  });
  return f;
}
test("one shared monitor starts lazily, is unref'ed and stops only after every runtime releases it", () => {
  const f = fixture(); assert.equal(f.created, 0); assert.equal(f.metrics.eventLoopSnapshot().available, false);
  const first = f.metrics.acquire(), second = f.metrics.acquire();
  assert.equal(f.created, 1); assert.equal(f.enabled, 1); assert.equal(f.unref, 1); assert.equal(f.timers.size, 1);
  first(); first(); assert.equal(f.disabled, 0); assert.equal(f.metrics.eventLoopSnapshot().available, true);
  second(); assert.equal(f.disabled, 1); assert.equal(f.cancelled, 1); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.metrics.eventLoopSnapshot(), { available: false, resolutionMs: 20, windowMs: 60000, current: null, previous: null });
  const third = f.metrics.acquire(); assert.equal(f.created, 2); assert.equal(f.metrics.eventLoopSnapshot().previous, null);
  third(); assert.equal(f.disabled, 2); assert.equal(f.timers.size, 0);
});
test("window rotation retains stalls, reports delayed timer duration and never fabricates a percentile before sampling", () => {
  const f = fixture(), release = f.metrics.acquire();
  const empty = f.metrics.eventLoopSnapshot();
  assert.equal(empty.current.samples, 0); assert.equal(empty.current.maxMs, null); assert.equal(empty.current.p99Ms, null);
  f.histogram.count = 30; f.histogram.max = 500000000; f.histogram.p99 = 250000000; f.now += 60000;
  const before = f.metrics.eventLoopSnapshot(); assert.equal(before.current.maxMs, 500); assert.equal(before.current.p99Ms, 250);
  assert.equal(before.current.utilization, 0.25); assert.equal(f.resets, 0, "reading diagnostics must not reset a window");
  [...f.timers][0].fn();
  const next = f.metrics.eventLoopSnapshot(); assert.deepEqual(next.previous, before.current);
  assert.equal(next.current.samples, 0); assert.equal(next.current.durationMs, 0);
  next.previous.maxMs = 0; assert.equal(f.metrics.eventLoopSnapshot().previous.maxMs, 500);
  f.now += 110000; f.histogram.count = 2; f.histogram.max = f.histogram.p99 = 90000000000;
  [...f.timers][0].fn();
  assert.equal(f.metrics.eventLoopSnapshot().previous.durationMs, 110000);
  assert.equal(f.metrics.eventLoopSnapshot().previous.maxMs, 90000);
  assert.equal(f.metrics.eventLoopSnapshot().current.samples, 0); release();
});
test("memory uses fast cached runtime statistics and diagnostic failures never escape into reward processing", () => {
  const f = fixture();
  assert.deepEqual(f.metrics.snapshot().memory, { rssBytes: 1000, heapUsedBytes: 200, heapTotalBytes: 300, heapLimitBytes: 4000, externalBytes: 40 });
  f.metrics.rss = f.metrics.heap = () => { throw Error("metric unavailable"); };
  assert.ok(Object.values(f.metrics.snapshot().memory).every(v => v === null));
  let disabled = 0;
  const failed = new RuntimeMetrics({ histogram: () => ({ enable() { throw Error("unavailable"); }, disable() { disabled++; } }),
    every: () => { throw Error("must not create a timer"); } });
  const release = failed.acquire(); assert.equal(failed.eventLoopSnapshot().available, false); release(); assert.equal(disabled, 1);
  const started = fixture(), stop = started.metrics.acquire(); started.metrics.utilization = () => { throw Error("unavailable"); };
  assert.equal(started.metrics.eventLoopSnapshot().available, false);
  [...started.timers][0].fn(); assert.equal(started.timers.size, 0); assert.equal(started.disabled, 1); stop();
});
test("diagnostic projections bound their shapes and exclude invalid numbers, signed envelopes and arbitrary fields", () => {
  const loop = sanitizeEventLoopSnapshot({ available: true, current: { durationMs: Infinity, samples: -1, maxMs: NaN, p99Ms: -10, utilization: 2, transaction: "private" }, secret: "private" });
  assert.deepEqual(loop.current, { durationMs: null, samples: null, maxMs: null, p99Ms: null, utilization: null });
  const process = sanitizeProcessTelemetry({ pid: 123, memory: { rssBytes: 200, private: "private" }, eventLoop: loop, qualificationModelCount: 3, secret: "private" });
  assert.equal(process.pid, 123); assert.equal(process.qualificationModelCount, 3); assert.doesNotMatch(JSON.stringify(process), /private|transaction/);
  const result = { results: Array.from({ length: 30 }, () => ({ epoch: "20767", action: "wait", reason: "root_under_review", method: "finalize_day", state: "queued",
    transaction: { signatures: ["private"] }, outbox: "private", operation: "private" })), handedOff: ["private"] };
  const observed = rewardCycleObservation(result, 2000, true);
  assert.equal(observed.results.length, 16); assert.equal(observed.results[0].reason, "root_under_review");
  assert.doesNotMatch(JSON.stringify(observed), /private|outbox|transaction|operation|handedOff/);
  result.results[0].reason = "changed"; assert.equal(observed.results[0].reason, "root_under_review");
  assert.equal(rewardCycleObservation(null, undefined, false), null);
});
function runtime(metrics) {
  const closed = [], service = name => ({ close() { closed.push(name); } });
  const r = Object.assign(Object.create(TestRuntime.prototype), { processMetrics: metrics, prices: {}, busy: false,
    tick: async () => { assert.equal(metrics.eventLoopSnapshot().available, true); },
    availabilityTick: async () => { assert.equal(metrics.eventLoopSnapshot().available, true); },
    scheduler: service("scheduler"), claims: service("claims"), cycle: service("cycle"), signing: service("signing"), hosts: service("hosts") });
  return { r, closed };
}
test("runtime starts monitoring before its first pass and releases it when journals close", async () => {
  const f = fixture(), { r, closed } = runtime(f.metrics);
  try { await r.start(); assert.equal(f.enabled, 1); await r.close(); }
  finally { r.stopScheduling(); r.releaseProcessMetrics?.(); }
  assert.equal(f.disabled, 1); assert.equal(f.timers.size, 0); assert.deepEqual(closed, ["scheduler", "claims", "cycle", "signing", "hosts"]);
});
test("unfinished financial and availability passes retain telemetry and keep journals open until they drain", async () => {
  for (const flag of ["busy", "availabilityBusy"]) {
    const f = fixture(), { r, closed } = runtime(f.metrics);
    try {
      await r.start(); r[flag] = true;
      await assert.rejects(r.close(), /active settlement and availability passes/);
      assert.deepEqual(closed, []); assert.equal(f.disabled, 0);
      r[flag] = false; await r.close();
      assert.equal(f.timers.size, 0); assert.equal(f.disabled, 1);
      assert.deepEqual(closed, ["scheduler", "claims", "cycle", "signing", "hosts"]);
    } finally { r.stopScheduling(); r.releaseProcessMetrics?.(); }
  }
});
