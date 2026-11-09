"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { options, admission, summary, workload, runCase, validateKnownCaps } = require("./bench-koin-reliability");

test("load cases retain offered cohorts and report both admission caps instead of seeding impossible state", () => {
  validateKnownCaps();
  assert.deepEqual(options([]).providers, [100, 500, 1000]);
  assert.equal(admission(100, 16).fullCohortAdmissible, true);
  assert.deepEqual(admission(500, 16).blockers, ["model_run_record_cap"]);
  const overloaded = admission(1000, 16);
  assert.equal(overloaded.qualificationsRequested, 16000);
  assert.equal(overloaded.admittedProviders, 256);
  assert.equal(overloaded.qualificationsLoaded, 4096);
  assert.deepEqual(overloaded.blockers, ["model_run_record_cap", "shadow_qualification_cap"]);
  assert.throws(() => options(["--providers=10000"]), /provider/);
  assert.throws(() => options(["--history-mib=999"]), /history/);
  assert.throws(() => options(["--duration-ms=999999"]), /duration/);
  assert.throws(() => options(["--endpoint=https://production.invalid"]), /documented/);
});

test("offered events use deterministic staggered cadences and count every queued caller before deadline", () => {
  const c = { ...options([]), providers: 1000, historyMiB: 0 }, events = workload(c);
  assert.deepEqual(events, workload(c));
  assert.equal(events.filter(e => e.kind === "poll").length, 1000);
  const presence = events.filter(e => e.kind === "presence");
  assert.ok(presence.length >= 195 && presence.length <= 205);
  assert.equal(events.filter(e => e.kind === "burst").length, 64);
  assert.ok(events.every(e => e.at >= 0 && e.at < c.durationMs));
  assert.equal(summary([]).p95Ms, null);
  assert.deepEqual(summary([1, 2, 3, 4]), { count: 4, p50Ms: 3, p95Ms: 4, maxMs: 4 });
});

test("local combined load cancels pending RPCs, reports measured state, and removes its private fixtures", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-reliability-"));
  const c = { ...options([]), providers: 4, models: 2, historyMiB: 0, durationMs: 300, heartbeatMs: 10000, pollMs: 1000, rpcDelayMs: 5, burst: 4, faultMs: 1000 };
  const r = await runCase(c, { directory });
  assert.equal(r.admission.admittedProviders, 4);
  assert.equal(r.fixture.distinctHistoricalObjects, true);
  assert.ok(r.fixture.serializedBytesInitial > 0);
  assert.ok(r.rpc.wireRequests > 0);
  assert.equal(r.rpc.wireActiveAfterAbort, 0);
  assert.ok(r.rpc.wireActiveMax <= 4, "two synthetic endpoints keep the real per-endpoint connection bounds");
  assert.ok(r.rpc.pendingLogicalMax >= r.rpc.pendingAtDeadline);
  assert.ok(r.memory.rssObservedMaxBytes >= r.memory.rssInitialBytes);
  assert.ok(r.eventLoop.maxMs >= 0);
  assert.equal(fs.existsSync(directory), false);
});
