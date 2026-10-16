"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process"), { DatabaseSync } = require("node:sqlite");
const { update, drained, OLD, TARGET, UNIT, CHAIN, CONFIG } = require("../deploy/koin-mainnet/update-provider-status");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-update-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: path.join(root, "work"), releases: path.join(root, "releases"), config: path.join(root, "config"), bootstrap: path.join(root, "bootstrap"), state: path.join(root, "state"), unit: path.join(root, "pilot.service") };
  for (const key of ["work", "releases", "config", "bootstrap", "state"]) fs.mkdirSync(p[key], { recursive: true });
  const expiredAt = Date.now() - 1000;
  for (const name of CONFIG) for (const directory of [p.config, p.bootstrap]) {
    const f = path.join(directory, name); fs.mkdirSync(path.dirname(f), { recursive: true });
    const value = name === "runtime.json" ? { mode: "mainnet-pilot", schedulerUrl: "https://payments.koinosai.com/scheduler", deployment: { chainId: CHAIN } }
      : name === "qualifications.json" ? [{ address: "provider", model: "fast", expires: expiredAt }] : { secret: "DO_NOT_PRINT_PRIVATE_VALUE" };
    fs.writeFileSync(f, JSON.stringify(value), { mode: 0o600 });
  }
  const holdFile = path.join(p.state, "scheduler/koin-funded-sessions/funded-reservations.sqlite"), signFile = path.join(p.state, "signing/test-signing.sqlite");
  for (const f of [holdFile, signFile]) fs.mkdirSync(path.dirname(f), { recursive: true });
  let db = new DatabaseSync(holdFile); db.exec("CREATE TABLE holds (id TEXT, state TEXT, data TEXT)"); db.close();
  db = new DatabaseSync(signFile); db.exec("CREATE TABLE signatures (id TEXT, state TEXT, data TEXT)"); db.close();
  const oldUnit = "WorkingDirectory=" + path.join(p.releases, OLD) + "\n"; fs.writeFileSync(p.unit, oldUnit, { mode: 0o600 });
  const calls = [], logs = [], service = { active: "active", dir: path.join(p.releases, OLD), stopHook: null };
  const hold = (state, at = Date.now()) => { const d = new DatabaseSync(holdFile); d.prepare("INSERT INTO holds VALUES (?,?,?)").run("request", state, JSON.stringify({ receipt: { completedAt: at } })); d.close(); };
  const sign = state => { const d = new DatabaseSync(signFile); d.prepare("INSERT INTO signatures VALUES (?,?,?)").run("transaction", state, "{}"); d.close(); };
  const run = (exe, args) => {
    calls.push({ exe, args });
    if (exe === "systemctl") {
      assert.equal(args[1] === UNIT || args[0] === "daemon-reload", true);
      if (args[0] === "show") return ({ WorkingDirectory: service.dir, ActiveState: service.active, FragmentPath: p.unit, DropInPaths: "", ExecMainStatus: "0" })[args.at(-1).split("=")[1]];
      if (args[0] === "stop") { service.active = "inactive"; const hook = service.stopHook; service.stopHook = null; hook?.(); }
      if (args[0] === "start") { service.active = "active"; service.dir = fs.readFileSync(p.unit, "utf8").trim().split("=")[1]; }
      return "";
    }
    if (exe === "git") { if (args[0] === "clone") fs.mkdirSync(args.at(-1)); return args[0] === "rev-parse" ? TARGET : ""; }
    if (exe === "npm" || exe === process.execPath) return "";
    if (exe === "tar") { assert.equal(service.active, "inactive"); return execFileSync(exe, args, { encoding: "utf8" }); }
    if (exe === "bash") {
      assert.equal(service.active, "inactive"); assert.equal(args[0], "deploy/koin-mainnet/install.sh"); assert.equal(args[1], p.bootstrap);
      service.dir = path.join(p.releases, TARGET); fs.writeFileSync(p.unit, "WorkingDirectory=" + service.dir + "\n"); service.active = "active"; return "";
    }
    throw Error("Unexpected external command");
  };
  return { p, holdFile, signFile, oldUnit, calls, logs, service, hold, sign, options: { paths: p, run, checkHealth: async () => {}, log: line => logs.push(line) } };
}
test("provider update backs up stopped state, preserves configuration and reports expired qualification without renewing", async t => {
  const f = fixture(t), before = CONFIG.map(n => fs.readFileSync(path.join(f.p.config, n))), ledger = fs.readFileSync(f.holdFile);
  await update(f.options); assert.equal(f.service.dir, path.join(f.p.releases, TARGET)); assert.equal(f.service.active, "active");
  CONFIG.forEach((n, i) => assert.deepEqual(fs.readFileSync(path.join(f.p.config, n)), before[i]));
  assert.deepEqual(fs.readFileSync(f.holdFile), ledger);
  const work = path.join(f.p.work, fs.readdirSync(f.p.work)[0]), backup = path.join(work, "before-update.tgz");
  assert.equal(fs.statSync(work).mode & 0o777, 0o700); assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(path.join(work, "previous.service"), "utf8"), f.oldUnit);
  assert(f.logs.some(v => v.includes('"qualification":"renewal required"'))); assert(!f.logs.join("\n").includes("DO_NOT_PRINT_PRIVATE_VALUE"));
});
for (const state of ["reserved", "dispatched", "verified", "prepared", "submitted", "unknown"]) test(`unresolved ${state} request prevents any service restart`, async t => {
  const f = fixture(t); f.hold(state); await assert.rejects(update(f.options), /Unfinished paid requests/);
  assert.equal(f.calls.some(c => c.exe === "systemctl" && c.args[0] === "stop"), false);
});
test("a saved signature and a recently completed reply block rollout without changing their records", async t => {
  const f = fixture(t); f.sign("signed"); const before = fs.readFileSync(f.signFile);
  assert.throws(() => drained(f.p.state), /saved payment transaction/); assert.deepEqual(fs.readFileSync(f.signFile), before);
  const g = fixture(t); g.hold("settled"); assert.throws(() => drained(g.p.state), /recent reply/);
});
test("a late request during shutdown restarts old code and preserves the request", async t => {
  const f = fixture(t); f.service.stopHook = () => f.hold("dispatched");
  await assert.rejects(update(f.options), /Unfinished paid requests/);
  assert.equal(f.service.active, "active"); assert.equal(f.service.dir, path.join(f.p.releases, OLD));
  assert.equal(f.calls.some(c => c.exe === "bash"), false); assert.throws(() => drained(f.p.state), /dispatched=1/);
});
test("failed updated health rolls back only code and keeps transactions written by the new process", async t => {
  const f = fixture(t); f.options.checkHealth = async () => { f.sign("signed"); throw Error("health unavailable"); };
  await assert.rejects(update(f.options), /health unavailable/);
  assert.equal(f.service.active, "active"); assert.equal(f.service.dir, path.join(f.p.releases, OLD));
  assert.equal(fs.readFileSync(f.p.unit, "utf8"), f.oldUnit); assert.throws(() => drained(f.p.state), /saved payment transaction/);
});
test("different configuration or a later service version prevents the one-time updater from changing the server", async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.p.bootstrap, "qualifications.json"), "[]");
  await assert.rejects(update(f.options), /configuration differ/); assert.equal(f.calls.some(c => c.exe === "git"), false);
  const g = fixture(t); g.service.dir = path.join(g.p.releases, "different-version");
  await assert.rejects(update(g.options), /Unexpected service version/); assert.equal(g.calls.some(c => c.exe === "git"), false);
});
