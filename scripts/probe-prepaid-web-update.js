"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { update, OLD, UNIT, replacementUnit } = require("../deploy/koin-mainnet/update-prepaid-web");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-web-update-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), unit: path.join(root, UNIT) };
  fs.mkdirSync(paths.releases); fs.mkdirSync(paths.config); fs.mkdirSync(path.join(root, "state"));
  fs.writeFileSync(path.join(paths.config, "runtime-keys.json"), "private-fixture-preserved", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "state/accounts.sqlite"), "existing-account");
  fs.writeFileSync(path.join(root, "state/payments.sqlite"), "pending-payment");
  const target = "a".repeat(40), oldDir = path.join(paths.releases, OLD);
  const unit = Buffer.from(`[Service]\nWorkingDirectory=${oldDir}\nExecStart=/usr/bin/node ${oldDir}/test-server.js\nEnvironmentFile=/etc/kai-koin-prepaid/account.env\nReadWritePaths=/var/lib/kai-koin-prepaid\n`);
  fs.writeFileSync(paths.unit, unit); const calls = [], logs = []; let active = "active", changed = "test-server.js\npublic/account.html\nlib/credit-account-web.js";
  const run = (exe, args) => {
    calls.push([exe, ...args]);
    if (exe === "git") {
      if (args[0] === "rev-parse") return target;
      if (args[0] === "status") return "";
      if (args[0] === "diff") return changed;
      if (args[0] === "archive") { fs.writeFileSync(args.find(a => a.startsWith("--output=")).slice(9), "source"); return ""; }
    }
    if (exe === "systemctl") {
      if (args[0] === "stop") { active = "inactive"; return ""; }
      if (args[0] === "start") { active = "active"; return ""; }
      if (args[0] === "show") {
        const key = args.at(-1).split("=")[1];
        return { WorkingDirectory: fs.readFileSync(paths.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)[1], ActiveState: active, FragmentPath: paths.unit, DropInPaths: "", ExecMainStatus: "0" }[key];
      }
    }
    return "";
  };
  const preserved = () => {
    assert.equal(fs.readFileSync(path.join(paths.config, "runtime-keys.json"), "utf8"), "private-fixture-preserved");
    assert.equal(fs.readFileSync(path.join(root, "state/accounts.sqlite"), "utf8"), "existing-account");
    assert.equal(fs.readFileSync(path.join(root, "state/payments.sqlite"), "utf8"), "pending-payment");
    assert.ok(!logs.join("\n").includes("private-fixture"));
  };
  return { paths, target, oldDir, unit, calls, logs, run, preserved, set changed(value) { changed = value; } };
}
test("web update replaces only code pointers and preserves private configuration, accounts and payments", async t => {
  const f = fixture(t); let checks = 0;
  const args = { paths: f.paths, run: f.run, log: s => f.logs.push(s), checkHealth: async () => { checks++; } };
  await update(args); f.preserved();
  assert.equal(fs.readFileSync(f.paths.unit, "utf8"), replacementUnit(f.unit, f.oldDir, path.join(f.paths.releases, f.target)).toString());
  assert.equal(checks, 1);
  const stops = f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length;
  await update(args); assert.equal(checks, 2); assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, stops);
});
test("failed web health restores the previous code without restoring old databases", async t => {
  const f = fixture(t);
  await assert.rejects(update({ paths: f.paths, run: f.run, log: s => f.logs.push(s), checkHealth: async () => { throw Error("HTTPS unavailable"); } }), /HTTPS unavailable/);
  assert.deepEqual(fs.readFileSync(f.paths.unit), f.unit); f.preserved();
  assert.ok(f.logs.some(s => s.includes("Previous code restored")));
});
test("unrelated source changes are refused before any service action", async t => {
  const f = fixture(t); f.changed = "test-server.js\nlib/accounts.js";
  await assert.rejects(update({ paths: f.paths, run: f.run }), /only the reviewed web-page/);
  assert.equal(f.calls.some(c => c[0] === "systemctl"), false); f.preserved();
  assert.throws(() => replacementUnit(Buffer.from("[Service]\nExecStart=/other/program\n"), f.oldDir, "/new"), /Unexpected service/);
});
