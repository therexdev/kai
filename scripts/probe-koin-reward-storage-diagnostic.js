"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), http = require("node:http");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const D = require("../deploy/koin-mainnet/diagnose-reward-storage");
const NOW = 1794196929088, SECRET = "not-for-diagnostic-output", ADDRESS = "1PrivateAddressShouldNotBePrinted";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-storage-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, "runtime.json"), stateDir = path.join(root, "state"), legacy = path.join(stateDir, D.LEGACY);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ schedulerUrl: "https://credits.example/scheduler", secret: SECRET }));
  fs.writeFileSync(legacy, JSON.stringify({ schema: 1, days: {}, presence: { [ADDRESS]: [SECRET] } }));
  const databases = {};
  for (const name of ["cycle", "claims"]) {
    const dir = path.join(stateDir, name); fs.mkdirSync(dir);
    const file = path.join(dir, `reward-${name}.sqlite`), db = new DatabaseSync(file);
    if (name === "cycle") {
      db.exec("CREATE TABLE days(epoch TEXT PRIMARY KEY,manifest TEXT,handed_off INTEGER); CREATE TABLE steps(epoch TEXT,method TEXT,state TEXT,tx_id TEXT,data TEXT)");
      db.prepare("INSERT INTO days VALUES(?,?,?)").run("20765", SECRET, 0);
      for (const [method, state] of [["open_epoch", "complete"], ["propose_root", "pending"], ["finalize_root", "queued"]])
        db.prepare("INSERT INTO steps VALUES(?,?,?,?,?)").run("20765", method, state, method === "propose_root" ? "0x1220" + "a".repeat(64) : null, JSON.stringify({ updatedAt: NOW - 1000, reason: SECRET, outbox: { transaction: { signatures: [SECRET] } } }));
    } else {
      db.exec("CREATE TABLE claims(state TEXT,tx_id TEXT,data TEXT)");
      for (const state of ["queued", "pending", "paid", "paid_elsewhere"])
        db.prepare("INSERT INTO claims VALUES(?,?,?)").run(state, "0x1220" + "b".repeat(64), JSON.stringify({ epoch: "20765", updatedAt: NOW - 2000, claim: { address: ADDRESS }, secret: SECRET }));
    }
    db.close(); databases[name] = file;
  }
  return { root, configFile, stateDir, legacy, databases };
}
function earning() { return { schema: 1, ready: true, observedAt: NOW, lastAvailabilitySuccess: NOW - 1000,
  reasons: [], currentEpoch: { epoch: "20766", budgetPresent: true, dayPresent: true, openedAt: NOW - 300000, intervalCount: 4, lastIntervalEnd: NOW - 60000 } }; }
function health(kind) { return kind === "earnings" ? { ...earning(), secret: SECRET } : { rewardRuntimeVersion: 3, lastSuccess: NOW, lastRewardSuccess: null, lastSettlementSuccess: null, secret: SECRET }; }
async function server(t, handler) {
  const value = http.createServer(handler); await new Promise(resolve => value.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { value.closeAllConnections(); value.close(resolve); }));
  return `http://127.0.0.1:${value.address().port}`;
}
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
test("preflight reports safe read-only projections and leaves all original bytes unchanged", async t => {
  const f = fixture(t), files = [f.configFile, f.legacy, ...Object.values(f.databases)], before = files.map(digest), urls = [];
  const result = await D.diagnose({ ...f, clock: () => NOW, requestHealth: async (url, kind) => { urls.push(url); return { httpStatus: 200, ...D.healthProjection(health(kind), kind) }; } });
  assert.equal(result.readOnly, true); assert.equal(result.migrationApproved, false); assert.equal(result.paymentProof, false);
  assert.equal(result.legacyJson.status, "stable_during_read"); assert.equal(result.legacyJson.sha256, digest(f.legacy));
  assert.equal(result.legacyJson.schema, null); assert.equal(result.legacyJson.epochCounts, null);
  assert.equal(result.databases.claims.pendingCount, 2); assert.equal(result.databases.recordedStatesArePaymentProof, false);
  assert.deepEqual(result.databases.cycle.unresolvedSteps.map(row => row.method), ["finalize_root", "propose_root"]);
  assert.equal(result.databases.cycle.latestDays[0].manifestPresent, true);
  assert.equal(result.databases.cycle.latestDays[0].handedOff, false);
  assert.equal(result.files.length, 7); assert.equal(result.health.length, 4);
  assert.ok(urls.every(url => url.endsWith("/health") || url.endsWith("/health/earnings")));
  assert.equal(urls.some(url => url.includes("operator")), false);
  const output = JSON.stringify(result); assert.equal(output.includes(SECRET), false); assert.equal(output.includes(ADDRESS), false);
  assert.deepEqual(files.map(digest), before);
  assert.ok(result.machine.memory.totalBytes > 0); assert.ok(result.machine.disk.availableBytes >= 0);
  assert.equal(result.machine.activity.sampleIncludesProbeWork, true);
});
test("streaming hash handles size caps, replacement during read, missing files and symlinks without parsing JSON", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.legacy, "not JSON: " + SECRET);
  assert.equal((await D.hashLegacy(f.legacy)).status, "stable_during_read");
  assert.equal((await D.hashLegacy(f.legacy, { maxBytes: 2 })).status, "size_limit");
  assert.equal((await D.hashLegacy(path.join(f.root, "missing"))).status, "not_found");
  const link = path.join(f.root, "link"); fs.symlinkSync(f.legacy, link);
  assert.equal((await D.hashLegacy(link)).sha256, null);
  const old = fs.promises.lstat;
  fs.promises.lstat = async (...args) => { fs.renameSync(f.legacy, f.legacy + ".old"); fs.writeFileSync(f.legacy, "changed"); return old(...args); };
  try { assert.equal((await D.hashLegacy(f.legacy)).status, "changed_during_read"); }
  finally { fs.promises.lstat = old; }
});
test("SQLite detail counts and rows are bounded and never emit unknown payload fields", t => {
  const f = fixture(t), claims = new DatabaseSync(f.databases.claims), cycle = new DatabaseSync(f.databases.cycle);
  for (let i = 0; i < 120; i++) {
    claims.prepare("INSERT INTO claims VALUES(?,?,?)").run("queued", SECRET, JSON.stringify({ epoch: String(20000 + i), updatedAt: NOW, secret: SECRET, claim: { address: ADDRESS } }));
    cycle.prepare("INSERT INTO days VALUES(?,?,?)").run(String(20000 + i), SECRET, 0);
    cycle.prepare("INSERT INTO steps VALUES(?,?,?,?,?)").run(String(20000 + i), "propose_root", "pending", SECRET, JSON.stringify({ updatedAt: NOW, secret: SECRET }));
  }
  claims.prepare("INSERT INTO claims VALUES(?,?,?)").run(SECRET, SECRET, JSON.stringify({ epoch: SECRET, updatedAt: SECRET }));
  claims.close(); cycle.close();
  const result = D.sqliteSummary(f.stateDir);
  assert.equal(result.claims.pendingCount, 123); assert.equal(result.claims.pendingSample.length, 16);
  assert.equal(result.cycle.unresolvedSteps.length, 96); assert.equal(result.cycle.latestDays.length, 32);
  assert.ok(result.claims.countsByState.some(row => row.state === "unrecognized"));
  assert.equal(JSON.stringify(result).includes(SECRET), false); assert.equal(JSON.stringify(result).includes(ADDRESS), false);
});
test("read-only SQLite inspection never creates missing databases or follows a database symlink", t => {
  const f = fixture(t); fs.rmSync(f.databases.claims);
  let result = D.sqliteSummary(f.stateDir); assert.equal(result.claims.failure, "not_found"); assert.equal(fs.existsSync(f.databases.claims), false);
  fs.symlinkSync(f.databases.cycle, f.databases.claims);
  result = D.sqliteSummary(f.stateDir); assert.equal(result.claims.failure, "not_regular");
});
test("SQLite subprocess is capped, bounded, environment-isolated and fails safely", async () => {
  const exec = (exe, args, options, callback) => {
    assert.equal(exe, process.execPath); assert.ok(args.includes("--max-old-space-size=32")); assert.ok(args.includes("--sqlite-child"));
    assert.deepEqual(options.env, {}); assert.equal(options.maxBuffer, 65536); assert.equal(options.killSignal, "SIGTERM"); assert.equal(options.timeout, 100);
    callback(Object.assign(Error(SECRET), { killed: true }), SECRET);
  };
  assert.deepEqual(await D.databaseChild("/unused", { exec, timeoutMs: 100 }), { failure: "deadline" });
  assert.deepEqual(await D.databaseChild("/unused", { exec: (a, b, c, callback) => callback(null, SECRET) }), { failure: "invalid_child_response" });
});
test("a real child deadline leaves the financial files unchanged", async t => {
  const f = fixture(t), files = Object.values(f.databases), before = files.map(digest);
  assert.deepEqual(await D.databaseChild(f.stateDir, { timeoutMs: 1 }), { failure: "deadline" });
  assert.deepEqual(files.map(digest), before);
});
test("native health reads accept local 200/503 JSON and discard arbitrary fields", async t => {
  const origin = await server(t, (req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ ...earning(), ready: false, reasons: ["availability_processing_stale"], secret: SECRET })); });
  const result = await D.healthRequest(origin + "/health/earnings", "earnings");
  assert.equal(result.httpStatus, 503); assert.equal(result.ready, false); assert.deepEqual(result.reasons, ["availability_processing_stale"]);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(D.healthProjection(health("runtime"), "runtime").lastRewardSuccess, null);
});
test("storage failure preserves unknown current-day fields instead of reporting a missing budget", () => {
  const value = { ...earning(), ready: false, reasons: ["reward_storage_unavailable"], currentEpoch: {
    epoch: "20766", budgetPresent: null, dayPresent: null, openedAt: null, intervalCount: null, lastIntervalEnd: null } };
  assert.deepEqual(D.healthProjection(value, "earnings"), value);
  assert.throws(() => D.healthProjection({ ...value, reasons: ["availability_processing_stale"] }, "earnings"), /Invalid earning health/);
});
test("native health deadline includes stalled bodies and redirects never reach another path", async t => {
  let forbidden = false;
  const origin = await server(t, (req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/private" }); res.end(); }
    else if (req.url === "/private") { forbidden = true; res.end(SECRET); }
    else { res.writeHead(200); res.write('{"schema":'); }
  });
  assert.equal((await D.healthRequest(origin + "/stall", "earnings", { timeoutMs: 40 })).failure, "deadline");
  assert.equal((await D.healthRequest(origin + "/redirect", "earnings")).failure, "redirect_refused"); assert.equal(forbidden, false);
});
test("oversized, malformed and unknown-reason health responses remain fixed failures", async t => {
  const origin = await server(t, (req, res) => { if (req.url === "/large") res.end(SECRET.repeat(3000)); else res.end(JSON.stringify({ ...earning(), ready: false, reasons: [SECRET] })); });
  assert.equal((await D.healthRequest(origin + "/large", "earnings")).failure, "response_too_large");
  assert.equal((await D.healthRequest(origin + "/invalid", "earnings")).failure, "invalid_response");
});
test("configuration is bounded and credential-bearing origins never become requests", async t => {
  const f = fixture(t); assert.equal(D.publicOrigin(f.configFile), "https://credits.example");
  for (const schedulerUrl of ["https://user:password@credits.example/scheduler", "http://credits.example/scheduler", "https://credits.example/scheduler?secret=" + SECRET]) {
    fs.writeFileSync(f.configFile, JSON.stringify({ schedulerUrl })); assert.throws(() => D.publicOrigin(f.configFile));
  }
  const requested = [];
  const result = await D.diagnose({ ...f, requestHealth: async url => { requested.push(url); return { failure: "test_unavailable" }; } });
  assert.equal(requested.length, 2); assert.ok(requested.every(url => url.startsWith("http://127.0.0.1:3109/health")));
  assert.ok(result.health.filter(row => row.target === "public").every(row => row.failure === "configuration_unavailable"));
  fs.writeFileSync(f.configFile, "x".repeat(1048577)); assert.throws(() => D.publicOrigin(f.configFile));
});
test("Linux activity separates allocated swap from paging and accounts CPU/iowait/steal without guest duplication", async () => {
  let now = 0, second = false;
  const read = file => {
    if (file === "/proc/stat") return second ? "cpu 110 0 25 840 30 5 5 5 999 999\n" : "cpu 100 0 20 800 20 0 0 0 999 999\n";
    if (file === "/proc/vmstat") return second ? "pswpin 104\npswpout 203\n" : "pswpin 100\npswpout 200\n";
    return "some avg10=1.25 avg60=0.20 avg300=0.00 total=1234\nfull avg10=0.50 avg60=0.00 avg300=0.00 total=321\n";
  };
  const result = await D.linuxActivity({ read, clock: () => now, wait: async delay => { assert.equal(delay, 1000); now = 1000; second = true; } });
  assert.equal(result.intervalMs, 1000); assert.deepEqual(result.cpu, { available: true, userPercent: 12.5, systemPercent: 18.75, idlePercent: 50, ioWaitPercent: 12.5, stealPercent: 6.25 });
  assert.deepEqual(result.swapPaging, { available: true, pagesIn: 4, pagesOut: 3, pagesInPerSecond: 4, pagesOutPerSecond: 3, activeInSample: true });
  assert.equal(result.pressure.memory.some.avg10Percent, 1.25); assert.equal(result.pressure.io.full.totalMicroseconds, 321);
});
test("zero paging, reset counters and unavailable Linux pressure remain distinct", async () => {
  let now = 0;
  const read = file => { if (file === "/proc/vmstat") return "pswpin 100\npswpout 200\n"; throw Error(SECRET); };
  let result = await D.linuxActivity({ read, clock: () => now, wait: async () => { now = 1000; } });
  assert.equal(result.swapPaging.available, true); assert.equal(result.swapPaging.activeInSample, false);
  assert.equal(result.cpu.available, false); assert.equal(result.pressure.cpu.available, false);
  now = 0;
  result = await D.linuxActivity({ read: file => { if (file === "/proc/vmstat") return now ? "pswpin 1\npswpout 2\n" : "pswpin 100\npswpout 200\n"; throw Error(SECRET); }, clock: () => now, wait: async () => { now = 1000; } });
  assert.equal(result.swapPaging.available, false); assert.equal(JSON.stringify(result).includes(SECRET), false);
  now = 0;
  result = await D.linuxActivity({ read: () => { throw Error("Non-Linux"); }, clock: () => now, wait: async () => { now = 1000; } });
  assert.equal(result.cpu.available, false); assert.equal(result.swapPaging.available, false); assert.ok(Object.values(result.pressure).every(value => value.available === false));
  assert.deepEqual(D.pressure("some avg10=101 avg60=0 avg300=0 total=0\n"), { available: false });
});
test("small proc-style reads are bounded and the copied standalone script has no repository dependency", t => {
  const f = fixture(t), small = path.join(f.root, "small"), copied = path.join(f.root, "diagnose.js");
  fs.writeFileSync(small, "1234"); assert.equal(D.smallRead(small, 4), "1234"); assert.throws(() => D.smallRead(small, 3));
  fs.copyFileSync(require.resolve("../deploy/koin-mainnet/diagnose-reward-storage"), copied);
  const output = execFileSync(process.execPath, ["--no-warnings", copied, "--sqlite-child", f.stateDir], { cwd: f.root, env: {}, encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
  const result = JSON.parse(output); assert.equal(result.claims.pendingCount, 2); assert.equal(output.includes(SECRET), false);
});
