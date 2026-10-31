"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { repair, INSTALLED, FILES, LOCKS } = require("../deploy/koin-mainnet/repair-tokenizer-memory");
const UNIT = "kai-koin-prepaid.service";
function fixture(t, installed = INSTALLED[0]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-memory-repair-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), state: path.join(root, "state"), unit: path.join(root, UNIT) };
  for (const dir of [p.releases, p.config, p.state]) fs.mkdirSync(dir);
  const current = path.join(p.releases, installed); fs.mkdirSync(current);
  const target = "b".repeat(40), calls = [], logs = [];
  const runtime = Buffer.from(JSON.stringify({ mode: "mainnet-pilot", accountMode: "public", schedulerUrl: "https://credits.koinosai.com/scheduler", policyHash: "a".repeat(64),
    deployment: { product: "prepaid-usd-v1", chainId: "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", credits: "18QmSHrMszxmYPaDB1jxzY35vYDcG6aomN", creditsHash: "0x1220" + "b".repeat(64) } }));
  fs.writeFileSync(path.join(p.config, "runtime.json"), runtime, { mode: 0o640 });
  fs.writeFileSync(path.join(p.config, "runtime-keys.json"), "fixture-private", { mode: 0o600 });
  fs.writeFileSync(path.join(p.state, "credits.sqlite"), "current-credit-records");
  const unit = Buffer.from(`[Unit]\nDescription=fixture\n[Service]\nUser=kai-koin-prepaid\nGroup=kai-koin-prepaid\nWorkingDirectory=${current}\nExecStart=${process.execPath} ${current}/test-server.js\nEnvironment=KAI_KOIN_TEST_CONFIG_DIR=${p.config}\nEnvironment=KAI_KOIN_TEST_STATE_DIR=${p.state}\nEnvironment=KAI_KOIN_TEST_PORT=3109\nEnvironmentFile=${p.config}/account.env\nReadWritePaths=${p.state}\nReadOnlyPaths=${p.config}\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nUMask=0077\n`);
  fs.writeFileSync(p.unit, unit, { mode: 0o644 });
  let active = "activating", pid = "100", dirty = "", dropins = "", changed = FILES.join("\n"), hook = () => {};
  const run = (exe, args) => {
    calls.push([exe, ...args]); hook(exe, args);
    if (exe === "git") {
      if (args[0] === "rev-parse") return target;
      if (args[0] === "status") return dirty;
      if (args[0] === "diff") return changed;
      if (args[0] === "archive") fs.writeFileSync(args.find(a => a.startsWith("--output=")).slice(9), "fixture-source");
    }
    if (exe === "systemctl") {
      if (args[0] === "stop") { active = "failed"; pid = "0"; }
      if (args[0] === "start") { active = "active"; pid = "200"; }
      if (args[0] === "show") return { WorkingDirectory: fs.readFileSync(p.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)[1], ActiveState: active,
        MainPID: pid, ExecMainStatus: "6", FragmentPath: p.unit, DropInPaths: dropins }[args.at(-1).split("=")[1]];
    }
    return "";
  };
  return { p, target, unit, calls, logs, options: { paths: p, run, log: s => logs.push(s), checkHealth: async () => {},
    reviewRuntime: bytes => ({ already: true, bytes, review: { models: [], catalogPolicyHash: "c".repeat(64) } }) },
    set hook(v) { hook = v; }, set dirty(v) { dirty = v; }, set dropins(v) { dropins = v; }, set changed(v) { changed = v; },
    preserved() {
      assert.deepEqual(fs.readFileSync(path.join(p.config, "runtime.json")), runtime);
      assert.equal(fs.readFileSync(path.join(p.config, "runtime-keys.json"), "utf8"), "fixture-private");
      assert.equal(fs.readFileSync(path.join(p.state, "credits.sqlite"), "utf8"), "current-credit-records");
      assert.ok(!logs.join("\n").includes("fixture-private"));
      for (const lock of LOCKS) assert.equal(fs.existsSync(path.join(p.work, lock)), false);
    } };
}
test("repair accepts the OOM restart loop, preflights after stopping and preserves financial/configuration bytes", async t => {
  for (const installed of INSTALLED) {
    const f = fixture(t, installed); const result = await repair(f.options); f.preserved(); assert.equal(result.commit, f.target);
    const stop = f.calls.findIndex(c => c[0] === "systemctl" && c[1] === "stop"), preflight = f.calls.findIndex(c => c[0] === "runuser"), start = f.calls.findIndex(c => c[0] === "systemctl" && c[1] === "start");
    assert.ok(stop >= 0 && preflight > stop && start > preflight); assert.ok(f.calls[preflight].includes("--max-old-space-size=768"));
    assert.deepEqual(fs.readFileSync(path.join(result.backup, "previous.service")), f.unit);
    assert.equal(fs.statSync(f.p.unit).mode & 0o777, 0o644);
    assert.equal((await repair(f.options)).unchanged, true); f.preserved();
    assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "start").length, 1);
  }
});
test("failed memory preflight leaves the original unit intact and never starts unverified code", async t => {
  const f = fixture(t); f.hook = exe => { if (exe === "runuser") throw Error("memory preflight failed"); };
  await assert.rejects(repair(f.options), /memory preflight/); f.preserved(); assert.deepEqual(fs.readFileSync(f.p.unit), f.unit);
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "start"), false);
});
test("health failure keeps forward-compatible code and current credit records", async t => {
  const f = fixture(t); await assert.rejects(repair({ ...f.options, checkHealth: async () => { throw Error("health unavailable"); } }), /health unavailable/);
  f.preserved(); assert.ok(fs.readFileSync(f.p.unit, "utf8").includes(f.target));
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "start").length, 1);
});
test("unrelated source changes, local edits and service overrides are rejected before stopping", async t => {
  for (const [key, value] of [["changed", FILES.join("\n") + "\nlib/accounts.js"], ["dirty", "M test-server.js"], ["dropins", "/custom.conf"]]) {
    const f = fixture(t); f[key] = value; await assert.rejects(repair(f.options)); f.preserved();
    assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "stop"), false);
  }
});
test("concurrent configuration changes stop the repair without overwriting them", async t => {
  const f = fixture(t); f.hook = exe => { if (exe === "npm") fs.writeFileSync(path.join(f.p.config, "operator-change"), "preserve"); };
  await assert.rejects(repair(f.options), /Configuration changed/); f.preserved();
  assert.equal(fs.readFileSync(path.join(f.p.config, "operator-change"), "utf8"), "preserve");
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "stop"), false);
});
