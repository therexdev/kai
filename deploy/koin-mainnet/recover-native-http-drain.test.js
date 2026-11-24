"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const R = require("./recover-native-http-drain");
function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kai-drain-test-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const file = path.join(work, `kai-native-qualification-plan-${R.TARGET}.json`);
  const plan = { schema: 1, base: R.BASE, target: R.TARGET, phase: "draining", initial: { ActiveState: "active", MainPID: "477847", ExecMainPID: "477847", NRestarts: "0" } };
  const save = () => fs.writeFileSync(file, JSON.stringify(plan), { mode: 0o600 }); save();
  let exited = false, listener = false, dirty = false, clock = 0, closeWorks = true, statePatch = {}, changedPlan = false;
  let socket = 'ESTAB 0 0 127.0.0.1:3109 127.0.0.1:43802 users:(("node",pid=477847,fd=80))';
  const calls = [];
  const run = (exe, args) => {
    calls.push([exe, ...args]);
    if (exe === "git") return args[0] === "rev-parse" ? R.TARGET : dirty ? " M code.js" : "";
    if (exe === "systemctl") return Object.entries({ ActiveState: exited ? "inactive" : "active", SubState: exited ? "dead" : "running", MainPID: exited ? "0" : "477847", ExecMainPID: "477847", ExecMainCode: exited ? "1" : "0", ExecMainStatus: "0", Result: "success", NRestarts: "0", WorkingDirectory: `/opt/kai-koin-prepaid/releases/${R.BASE}`, ...statePatch }).map(([k,v]) => `${k}=${v}`).join("\n");
    if (exe === "ss" && args[0] === "-Hlnt") return listener ? "LISTEN 0 511 127.0.0.1:3109" : "";
    if (exe === "ss" && args[0] === "-Hntp") { if (changedPlan) fs.appendFileSync(file, "\n"); return socket; }
    if (exe === "ss" && args[0] === "-Knt") { assert.equal(args[1], R.FILTER); exited = closeWorks; return ""; }
    assert.fail(`Unexpected command ${exe}`);
  };
  return { file, work, plan, save, calls, options: { work, uid: 0, run, now: () => clock, wait: async ms => { clock += ms; }, timeoutMs: 1000, log() {} },
    set exited(v) { exited = v; }, set listener(v) { listener = v; }, set dirty(v) { dirty = v; }, set closeWorks(v) { closeWorks = v; },
    set state(v) { statePatch = v; }, set socket(v) { socket = v; }, set changedPlan(v) { changedPlan = v; },
    assertUntouched() { assert.equal(calls.some(c => c[0] === "ss" && c[1] === "-Knt"), false); } };
}
test("only exact observed socket is closed; plan remains byte-identical and process is never signaled", async t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file); await R.recover(f.options);
  assert.equal(f.calls.filter(c => c[0] === "ss" && c[1] === "-Knt").length, 1);
  assert.ok(f.calls.filter(c => c[0] === "systemctl").every(c => c[1] === "show"));
  assert.deepEqual(fs.readFileSync(f.file), bytes); assert.equal(fs.existsSync(path.join(f.work, "kai-native-qualification-update.lock")), false);
});
test("already clean exit can resume without disconnecting", async t => { const f = fixture(t); f.exited = true; await R.recover(f.options); f.assertUntouched(); });
test("wrong process, restart, failure or release is rejected", async t => {
  for (const state of [{ MainPID: "99" }, { ExecMainPID: "99" }, { NRestarts: "1" }, { ExecMainStatus: "1" }, { Result: "signal" }, { WorkingDirectory: "/elsewhere" }]) {
    const f = fixture(t); f.state = state; await assert.rejects(R.recover(f.options)); f.assertUntouched();
  }
});
test("listener, dirty checkout and changed plan refuse recovery", async t => {
  for (const kind of ["listener", "dirty", "changedPlan"]) { const f = fixture(t); f[kind] = true; await assert.rejects(R.recover(f.options)); f.assertUntouched(); }
});
test("other peer, PID, FD, queued data or extra socket cannot be closed", async t => {
  const s = 'ESTAB 0 0 127.0.0.1:3109 127.0.0.1:43802 users:(("node",pid=477847,fd=80))';
  for (const socket of ["", s.replace("43802", "43803"), s.replace("477847", "99"), s.replace("fd=80", "fd=81"), s.replace("0 0", "1 0"), s + "\n" + s]) {
    const f = fixture(t); f.socket = socket; await assert.rejects(R.recover(f.options)); f.assertUntouched();
  }
});
test("wrong phase or unprotected plan cannot be used", async t => {
  const f = fixture(t); f.plan.phase = "ready"; f.save(); await assert.rejects(R.recover(f.options)); f.assertUntouched();
  const g = fixture(t); fs.chmodSync(g.file, 0o644); await assert.rejects(R.recover(g.options)); g.assertUntouched();
});
test("concurrent updater lock is retained and no command kills a process after socket timeout", async t => {
  const f = fixture(t), lock = path.join(f.work, "kai-native-qualification-update.lock"); fs.mkdirSync(lock);
  await assert.rejects(R.recover(f.options), /EEXIST/); assert.ok(fs.existsSync(lock)); f.assertUntouched();
  const g = fixture(t); g.closeWorks = false; await assert.rejects(R.recover(g.options), /still draining/);
  assert.equal(g.calls.filter(c => c[0] === "ss" && c[1] === "-Knt").length, 1);
  assert.ok(g.calls.filter(c => c[0] === "systemctl").every(c => c[1] === "show"));
});
