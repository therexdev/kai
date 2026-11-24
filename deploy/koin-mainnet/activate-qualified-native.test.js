"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const A = require("./activate-qualified-native");
function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kai-native-activation-")); t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const file = path.join(work, "account.env"), before = Buffer.from('# Keep exactly\nSMTP_PASSWORD="private-fixture"\nKAI_AKASHML_API_KEY_FILE=' + A.VALUES.KAI_AKASHML_API_KEY_FILE + '\n');
  fs.writeFileSync(file, before, { mode: 0o600 });
  let active = true, loaded = false, pid = "100", execPid = "100", restarts = "0", failHealth = false, failDrain = false, failGuard = false, invalid = false, changeOnDrain = false, exitCode = "0";
  const calls = [], logs = [];
  const state = () => ({ ActiveState: active ? "active" : "inactive", MainPID: active ? pid : "0", ExecMainPID: execPid, ExecMainCode: active ? "0" : "1", ExecMainStatus: exitCode, Result: "success", NRestarts: restarts });
  const deps = {
    locks: ["code-update.lock"], guard() { if (failGuard) throw Error("Wrong service"); }, state, loaded: () => loaded,
    qualify() { calls.push("qualify"); return invalid ? null : { version: 2, replay: "sealed-v1", qualificationId: "a".repeat(64), expiresAt: Date.now() + 3600000 }; },
    async drain({ assertUnchanged }) {
      calls.push("drain"); assertUnchanged(); if (failDrain) throw Error("Drain timed out"); active = false;
      if (changeOnDrain) fs.appendFileSync(file, "CONCURRENT=preserved\n");
      return state();
    },
    async health() { calls.push("health"); if (failHealth) throw Error("Health not ready"); },
  };
  const run = (exe, args) => {
    assert.equal(exe, "systemctl"); assert.deepEqual(args, ["start", "kai-koin-prepaid.service"]);
    assert.equal(active, false, "must not start another writer"); calls.push("start"); active = true; loaded = true; pid = "101"; execPid = pid;
    return "";
  };
  return { work, file, before, calls, logs, deps, options: { work, file, run, deps, log: s => logs.push(s) },
    set active(v) { active = v; }, set loaded(v) { loaded = v; }, set failHealth(v) { failHealth = v; }, set failDrain(v) { failDrain = v; },
    set failGuard(v) { failGuard = v; }, set invalid(v) { invalid = v; }, set changeOnDrain(v) { changeOnDrain = v; }, set exitCode(v) { exitCode = v; },
    set restarts(v) { restarts = v; },
  };
}
test("appends only qualified model/path, preserves private settings and backup, then cleanly activates once", async t => {
  const f = fixture(t); await A.activate(f.options);
  const after = fs.readFileSync(f.file); assert.deepEqual(after, A.desired(f.before)); assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const backups = fs.readdirSync(f.work).filter(p => p.startsWith("kai-native-config-")); assert.equal(backups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.work, backups[0], "account.env")), f.before);
  assert.equal(fs.statSync(path.join(f.work, backups[0])).mode & 0o777, 0o700);
  assert.ok(f.calls.indexOf("drain") < f.calls.indexOf("start")); assert.doesNotMatch(f.logs.join("\n"), /private-fixture/);
  await A.activate(f.options); assert.equal(f.calls.filter(x => x === "drain").length, 1); assert.equal(f.calls.filter(x => x === "start").length, 1);
  assert.equal(fs.existsSync(path.join(f.work, "code-update.lock")), false);
});
test("invalid evidence or wrong service fails before configuration change or drain", async t => {
  for (const field of ["invalid", "failGuard"]) { const f = fixture(t); f[field] = true; await assert.rejects(A.activate(f.options)); assert.deepEqual(fs.readFileSync(f.file), f.before); assert.ok(!f.calls.includes("drain")); }
});
test("duplicate, conflicting or inline key settings are preserved and rejected", () => {
  const base = `KAI_AKASHML_API_KEY_FILE=${A.VALUES.KAI_AKASHML_API_KEY_FILE}\n`;
  for (const extra of ["KAI_NATIVE_TOOL_MODELS=other\n", "KAI_AKASHML_API_KEY=secret\n", `KAI_NATIVE_TOOL_MODELS=${A.MODEL}\nKAI_NATIVE_TOOL_MODELS=${A.MODEL}\n`, "KAI_NATIVE_QUALIFICATION_FILE=/elsewhere\n"])
    assert.throws(() => A.desired(Buffer.from(base + extra)));
  const quoted = Buffer.from(`KAI_AKASHML_API_KEY_FILE="${A.VALUES.KAI_AKASHML_API_KEY_FILE}"\n`); assert.ok(A.desired(quoted).subarray(0, quoted.length).equals(quoted));
});
test("drain timeout makes no start and later clean exit resumes without another drain or backup", async t => {
  const f = fixture(t); f.failDrain = true; await assert.rejects(A.activate(f.options), /Drain timed out/); assert.ok(!f.calls.includes("start"));
  f.active = false; f.failDrain = false; await A.activate(f.options);
  assert.equal(f.calls.filter(x => x === "drain").length, 1); assert.equal(f.calls.filter(x => x === "start").length, 1);
  assert.equal(fs.readdirSync(f.work).filter(p => p.startsWith("kai-native-config-")).length, 1);
});
test("new runtime health failure preserves running process and retry only verifies", async t => {
  const f = fixture(t); f.failHealth = true; await assert.rejects(A.activate(f.options), /Health not ready/);
  f.failHealth = false; await A.activate(f.options); assert.equal(f.calls.filter(x => x === "start").length, 1); assert.equal(f.calls.filter(x => x === "drain").length, 1);
});
test("failed exit and concurrent config mutation never trigger a start", async t => {
  const f = fixture(t); f.active = false; f.exitCode = "1"; await assert.rejects(A.activate(f.options)); assert.deepEqual(fs.readFileSync(f.file), f.before);
  const g = fixture(t); g.changeOnDrain = true; await assert.rejects(A.activate(g.options), /Configuration changed/); assert.ok(!g.calls.includes("start")); assert.match(fs.readFileSync(g.file, "utf8"), /CONCURRENT=preserved/);
});
test("restart during drain and expired evidence after drain prevent activation", async t => {
  const f = fixture(t), drain = f.deps.drain; f.deps.drain = async args => { await drain(args); f.restarts = "1"; };
  await assert.rejects(A.activate(f.options), /Original clean process/); assert.ok(!f.calls.includes("start"));
  const g = fixture(t), other = g.deps.drain; g.deps.drain = async args => { await other(args); g.invalid = true; };
  await assert.rejects(A.activate(g.options), /Current qualification/); assert.ok(!g.calls.includes("start"));
});
test("shared lock, unprotected configuration and linked file refuse mutation", async t => {
  const f = fixture(t), lock = path.join(f.work, "code-update.lock"); fs.mkdirSync(lock); await assert.rejects(A.activate(f.options), /EEXIST/); assert.ok(fs.existsSync(lock)); assert.deepEqual(fs.readFileSync(f.file), f.before);
  const g = fixture(t); fs.chmodSync(g.file, 0o644); await assert.rejects(A.activate(g.options)); assert.deepEqual(fs.readFileSync(g.file), g.before);
  const h = fixture(t), target = path.join(h.work, "original"); fs.renameSync(h.file, target); fs.symlinkSync(target, h.file); await assert.rejects(A.activate(h.options)); assert.deepEqual(fs.readFileSync(target), h.before);
});
