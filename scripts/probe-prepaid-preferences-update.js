"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { update, PREFERENCES, UNIT } = require("../deploy/koin-mainnet/update-prepaid-web");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-preferences-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), unit: path.join(root, UNIT) };
  fs.mkdirSync(paths.releases); fs.mkdirSync(paths.config);
  fs.writeFileSync(path.join(paths.config, "runtime.json"), "reviewed-policy-preserved");
  fs.writeFileSync(path.join(paths.config, "runtime-keys.json"), "private-fixture", { mode: 0o600 });
  const ledger = path.join(root, "ledger.sqlite"); fs.writeFileSync(ledger, "existing-credits");
  const target = "b".repeat(40), oldDir = path.join(paths.releases, PREFERENCES.installedBase);
  const unit = Buffer.from(`[Service]\nWorkingDirectory=${oldDir}\nExecStart=/usr/bin/node ${oldDir}/test-server.js\nReadWritePaths=/var/lib/kai-koin-prepaid\n`);
  fs.writeFileSync(paths.unit, unit);
  const calls = []; let active = "active", changed = PREFERENCES.required.join("\n"), failProbe = false;
  const run = (exe, args) => {
    calls.push([exe, ...args]);
    if (exe === "git") {
      if (args[0] === "rev-parse") return target;
      if (args[0] === "status") return "";
      if (args[0] === "diff") { assert.equal(args[2], PREFERENCES.base); return changed; }
      if (args[0] === "archive") fs.writeFileSync(args.find(a => a.startsWith("--output=")).slice(9), "fixture-source");
    }
    if (exe === process.execPath && args[0] === "--test" && failProbe) throw Error("Preference regression failed");
    if (exe === "systemctl") {
      if (args[0] === "stop") active = "inactive";
      if (args[0] === "start") active = "active";
      if (args[0] === "show") return { WorkingDirectory: fs.readFileSync(paths.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)[1], ActiveState: active,
        FragmentPath: paths.unit, DropInPaths: "", ExecMainStatus: "0" }[args.at(-1).split("=")[1]];
    }
    return "";
  };
  const preserved = () => {
    assert.equal(fs.readFileSync(path.join(paths.config, "runtime.json"), "utf8"), "reviewed-policy-preserved");
    assert.equal(fs.readFileSync(path.join(paths.config, "runtime-keys.json"), "utf8"), "private-fixture");
  };
  return { paths, ledger, target, unit, calls, run, preserved, set changed(v) { changed = v; }, set failProbe(v) { failProbe = v; } };
}
test("preference update uses deployed dependency baseline, preserves settings and money, and is idempotent", async t => {
  const f = fixture(t), options = { paths: f.paths, run: f.run, kind: "preferences", checkHealth: async () => {}, log() {} };
  await update(options); f.preserved();
  assert.equal(fs.readFileSync(f.ledger, "utf8"), "existing-credits");
  assert.match(fs.readFileSync(f.paths.unit, "utf8"), new RegExp(f.target));
  const probe = f.calls.findIndex(c => c[0] === process.execPath && c[1] === "--test");
  const stop = f.calls.findIndex(c => c[0] === "systemctl" && c[1] === "stop");
  assert.ok(probe >= 0 && stop > probe);
  await update(options);
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, 1);
});
test("preference update refuses unrelated source and failed accounting checks before stopping", async t => {
  const f = fixture(t); f.changed = [...PREFERENCES.required, "lib/accounts.js"].join("\n");
  await assert.rejects(update({ paths: f.paths, run: f.run, kind: "preferences" }), /only the reviewed credit-preference/);
  f.changed = PREFERENCES.required.join("\n"); f.failProbe = true;
  await assert.rejects(update({ paths: f.paths, run: f.run, kind: "preferences" }), /Preference regression failed/);
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "stop"), false); f.preserved();
});
test("failed preference health restores code only, retaining newly written payments and usage", async t => {
  const f = fixture(t);
  await assert.rejects(update({ paths: f.paths, run: f.run, kind: "preferences", log() {}, checkHealth: async () => {
    fs.writeFileSync(f.ledger, "new-paid-first-usage-and-payment"); throw Error("Health failed");
  } }), /Health failed/);
  assert.deepEqual(fs.readFileSync(f.paths.unit), f.unit); f.preserved();
  assert.equal(fs.readFileSync(f.ledger, "utf8"), "new-paid-first-usage-and-payment");
});
