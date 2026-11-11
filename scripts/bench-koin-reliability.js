"use strict";
// Synthetic, local-only load. Never instantiate TestRuntime or load service
// configuration/keys; every journal lives in a new temporary directory.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const { AsyncLocalStorage } = require("node:async_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { Signer } = require("koilib");
const { KoinShadow } = require("../lib/koin-network/shadow");
const { ProviderQualificationSet } = require("../lib/koin-network/provider-qualification-set");
const { ProviderQualification } = require("../lib/koin-network/provider-qualification");
const { Meter } = require("../lib/koin-network/metering");
const { PinnedRpcProvider, rpcDiagnostics } = require("../lib/koin-network/rpc-provider");
const P = require("../lib/koin-network/job-protocol"), Policy = require("../lib/koin-network/policy");
const CHAIN = require("../lib/koin-network/payment-network").MAINNET_CHAIN;
const ROOT = path.resolve(__dirname, ".."), LIMITS = Object.freeze({ qualifications: 10000, modelRunRecords: 256 });
let scheduler;
try { scheduler = require("../lib/koin-network/rpc-scheduler"); }
catch (error) { if (error.code !== "MODULE_NOT_FOUND" || !error.message.startsWith("Cannot find module '../lib/koin-network/rpc-scheduler'")) throw error; }

const defaults = Object.freeze({ providers: [100, 500, 1000], historyMiB: [0, 24], models: 16,
  durationMs: 5000, heartbeatMs: 25000, pollMs: 5000, rpcDelayMs: 25, burst: 64, faultMs: 1000 });
const finite = (n, min, max, label) => { if (!Number.isSafeInteger(n) || n < min || n > max) throw Error("Invalid " + label); return n; };
function options(args) {
  const result = { ...defaults };
  const names = { providers: "providers", "history-mib": "historyMiB", models: "models", "duration-ms": "durationMs",
    "heartbeat-ms": "heartbeatMs", "poll-ms": "pollMs", "rpc-delay-ms": "rpcDelayMs", burst: "burst", "fault-ms": "faultMs" };
  for (const arg of args) {
    const match = /^--([a-z-]+)=([0-9,]+)$/.exec(arg);
    if (!match || !names[match[1]]) throw Error("Use documented --name=value options");
    const key = names[match[1]];
    result[key] = ["providers", "historyMiB"].includes(key) ? match[2].split(",").map(Number) : Number(match[2]);
  }
  if (!result.providers.length || result.providers.length > 6 || !result.historyMiB.length || result.historyMiB.length > 4) throw Error("Bounded case lists required");
  result.providers.forEach(n => finite(n, 1, 1000, "provider count"));
  result.historyMiB.forEach(n => finite(n, 0, 128, "history MiB"));
  for (const [key, min, max] of [["models", 1, 16], ["durationMs", 100, 30000], ["heartbeatMs", 10000, 60000],
    ["pollMs", 1000, 30000], ["rpcDelayMs", 1, 500], ["burst", 0, 128], ["faultMs", 0, 10000]]) finite(result[key], min, max, key);
  return result;
}
function admission(providers, models) {
  const qualificationsRequested = providers * models;
  const admittedProviders = Math.min(providers, LIMITS.modelRunRecords, Math.floor(LIMITS.qualifications / models));
  return { offeredProviders: providers, admittedProviders, unqualifiedProviders: providers - admittedProviders,
    qualificationsRequested, qualificationsLoaded: admittedProviders * models, limits: LIMITS,
    fullCohortAdmissible: admittedProviders === providers,
    blockers: [...(providers > LIMITS.modelRunRecords ? ["model_run_record_cap"] : []),
      ...(qualificationsRequested > LIMITS.qualifications ? ["shadow_qualification_cap"] : [])] };
}
function validateKnownCaps() {
  // Exercise the boundary, not a particular source-code spelling. Only these
  // two admission checks stub persistence; the measured workload never does.
  const now = 30000 * Policy.DAY, address = Signer.fromSeed("local-benchmark-cap-probe").getAddress();
  let writes = 0;
  const q = { address, capacityId: "cap-probe", model: "cap-model", modelHash: "1".repeat(64), benchmarkHash: "2".repeat(64),
    modelWeight: "1", coverageBps: 10000, expires: now + Policy.DAY, approvedAt: now };
  const qualifications = Object.fromEntries(Array.from({ length: LIMITS.qualifications - 1 }, (_, i) => ["existing-" + i, { ...q, capacityId: "existing-" + i }]));
  const ledger = Object.assign(Object.create(KoinShadow.prototype), { state: { qualifications }, clock: () => now, save: () => { writes++; } });
  ledger.qualify(q);
  let rejected = false;
  try { ledger.qualify({ ...q, capacityId: "over-cap" }); }
  catch (error) { if (error.message !== "Qualification capacity reached") throw error; rejected = true; }
  if (!rejected || writes !== 1 || Object.keys(ledger.state.qualifications).length !== LIMITS.qualifications) throw Error("Shadow admission limit changed; update benchmark assumptions");
  const worker = { address, fingerprint: "a".repeat(16), proof: "signed", providerAuthorization: "b".repeat(64), providerDeviceId: "cap-device",
    models: [q.model], capabilities: { koinQualification: 1, koinModelOnDemand: 1 } };
  const engine = Object.assign(Object.create(ProviderQualification.prototype), { state: { clock: 0, records: {}, runs: Object.fromEntries(Array.from({ length: LIMITS.modelRunRecords - 1 }, (_, i) => ["run-" + i, {}])) },
    clock: () => now, reviewed: () => [], preparePresence: () => null, providerDevices: { workerActive: () => true }, save: () => {},
    target: { domain: "local-benchmark" }, targetHash: "3".repeat(64), policyHash: "4".repeat(64), modelCapacity: true,
    policy: { schema: 1, model: q.model, modelHash: q.modelHash, renewBeforeMs: 3600000, retryMs: 300000, cases: [{}] } });
  const last = engine.next(worker), over = engine.next({ ...worker, address: Signer.fromSeed("local-benchmark-over-cap").getAddress(), fingerprint: "c".repeat(16) });
  if (last?.type !== "koin-provider-prepare" || over !== null || Object.keys(engine.state.runs).length !== LIMITS.modelRunRecords) throw Error("Model admission limit changed; update benchmark assumptions");
}
function summary(values) {
  if (!values.length) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = values.slice().sort((a, b) => a - b), at = q => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(3));
  return { count: values.length, p50Ms: at(.5), p95Ms: at(.95), maxMs: at(1) };
}
function fileBytes(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? fileBytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
}
function workload(c) {
  const events = [], add = (kind, at, worker) => events.push({ kind, at, worker });
  for (let i = 0; i < c.providers; i++) {
    const phase = ((Math.imul(i + 1, 2654435761) >>> 0) / 4294967296);
    for (let at = phase * c.pollMs; at < c.durationMs; at += c.pollMs) add("poll", at, i);
    for (let at = phase * c.heartbeatMs; at < c.durationMs; at += c.heartbeatMs) add("presence", at, i);
  }
  for (let at = 0; at < c.durationMs; at += 1000) {
    add("availability", at); add("availability", at + 1);
    for (let i = 0; i < 4; i++) if (at + 10 + i < c.durationMs) add("background", at + 10 + i);
  }
  for (let i = 0; i < c.burst; i++) add("burst", 100, i);
  return events.filter(e => e.at < c.durationMs).sort((a, b) => a.at - b.at);
}
function fixture(c, dir, clock) {
  const plan = admission(c.providers, c.models), now = clock(), epoch = Math.floor(now / Policy.DAY);
  const names = Array.from({ length: c.models }, (_, i) => "bench-model-" + i), addresses = Array.from({ length: c.providers }, (_, i) => Signer.fromSeed("local-reliability-provider-" + i).getAddress());
  const tariffs = names.map(model => ({ model, version: 1, modelHash: P.hash(model), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 5000 }));
  const encode = value => [...Buffer.from(value)];
  const meter = new Meter(tariffs.map(tariff => ({ tariff, adapter: { ...tariff, render: JSON.stringify, encode, input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } })));
  const target = { chainId: CHAIN, credits: Signer.fromSeed("local-reliability-contract").getAddress(), creditsHash: "0x1220" + P.hash("fixture-code"), policyHash: meter.policyHash, domain: "shadow:mainnet-pilot-" + P.hash("fixture-service") };
  const policies = tariffs.map(t => ({ schema: 1, model: t.model, modelHash: t.modelHash, modelWeight: "10000", coverageBps: 10000,
    reviewedEvidenceHash: P.hash("review-" + t.model), maxLatencyMs: 5000, minPass: 1, renewBeforeMs: 3600000, retryMs: 300000,
    cases: [{ id: "fixture-answer", messages: [{ role: "user", content: "Reply OK." }], expected: ["OK"], maxOutput: 16 }] }));
  const workers = addresses.map((address, i) => ({ address, fingerprint: P.hash("device-" + i).slice(0, 16), proof: "signed", providerAuthorization: P.hash("authorization-" + i), providerDeviceId: "device-" + i,
    models: names, capabilities: { koinQualification: 1, koinModelOnDemand: 1, preferredModel: names[0] } }));
  const state = { schema: 1, mode: "shadow", qualifications: {}, presence: {}, observations: {}, budgets: {}, days: {} };
  const set = new ProviderQualificationSet({ file: path.join(dir, "qualification.json"), policies, target, meter, clock,
    providerDevices: { workerActive: () => true }, preparePresence: worker => state.presence[worker.address] });
  for (let i = 0; i < plan.admittedProviders; i++) {
    const worker = workers[i];
    for (const [model, engine] of set.engines) {
      const capacityId = "capacity-" + i + "-" + model;
      const q = { address: worker.address, providerAuthorization: worker.providerAuthorization, providerDeviceId: worker.providerDeviceId,
        capacityId, model, modelHash: engine.policy.modelHash, modelWeight: "10000", coverageBps: 10000, benchmarkHash: P.hash(capacityId), expires: now + Policy.DAY - 1 };
      engine.state.records[worker.providerAuthorization] = { policyHash: engine.policyHash, qualification: q, evidence: { target: structuredClone(engine.target), fingerprint: worker.fingerprint } };
      engine.state.runs[worker.address] = { address: worker.address, fingerprint: worker.fingerprint, providerAuthorization: worker.providerAuthorization,
        providerDeviceId: worker.providerDeviceId, state: "qualified", policyHash: engine.policyHash, targetHash: engine.targetHash, results: [], pending: null, retryAt: now - 1 };
      const { providerAuthorization, providerDeviceId, ...shadowQualification } = q;
      state.qualifications[capacityId] = { ...shadowQualification, approvedAt: now - 180000 };
    }
    const samples = Array.from({ length: 8 }, (_, j) => ({ session: P.hash("session-" + i).slice(0, 32), sequence: j, model: names[0], modelHash: tariffs[0].modelHash,
      ready: true, at: now - (8 - j) * c.heartbeatMs, signedAt: now - (8 - j) * c.heartbeatMs }));
    state.presence[worker.address] = { ...samples.at(-1), samples };
  }
  // Historical intervals have distinct decoded objects, as after a real restart.
  // The target is serialized archive bytes, not a claim about elapsed real days.
  const template = Object.values(state.qualifications).filter(q => q.model === names[0]).slice(0, 16).map(q => ({ ...q, verified: true, eligible: true, reliabilityBps: 10000 }));
  const templateText = JSON.stringify(template), intervalBytes = Buffer.byteLength(templateText) + 64;
  const historicalIntervals = Math.ceil(c.historyMiB * 1024 * 1024 / intervalBytes);
  for (let i = 0; i < historicalIntervals; i++) {
    const dayIndex = Math.floor(i / 1440), dayEpoch = epoch - 1 - dayIndex, start = dayEpoch * Policy.DAY + (i % 1440) * 60000;
    if (!state.days[dayEpoch]) { state.budgets[dayEpoch] = Policy.dailyBudget({ balance: "100000000000", liabilities: "0", openedAt: dayEpoch * Policy.DAY }); state.days[dayEpoch] = { intervals: [], work: [], sealed: true }; }
    state.days[dayEpoch].intervals.push({ start, end: start + 60000, slots: JSON.parse(templateText) });
  }
  const openedAt = Math.floor((now - 105001) / 60000) * 60000;
  state.budgets[epoch] = Policy.dailyBudget({ balance: "100000000000", liabilities: "0", openedAt });
  state.days[epoch] = { intervals: [], work: [] };
  if (Object.keys(state.qualifications).length > LIMITS.qualifications || [...set.engines.values()].some(e => Object.keys(e.state.runs).length > LIMITS.modelRunRecords)) throw Error("Fixture exceeds real admission limits");
  fs.writeFileSync(path.join(dir, "koin-shadow.json"), JSON.stringify(state), { mode: 0o600 });
  const ledger = new KoinShadow(dir, { clock });
  // Follow the live ledger after constructor reload or a persistence migration.
  set.preparePresence = worker => ledger.state.presence[worker.address];
  for (const engine of set.engines.values()) engine.preparePresence = set.preparePresence;
  return { ledger, set, workers, tariffs, plan, historicalIntervals };
}

async function runCase(c, { directory } = {}) {
  validateKnownCaps();
  const checked = options(Object.entries({ providers: c.providers, "history-mib": c.historyMiB, models: c.models, "duration-ms": c.durationMs,
    "heartbeat-ms": c.heartbeatMs, "poll-ms": c.pollMs, "rpc-delay-ms": c.rpcDelayMs, burst: c.burst, "fault-ms": c.faultMs }).map(([k,v]) => "--" + k + "=" + v));
  c = { ...checked, providers: checked.providers[0], historyMiB: checked.historyMiB[0] };
  if (directory && (path.dirname(directory) !== os.tmpdir() || !/^kai-reliability-[A-Za-z0-9]+$/.test(path.basename(directory)) ||
      !fs.lstatSync(directory).isDirectory() || fs.readdirSync(directory).length)) throw Error("A fresh benchmark-owned temporary directory is required");
  const dir = directory || fs.mkdtempSync(path.join(os.tmpdir(), "kai-reliability-")), cleanup = [], setupAt = performance.now();
  let origin, baseNow = 30000 * Policy.DAY + 3600000;
  const clock = () => baseNow + Math.floor(origin === undefined ? 0 : performance.now() - origin);
  let f;
  try {
    f = fixture(c, dir, clock);
    global.gc?.();
    const setupMs = performance.now() - setupAt, bytesInitial = fileBytes(dir), rssInitial = process.memoryUsage.rss();
    const stats = {}, contexts = new AsyncLocalStorage(), pending = new Set(), controllers = new Set(), errors = {}, firstWire = [], rpcLatency = [], wireLatency = [];
    const unique = "bench-" + process.pid + "-" + Math.random().toString(16).slice(2);
    const endpoints = ["https://" + unique + "-primary.invalid", "https://" + unique + "-backup.invalid"];
    let wireActive = 0, wireMax = 0, wireRequests = 0, faultsInjected = 0, pendingMax = 0, rssMax = rssInitial, settled = 0, failed = 0, cancelled = 0;
    const queueSamples = [], perClass = {};
    const fetchImpl = (endpoint, request) => {
      const payload = JSON.parse(request.body), context = contexts.getStore(), start = performance.now();
      if (!["chain.get_chain_id", "chain.get_head_info"].includes(payload.method)) throw Error("Benchmark forbids RPC mutation and unrelated methods");
      if (context && !context.started) { context.started = true; firstWire.push(start - context.offered); }
      wireRequests++; wireActive++; wireMax = Math.max(wireMax, wireActive);
      const phase = start - origin, fault = c.faultMs && endpoint === endpoints[0] && phase >= c.durationMs / 2 && phase < c.durationMs / 2 + c.faultMs;
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = error => {
          if (done) return; done = true; clearTimeout(timer); request.signal?.removeEventListener("abort", abort);
          wireActive--; wireLatency.push(performance.now() - start);
          if (error) { reject(error); return; }
          const result = payload.method === "chain.get_chain_id" ? { chain_id: CHAIN } : { head_topology: { id: "0x1220" + "1".repeat(64), height: "1" }, last_irreversible_block: "1", head_block_time: String(clock()) };
          resolve({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }) });
        };
        const abort = () => finish(Object.assign(Error("Synthetic cancellation"), { code: "ABORT_ERR" }));
        const timer = setTimeout(() => { if (fault) { faultsInjected++; finish(Object.assign(Error("Synthetic connection timeout"), { code: "ETIMEDOUT" })); } else finish(); }, c.rpcDelayMs);
        request.signal?.addEventListener("abort", abort, { once: true }); if (request.signal?.aborted) abort();
      });
    };
    const clients = Object.fromEntries(["availability", "background", "burst"].map(kind => [kind, new PinnedRpcProvider(endpoints, CHAIN, { fetchImpl })]));
    const startRpc = kind => {
      const controller = new AbortController(), offered = performance.now(); controllers.add(controller);
      const className = kind === "availability" ? "availability" : "background";
      const context = { offered, kind, started: false };
      let job;
      const run = () => clients[kind].withSignal(controller.signal, () => clients[kind].getHeadInfo());
      job = contexts.run(context, () => scheduler?.readScope ? scheduler.readScope(className, run) : run()).then(() => {
        settled++; (perClass[kind] ||= []).push(performance.now() - offered); rpcLatency.push(performance.now() - offered);
      }).catch(error => {
        if (controller.signal.aborted) cancelled++; else failed++;
        const key = controller.signal.aborted ? "benchmark_end_abort" : rpcDiagnostics(error).at(-1)?.kind || error.code || "unknown";
        errors[key] = (errors[key] || 0) + 1;
      }).finally(() => { controllers.delete(controller); pending.delete(job); });
      pending.add(job); pendingMax = Math.max(pendingMax, pending.size);
    };
    const hist = monitorEventLoopDelay({ resolution: 20 }); hist.enable(); cleanup.push(() => hist.disable());
    await delay(25); hist.reset(); origin = performance.now(); const utilizationStart = performance.eventLoopUtilization();
    const memoryTimer = setInterval(() => {
      rssMax = Math.max(rssMax, process.memoryUsage.rss());
      if (scheduler?.endpointStats && queueSamples.length < 512) queueSamples.push({ atMs: Math.round(performance.now() - origin), endpoints: endpoints.map(e => scheduler.endpointStats(e)) });
    }, 100); cleanup.push(() => clearInterval(memoryTimer));
    const events = workload(c), offeredByKind = {}, startedByKind = {};
    events.forEach(e => offeredByKind[e.kind] = (offeredByKind[e.kind] || 0) + 1);
    let index = 0;
    while (index < events.length && performance.now() - origin < c.durationMs) {
      const event = events[index], elapsed = performance.now() - origin;
      if (event.at > elapsed) { await delay(Math.min(10, event.at - elapsed)); continue; }
      index++; startedByKind[event.kind] = (startedByKind[event.kind] || 0) + 1;
      const bucket = stats[event.kind] ||= { duration: [], late: [], rejected: 0, deadlineMisses: 0, results: {}, admitted: [], unqualified: [] };
      const begin = performance.now(), lateness = begin - origin - event.at;
      if (["availability", "background", "burst"].includes(event.kind)) startRpc(event.kind);
      else {
        const worker = f.workers[event.worker];
        try {
          if (event.kind === "poll") {
            const job = f.set.next(worker), key = job?.type || "idle"; bucket.results[key] = (bucket.results[key] || 0) + 1;
          } else {
            const old = f.ledger.state.presence[worker.address], at = clock();
            f.ledger.observe(worker.address, { schema: 1, session: P.hash("session-" + event.worker).slice(0, 32), sequence: (old?.sequence ?? 7) + 1,
              at, model: f.tariffs[0].model, modelHash: f.tariffs[0].modelHash, ready: true });
            f.ledger.tick();
          }
        } catch (error) { bucket.rejected++; const key = String(error.message).slice(0, 100); bucket.results[key] = (bucket.results[key] || 0) + 1; }
      }
      const elapsedMs = performance.now() - begin; bucket.duration.push(elapsedMs); bucket.late.push(lateness);
      if (["poll", "presence"].includes(event.kind)) bucket[event.worker < f.plan.admittedProviders ? "admitted" : "unqualified"].push(elapsedMs);
      if (lateness + elapsedMs > 4000) bucket.deadlineMisses++;
      rssMax = Math.max(rssMax, process.memoryUsage.rss());
      await new Promise(resolve => setImmediate(resolve));
    }
    const activeDurationMs = performance.now() - origin, pendingAtDeadline = pending.size;
    controllers.forEach(controller => controller.abort()); await Promise.allSettled([...pending]); await delay(25);
    const utilization = performance.eventLoopUtilization(utilizationStart);
    const afterQueues = scheduler?.endpointStats ? endpoints.map(e => scheduler.endpointStats(e)) : null;
    const result = {
      type: "case", config: c, admission: f.plan, setupMs: +setupMs.toFixed(3), activeDurationMs: +activeDurationMs.toFixed(3),
      fixture: { historicalIntervals: f.historicalIntervals, serializedBytesInitial: bytesInitial, serializedBytesFinal: fileBytes(dir), distinctHistoricalObjects: true },
      events: { offered: offeredByKind, started: startedByKind, notStartedByDeadline: events.length - index },
      operations: Object.fromEntries(Object.entries(stats).map(([kind, s]) => [kind, { duration: summary(s.duration), schedulingLateness: summary(s.late), rejected: s.rejected, overFourSecondDeadline: s.deadlineMisses, results: s.results,
        byAdmission: { admitted: summary(s.admitted), unqualified: summary(s.unqualified) } }])),
      eventLoop: { maxMs: +(hist.max / 1e6).toFixed(3), p99Ms: +(hist.percentile(99) / 1e6).toFixed(3), utilization: +utilization.utilization.toFixed(5) },
      memory: { rssInitialBytes: rssInitial, rssObservedMaxBytes: rssMax, processMaxRssKiBIncludingSetup: process.resourceUsage().maxRSS },
      rpc: { localFakeTransport: true, faultsInjected, wireRequests, wireActiveMax: wireMax, wireActiveAfterAbort: wireActive,
        pendingLogicalMax: pendingMax, pendingAtDeadline, settled, failed, cancelled, errors, latency: summary(rpcLatency), firstDispatchWait: summary(firstWire), wireLatency: summary(wireLatency),
        latencyByCaller: Object.fromEntries(Object.entries(perClass).map(([kind, rows]) => [kind, summary(rows)])), queueMetricsAvailable: !!scheduler?.endpointStats, queueSamples, afterQueues },
      resourceUsage: process.resourceUsage(),
    };
    return result;
  } finally {
    cleanup.reverse().forEach(fn => fn()); f?.ledger.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function platform() {
  let commit = null; try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
  const cgroup = file => { try { return fs.readFileSync("/sys/fs/cgroup/" + file, "utf8").trim().slice(0, 128); } catch { return null; } };
  return { type: "environment", benchmarkVersion: 1, at: new Date().toISOString(), sourceCommit: commit, node: process.versions.node,
    platform: process.platform, release: os.release(), architecture: process.arch, cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
    availableParallelism: os.availableParallelism?.(), hostMemoryBytes: os.totalmem(), cgroupCpuMax: cgroup("cpu.max"), cgroupMemoryMax: cgroup("memory.max"), temporaryDirectory: os.tmpdir(), temporaryFilesystemType: fs.statfsSync(os.tmpdir()).type,
    caveats: ["Synthetic in-process application hotpaths, not an HTTP or production capacity guarantee", "No real RPC network, cryptographic presence verification, inference, signing or transactions", "Qualification records are preverified synthetic fixtures with identity bindings but no full signed response archives; their memory is a lower bound", "Admission limits remain enforced; offered cohorts may contain unqualified providers", "5s poll and25s presence are explicit configurable load assumptions", "Historical objects are distinct; fixture generation and reload are excluded from active latency but included in process maxRSS", "Cases stop at a wall-time deadline; unstarted events and aborts report overload rather than being silently dropped", "Filesystem timings describe this temporary filesystem and cannot be extrapolated to a VPS disk"] };
}
async function child(c) {
  return new Promise(resolve => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-reliability-"));
    const processChild = spawn(process.execPath, ["--expose-gc", __filename, "--case", JSON.stringify(c)], { cwd: ROOT,
      env: { ...process.env, KAI_RELIABILITY_TEMP_DIRECTORY: directory }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    const timer = setTimeout(() => { killed = true; processChild.kill("SIGKILL"); }, Math.max(30000, c.durationMs + 20000));
    processChild.stdout.on("data", value => { if (out.length < 2 * 1024 * 1024) out += value; });
    processChild.stderr.on("data", value => { if (err.length < 4096) err += value; });
    processChild.on("error", error => { clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true }); resolve({ type: "case_failure", config: c, error: error.message }); });
    processChild.on("close", code => {
      clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true });
      try { if (code === 0) { resolve(JSON.parse(out)); return; } } catch {}
      resolve({ type: "case_failure", config: c, exitCode: code, killedAtBound: killed, stderr: err.trim() });
    });
  });
}
async function main(args = process.argv.slice(2)) {
  if (args[0] === "--case") { console.log(JSON.stringify(await runCase(JSON.parse(args[1]), { directory: process.env.KAI_RELIABILITY_TEMP_DIRECTORY }))); return; }
  const config = options(args); console.log(JSON.stringify(platform()));
  for (const providers of config.providers) for (const historyMiB of config.historyMiB) console.log(JSON.stringify(await child({ ...config, providers, historyMiB })));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { options, admission, summary, workload, runCase, validateKnownCaps };
