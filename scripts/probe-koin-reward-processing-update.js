"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process"), { DatabaseSync } = require("node:sqlite");
const { update, drained, preserved, verifyFrozen, OLD, TARGET, UNIT, CHAIN, CONFIG } = require("../deploy/koin-mainnet/update-reward-processing");
const P = require("../lib/koin-network/job-protocol");
const { fixture: cycleFixture, payer, verifier } = require("./helpers/koin-cycle-fixture");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-session-update-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: path.join(root, "work"), releases: path.join(root, "releases"), config: path.join(root, "config"), bootstrap: path.join(root, "bootstrap"), state: path.join(root, "state"), unit: path.join(root, "pilot.service") };
  for (const key of ["work", "releases", "config", "bootstrap", "state"]) fs.mkdirSync(p[key], { recursive: true });
  const expiredAt = Date.now() - 1000;
  for (const name of CONFIG) for (const directory of [p.config, p.bootstrap]) {
    const f = path.join(directory, name); fs.mkdirSync(path.dirname(f), { recursive: true });
    const value = name === "runtime.json" ? { mode: "mainnet-pilot", schedulerUrl: "https://payments.koinosai.com/scheduler", deployment: { chainId: CHAIN, rewards: "reward-contract" }, roles: { lifecycle: "lifecycle" }, maxRcPerTransaction: "10000" }
      : name === "qualifications.json" ? [{ address: "provider", model: "fast", expires: expiredAt }] : { secret: "DO_NOT_PRINT_PRIVATE_VALUE" };
    fs.writeFileSync(f, JSON.stringify(value), { mode: 0o600 });
  }
  const holdFile = path.join(p.state, "scheduler/koin-funded-sessions/funded-reservations.sqlite"), signFile = path.join(p.state, "signing/test-signing.sqlite");
  for (const f of [holdFile, signFile]) fs.mkdirSync(path.dirname(f), { recursive: true });
  let db = new DatabaseSync(holdFile); db.exec("CREATE TABLE holds (id TEXT, state TEXT, data TEXT)"); db.close();
  db = new DatabaseSync(signFile); db.exec("CREATE TABLE signatures (id TEXT, state TEXT, data TEXT, owner TEXT, hash TEXT)"); db.close();
  const oldUnit = "WorkingDirectory=" + path.join(p.releases, OLD) + "\n"; fs.writeFileSync(p.unit, oldUnit, { mode: 0o600 });
  const calls = [], logs = [], service = { active: "active", dir: path.join(p.releases, OLD), stopHook: null };
  const hold = (state, at = Date.now()) => { const d = new DatabaseSync(holdFile); d.prepare("INSERT INTO holds VALUES (?,?,?)").run("request", state, JSON.stringify({ receipt: { completedAt: at } })); d.close(); };
  const sign = state => { const d = new DatabaseSync(signFile); d.prepare("INSERT INTO signatures(id,state,data) VALUES (?,?,?)").run("transaction", state, "{}"); d.close(); };
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
  return { p, holdFile, signFile, oldUnit, calls, logs, service, hold, sign, options: { paths: p, run, checkHealth: async () => {}, checkFrozen: rows => verifyFrozen(rows, path.resolve(__dirname, "..")), report: async () => {}, log: line => logs.push(line) } };
}
test("reward-processing update backs up stopped state, preserves configuration and reports expired qualification without renewing", async t => {
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
  assert.throws(() => drained(f.p.state), /journal integrity|Unresolved transaction/); assert.deepEqual(fs.readFileSync(f.signFile), before);
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
  assert.equal(fs.readFileSync(f.p.unit, "utf8"), f.oldUnit); assert.throws(() => drained(f.p.state), /journal integrity|Unresolved transaction/);
});
test("different configuration or a later service version prevents the one-time updater from changing the server", async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.p.bootstrap, "qualifications.json"), "[]");
  await assert.rejects(update(f.options), /configuration differ/); assert.equal(f.calls.some(c => c.exe === "git"), false);
  const g = fixture(t); g.service.dir = path.join(g.p.releases, "different-version");
  await assert.rejects(update(g.options), /Unexpected service version/); assert.equal(g.calls.some(c => c.exe === "git"), false);
});
async function frozenFixture(t) {
  const f = fixture(t), cycle = await cycleFixture(t, {}, true);
  for (let n = 0; n < 4; n++) { await cycle.runner().tick({ openCurrentDay: false }); cycle.advance(1001); }
  const source = new DatabaseSync(path.join(cycle.dir, "reward-cycle.sqlite"), { readOnly: true });
  const step = source.prepare("SELECT * FROM steps WHERE method='open_epoch'").get(); source.close();
  assert.equal(step.state, "needs_review");
  const file = path.join(f.p.state, "cycle/reward-cycle.sqlite"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE steps(id TEXT,epoch TEXT,method TEXT,state TEXT,tx_id TEXT,hash TEXT,data TEXT)");
  db.prepare("INSERT INTO steps VALUES(?,?,?,?,?,?,?)").run(step.id, step.epoch, step.method, step.state, step.tx_id, step.hash, step.data); db.close();
  const r = { id: P.hash("cycle:1:open_epoch"), owner: payer.getAddress(), state: "signed", signers: [payer.getAddress()], transaction: cycle.sent[0] };
  const signing = new DatabaseSync(f.signFile), data = JSON.stringify(r);
  signing.prepare("INSERT INTO signatures VALUES(?,?,?,?,?)").run(r.id, r.state, data, r.owner, P.hash(data)); signing.close();
  const config = JSON.parse(fs.readFileSync(path.join(f.p.config, "runtime.json")));
  config.roles.lifecycle = r.owner; config.deployment.rewards = cycle.target.rewards; config.deployment.verifier = verifier.getAddress();
  for (const root of [f.p.config, f.p.bootstrap]) fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(config));
  return { ...f, config, cycleFile: file, transaction: r.transaction };
}
test("a compatible rollout preserves the exact exhausted reward transaction without reopening its attempts", async t => {
  const f = await frozenFixture(t), beforeSign = fs.readFileSync(f.signFile), beforeCycle = fs.readFileSync(f.cycleFile);
  const held = drained(f.p.state, f.config); assert.equal(held.length, 1);
  await verifyFrozen(held, path.resolve(__dirname, ".."));
  await update(f.options);
  assert.equal(f.service.dir, path.join(f.p.releases, TARGET));
  assert.deepEqual(fs.readFileSync(f.signFile), beforeSign); assert.deepEqual(fs.readFileSync(f.cycleFile), beforeCycle);
  assert.equal(drained(f.p.state, f.config)[0].attempts, 3);
  assert.match(f.logs.join("\n"), /extraRetriesAuthorized.*false/);
});
test("active or differently blocked reward transactions cannot use the frozen-envelope rollout", async t => {
  for (const change of ["state", "reason", "attempts", "transaction", "hash"]) {
    const f = await frozenFixture(t), db = new DatabaseSync(f.cycleFile);
    const row = db.prepare("SELECT * FROM steps").get(), r = JSON.parse(row.data);
    if (change === "state") r.state = "unknown";
    if (change === "reason") r.reason = "root_changed";
    if (change === "attempts") r.outbox.attempts = 2;
    if (change === "transaction") r.outbox.transaction.header.rc_limit = "20000";
    const data = JSON.stringify(r);
    db.prepare("UPDATE steps SET state=?,data=?,hash=?").run(r.state, data, change === "hash" ? "bad" : P.hash(data)); db.close();
    await assert.rejects(update(f.options), /frozen|integrity/);
    assert.equal(f.calls.some(c => c.exe === "systemctl" && c.args[0] === "stop"), false);
  }
});
test("signature verification rejects a corrupted frozen envelope even if record hashes were recomputed", async t => {
  const f = await frozenFixture(t), held = drained(f.p.state, f.config);
  held[0].transaction.signatures = [];
  await assert.rejects(verifyFrozen(held, path.resolve(__dirname, "..")), /signature|commitment/);
});
test("post-start frozen-record changes trigger code rollback without restoring a payment database", async t => {
  const f = await frozenFixture(t);
  f.options.checkHealth = async () => {
    const db = new DatabaseSync(f.cycleFile), row = db.prepare("SELECT * FROM steps").get(), r = JSON.parse(row.data);
    r.outbox.attempts = 4; const data = JSON.stringify(r);
    db.prepare("UPDATE steps SET data=?,hash=?").run(data, P.hash(data)); db.close();
  };
  await assert.rejects(update(f.options), /changed unexpectedly/);
  assert.equal(f.service.dir, path.join(f.p.releases, OLD));
  const db = new DatabaseSync(f.cycleFile, { readOnly: true });
  assert.equal(JSON.parse(db.prepare("SELECT data FROM steps").get().data).outbox.attempts, 4); db.close();
});
