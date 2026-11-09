"use strict";
// Standalone read-only preflight. Do not import the runtime, key loader, signer,
// journal constructors, migration code, or the reward-opening diagnostic.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const crypto = require("node:crypto"), http = require("node:http"), https = require("node:https");
const { execFile } = require("node:child_process");
const STATE_DIR = "/var/lib/kai-koin-prepaid", CONFIG_FILE = "/etc/kai-koin-prepaid/runtime.json";
const LEGACY = "scheduler/koin-shadow/koin-shadow.json";
const FILES = [LEGACY, ...["cycle", "claims"].flatMap(name => ["", "-wal", "-shm"].map(suffix => `${name}/reward-${name}.sqlite${suffix}`))];
const STATES = new Set(["queued", "signing", "staged", "unknown", "pending", "reversible", "needs_review", "complete", "observed_external", "paid", "paid_elsewhere"]);
const METHODS = new Set(["open_epoch", "propose_root", "finalize_root"]);
const REASONS = new Set(["stopping", "awaiting_funded_epoch", "availability_processing_stale", "availability_processing_error", "earning_intervals_stale"]);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const epoch = value => typeof value === "string" && /^\d{1,12}$/.test(value) ? value : null;
const state = value => STATES.has(value) ? value : "unrecognized";
const txId = value => typeof value === "string" && /^0x1220[a-f0-9]{64}$/.test(value) ? value : null;
const failure = error => error?.code === "ENOENT" ? "not_found" : error?.code === "EACCES" ? "not_readable" : "read_failed";
function smallRead(file, maxBytes = 65536) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Error("Not a regular file");
    const buffer = Buffer.alloc(maxBytes + 1), count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > maxBytes) throw Error("Read limit");
    return buffer.subarray(0, count).toString("utf8");
  } finally { fs.closeSync(fd); }
}
function pressure(value) {
  const row = name => {
    const line = value.split("\n").find(item => item.startsWith(name + " ")); if (!line) return null;
    const fields = Object.fromEntries(line.split(/\s+/).slice(1).map(item => item.split("=")));
    if (!["avg10", "avg60", "avg300"].every(key => /^\d+(\.\d+)?$/.test(fields[key])) || !/^\d+$/.test(fields.total)) return null;
    const averages = ["avg10", "avg60", "avg300"].map(key => Number(fields[key])), total = integer(Number(fields.total));
    if (total === null || averages.some(number => !Number.isFinite(number) || number < 0 || number > 100)) return null;
    return { avg10Percent: averages[0], avg60Percent: averages[1], avg300Percent: averages[2], totalMicroseconds: total };
  };
  const some = row("some"), full = row("full"); return some || full ? { available: true, some, full } : { available: false };
}
function linuxCounters(read) {
  let cpu = null, swap = null;
  try {
    const line = read("/proc/stat").split("\n").find(item => /^cpu\s/.test(item));
    const numbers = line?.trim().split(/\s+/).slice(1, 9).map(Number);
    if (numbers?.length === 8 && numbers.every(value => integer(value) !== null) && integer(numbers.reduce((a, b) => a + b, 0)) !== null) cpu = numbers;
  } catch {}
  try {
    const value = read("/proc/vmstat"), incoming = integer(Number(value.match(/^pswpin (\d+)$/m)?.[1])), outgoing = integer(Number(value.match(/^pswpout (\d+)$/m)?.[1]));
    if (incoming !== null && outgoing !== null) swap = [incoming, outgoing];
  } catch {}
  return { cpu, swap };
}
async function linuxActivity({ sampleMs = 1000, read = smallRead, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = () => performance.now() } = {}) {
  const started = clock(), before = linuxCounters(read); await wait(Math.min(1500, Math.max(1, sampleMs)));
  const after = linuxCounters(read), intervalMs = Math.round(clock() - started), validInterval = Number.isSafeInteger(intervalMs) && intervalMs > 0;
  const delta = key => before[key] && after[key] ? after[key].map((value, i) => value - before[key][i]) : null;
  const cpuDelta = delta("cpu"), swapDelta = delta("swap"); let cpu = { available: false }, swapPaging = { available: false };
  if (validInterval && cpuDelta?.every(value => integer(value) !== null)) {
    const total = cpuDelta.reduce((a, b) => a + b, 0), percent = value => Math.round(value / total * 100000) / 1000;
    if (integer(total) !== null && total > 0) cpu = { available: true, userPercent: percent(cpuDelta[0] + cpuDelta[1]),
      systemPercent: percent(cpuDelta[2] + cpuDelta[5] + cpuDelta[6]), idlePercent: percent(cpuDelta[3]),
      ioWaitPercent: percent(cpuDelta[4]), stealPercent: percent(cpuDelta[7]) };
  }
  if (validInterval && swapDelta?.every(value => integer(value) !== null)) swapPaging = { available: true,
    pagesIn: swapDelta[0], pagesOut: swapDelta[1], pagesInPerSecond: Math.round(swapDelta[0] * 1000000 / intervalMs) / 1000,
    pagesOutPerSecond: Math.round(swapDelta[1] * 1000000 / intervalMs) / 1000, activeInSample: swapDelta.some(value => value > 0) };
  const pressureByResource = Object.fromEntries(["cpu", "memory", "io"].map(name => {
    try { return [name, pressure(read("/proc/pressure/" + name, 4096))]; } catch { return [name, { available: false }]; }
  }));
  return { intervalMs: validInterval ? intervalMs : null, cpu, swapPaging, pressure: pressureByResource };
}
function metadata(file) {
  try {
    const s = fs.lstatSync(file);
    return { exists: true, regularFile: s.isFile(), sizeBytes: integer(s.size), modifiedAt: integer(Math.floor(s.mtimeMs)) };
  } catch (error) { return { exists: error?.code === "ENOENT" ? false : null, failure: failure(error) }; }
}
function machine(stateDir) {
  const memory = { totalBytes: integer(os.totalmem()), freeBytes: integer(os.freemem()), availableBytes: null, swapTotalBytes: null, swapUsedBytes: null,
    cgroupLimitBytes: null, cgroupCurrentBytes: null };
  try {
    const value = smallRead("/proc/meminfo"), bytes = field => integer(Number(value.match(new RegExp("^" + field + ":\\s+(\\d+) kB$", "m"))?.[1]) * 1024);
    memory.availableBytes = bytes("MemAvailable"); memory.swapTotalBytes = bytes("SwapTotal");
    const free = bytes("SwapFree"); if (memory.swapTotalBytes !== null && free !== null) memory.swapUsedBytes = integer(memory.swapTotalBytes - free);
  } catch {}
  for (const [name, field] of [["memory.max", "cgroupLimitBytes"], ["memory.current", "cgroupCurrentBytes"]]) {
    try { const value = smallRead("/sys/fs/cgroup/" + name, 128).trim(); memory[field] = /^\d+$/.test(value) ? integer(Number(value)) : null; } catch {}
  }
  let disk;
  try {
    const s = fs.statfsSync(stateDir, { bigint: true });
    disk = { totalBytes: integer(Number(s.blocks * s.bsize)), freeBytes: integer(Number(s.bfree * s.bsize)),
      availableBytes: integer(Number(s.bavail * s.bsize)), freeInodes: integer(Number(s.ffree)) };
  } catch (error) { disk = { failure: failure(error) }; }
  return { cpu: { available: integer(os.availableParallelism()), loadAverage: os.loadavg().map(v => Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) / 1000 : null) },
    uptimeSeconds: integer(Math.floor(os.uptime())), memory, disk };
}
function publicOrigin(configFile) {
  const fd = fs.openSync(configFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > 1048576) throw Error("Invalid config size");
    const buffer = Buffer.alloc(s.size + 1), length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length !== s.size) throw Error("Config changed");
    const value = JSON.parse(buffer.subarray(0, length).toString("utf8")), url = new URL(value.schedulerUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/scheduler\/?$/.test(url.pathname)) throw Error("Invalid service origin");
    return url.origin;
  } finally { fs.closeSync(fd); }
}
async function hashLegacy(file, { maxBytes = 67108864, timeoutMs = 5000 } = {}) {
  let handle, stream, timer;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { status: "not_regular", sha256: null };
    if (before.size > BigInt(maxBytes)) return { status: "size_limit", sha256: null, maxBytes };
    const hash = crypto.createHash("sha256"); let bytes = 0, timedOut = false;
    stream = handle.createReadStream({ autoClose: false, highWaterMark: 65536 });
    timer = setTimeout(() => { timedOut = true; stream.destroy(Error("Deadline")); }, timeoutMs);
    try { for await (const chunk of stream) { bytes += chunk.length; if (bytes > maxBytes) throw Error("Size limit"); hash.update(chunk); } }
    catch (error) { return { status: timedOut ? "deadline" : "read_failed", sha256: null }; }
    const after = await fs.promises.lstat(file, { bigint: true });
    if (!after.isFile() || bytes !== Number(before.size) || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key] !== after[key]))
      return { status: "changed_during_read", sha256: null };
    return { status: "stable_during_read", sha256: hash.digest("hex"), bytesHashed: bytes };
  } catch (error) { return { status: failure(error), sha256: null }; }
  finally { clearTimeout(timer); stream?.destroy(); await handle?.close().catch(() => {}); }
}
function earningProjection(value) {
  const current = value?.currentEpoch;
  if (value?.schema !== 1 || typeof value.ready !== "boolean" || integer(value.observedAt) === null ||
      !Array.isArray(value.reasons) || value.reasons.length > REASONS.size || value.reasons.some(reason => !REASONS.has(reason)) ||
      value.ready !== (value.reasons.length === 0) || !current || epoch(current.epoch) === null ||
      typeof current.budgetPresent !== "boolean" || typeof current.dayPresent !== "boolean") throw Error("Invalid earning health");
  return { schema: 1, ready: value.ready, observedAt: value.observedAt, lastAvailabilitySuccess: integer(value.lastAvailabilitySuccess),
    reasons: [...value.reasons], currentEpoch: { epoch: current.epoch, budgetPresent: current.budgetPresent, dayPresent: current.dayPresent,
      openedAt: integer(current.openedAt), intervalCount: integer(current.intervalCount), lastIntervalEnd: integer(current.lastIntervalEnd) } };
}
function healthProjection(value, kind) {
  if (kind === "earnings") return earningProjection(value);
  if (integer(value?.rewardRuntimeVersion) === null) throw Error("Invalid runtime health");
  return { rewardRuntimeVersion: value.rewardRuntimeVersion, lastServing: integer(value.lastSuccess),
    lastRewardSuccess: integer(value.lastRewardSuccess), lastSettlementSuccess: integer(value.lastSettlementSuccess) };
}
function healthRequest(url, kind, { timeoutMs = 15000, maxBytes = 32768 } = {}) {
  return new Promise(resolve => {
    let request, timer, done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); request?.destroy(); resolve(value); };
    try {
      const target = new URL(url), transport = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
      if (!transport || target.username || target.password) throw Error("Invalid URL");
      timer = setTimeout(() => finish({ failure: "deadline" }), timeoutMs);
      request = transport.get(target, { agent: false, headers: { accept: "application/json" } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); return finish({ httpStatus: response.statusCode, failure: "redirect_refused" }); }
        const chunks = []; let bytes = 0;
        response.on("data", chunk => { bytes += chunk.length; if (bytes > maxBytes) { response.destroy(); finish({ failure: "response_too_large" }); } else chunks.push(chunk); });
        response.on("error", () => finish({ failure: "network_error" }));
        response.on("end", () => {
          try { finish({ httpStatus: response.statusCode, ...healthProjection(JSON.parse(Buffer.concat(chunks).toString("utf8")), kind) }); }
          catch { finish({ httpStatus: response.statusCode, failure: "invalid_response" }); }
        });
      });
      request.on("error", () => finish({ failure: "network_error" }));
    } catch { finish({ failure: "request_failed" }); }
  });
}
function sqliteSummary(stateDir) {
  const { DatabaseSync } = require("node:sqlite");
  const read = (name, fn) => {
    let db;
    try {
      const file = path.join(stateDir, name, `reward-${name}.sqlite`);
      if (!fs.lstatSync(file).isFile()) return { failure: "not_regular" };
      db = new DatabaseSync(file, { readOnly: true });
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; PRAGMA busy_timeout=1000; BEGIN");
      return fn(db);
    } catch (error) { return { failure: failure(error) }; }
    finally { db?.close(); }
  };
  const grouped = rows => rows.map(row => ({ state: state(row.state), count: integer(row.count) }));
  const cycle = read("cycle", db => ({
    countsByState: grouped(db.prepare("SELECT state,COUNT(*) AS count FROM steps GROUP BY state LIMIT 16").all()),
    latestDays: db.prepare("SELECT epoch,manifest IS NOT NULL AS manifest_present,handed_off FROM days ORDER BY length(epoch) DESC,epoch DESC LIMIT 32").all()
      .map(row => ({ epoch: epoch(row.epoch), manifestPresent: row.manifest_present === 1, handedOff: row.handed_off === 1 })),
    unresolvedSteps: db.prepare("SELECT epoch,method,state,tx_id,CAST(json_extract(data,'$.updatedAt') AS INTEGER) AS updated_at FROM steps WHERE state NOT IN ('complete','observed_external') ORDER BY length(epoch),epoch,method LIMIT 96").all()
      .map(row => ({ epoch: epoch(row.epoch), method: METHODS.has(row.method) ? row.method : "unrecognized", state: state(row.state), txId: txId(row.tx_id), updatedAt: integer(row.updated_at) })),
    unresolvedStepLimit: 96,
  }));
  const claims = read("claims", db => ({
    countsByState: grouped(db.prepare("SELECT state,COUNT(*) AS count FROM claims GROUP BY state LIMIT 16").all()),
    pendingCount: integer(db.prepare("SELECT COUNT(*) AS count FROM claims WHERE state NOT IN ('paid','paid_elsewhere')").get().count),
    pendingSample: db.prepare("SELECT state,tx_id,CAST(json_extract(data,'$.updatedAt') AS INTEGER) AS updated_at,CAST(json_extract(data,'$.epoch') AS TEXT) AS epoch FROM claims WHERE state NOT IN ('paid','paid_elsewhere') ORDER BY rowid LIMIT 16").all()
      .map(row => ({ epoch: epoch(row.epoch), state: state(row.state), txId: txId(row.tx_id), updatedAt: integer(row.updated_at) })),
    pendingDetailLimit: 16,
  }));
  return { observation: "separate_read_only_database_snapshots", recordedStatesArePaymentProof: false, cycle, claims };
}
function databaseChild(stateDir, { timeoutMs = 5000, exec = execFile } = {}) {
  return new Promise(resolve => {
    exec(process.execPath, ["--max-old-space-size=32", "--no-warnings", __filename, "--sqlite-child", stateDir],
      { timeout: timeoutMs, maxBuffer: 65536, killSignal: "SIGTERM", env: {} }, (error, stdout) => {
        if (error) return resolve({ failure: error.killed ? "deadline" : "child_failed" });
        try { const result = JSON.parse(stdout); if (result?.observation !== "separate_read_only_database_snapshots" || result.recordedStatesArePaymentProof !== false) throw Error(); resolve(result); }
        catch { resolve({ failure: "invalid_child_response" }); }
      });
  });
}
async function diagnose({ stateDir = STATE_DIR, configFile = CONFIG_FILE, healthOptions, hashOptions, childOptions, activityOptions,
  inspectDatabases = databaseChild, requestHealth = healthRequest, clock = Date.now } = {}) {
  let origin; try { origin = publicOrigin(configFile); } catch {}
  const startedAt = clock(), files = FILES.map(name => ({ name, ...metadata(path.join(stateDir, name)) }));
  const [legacyHash, databases, activity, health] = await Promise.all([
    hashLegacy(path.join(stateDir, LEGACY), hashOptions), inspectDatabases(stateDir, childOptions), linuxActivity(activityOptions),
    Promise.all([...["runtime", "earnings"].map(kind => ({ target: "loopback", kind, origin: "http://127.0.0.1:3109" })),
      ...["runtime", "earnings"].map(kind => ({ target: "public", kind, origin }))].map(async item => ({ target: item.target, kind: item.kind,
        ...(item.origin ? await requestHealth(item.origin + (item.kind === "earnings" ? "/health/earnings" : "/health"), item.kind, healthOptions) : { failure: "configuration_unavailable" }) }))),
  ]);
  return { probe: "reward_storage_preflight", version: 1, startedAt, observedAt: clock(), readOnly: true,
    migrationApproved: false, paymentProof: false, machine: { ...machine(stateDir), activity: { ...activity, sampleIncludesProbeWork: true } }, files,
    legacyJson: { ...legacyHash, schema: null, epochCounts: null, inspection: "metadata_and_stream_hash_only" }, databases, health };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--sqlite-child") {
    try { process.stdout.write(JSON.stringify(sqliteSummary(args[1]))); }
    catch { process.stdout.write(JSON.stringify({ failure: "database_read_failed" })); process.exitCode = 1; }
  } else if (args.length) { process.stdout.write(JSON.stringify({ probe: "reward_storage_preflight", failure: "unexpected_arguments" }) + "\n"); process.exitCode = 1; }
  else diagnose().then(value => process.stdout.write(JSON.stringify(value) + "\n"), () => { process.stdout.write(JSON.stringify({ probe: "reward_storage_preflight", failure: "preflight_failed" }) + "\n"); process.exitCode = 1; });
}
module.exports = { diagnose, sqliteSummary, databaseChild, healthRequest, healthProjection, earningProjection, hashLegacy, metadata, machine, publicOrigin,
  linuxActivity, linuxCounters, pressure, smallRead, FILES, LEGACY };
