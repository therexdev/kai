"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { update, health, assertCapabilities, BASE, INSTALLED, UNIT, REQUIRED } = require("./update-wallet-access");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-wallet-update-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), state: path.join(root, "state"), unit: path.join(root, UNIT) };
  for (const dir of [p.releases, p.config, p.state]) fs.mkdirSync(dir);
  const current = path.join(p.releases, INSTALLED[0]); fs.mkdirSync(current);
  const target = "b".repeat(40), calls = [], logs = [];
  const policy = path.join(p.config, "runtime.json"), keys = path.join(p.config, "runtime-keys.json"), accounts = path.join(p.state, "accounts.sqlite"), payments = path.join(p.state, "payments.sqlite"), devices = path.join(p.state, "provider-devices.sqlite");
  const originalPolicy = JSON.stringify({ mode: "mainnet-pilot", accountMode: "public", schedulerUrl: "https://credits.koinosai.com/scheduler", policyHash: "a".repeat(64), deployment: { product: "prepaid-usd-v1", chainId: "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", credits: "18QmSHrMszxmYPaDB1jxzY35vYDcG6aomN", creditsHash: "0x1220" + "b".repeat(64) } });
  fs.writeFileSync(policy, originalPolicy); fs.writeFileSync(keys, "private-fixture-key", { mode: 0o600 });
  fs.writeFileSync(accounts, "existing-accounts"); fs.writeFileSync(payments, "existing-payments");
  const unit = Buffer.from(`[Service]\nUser=kai-koin-prepaid\nGroup=kai-koin-prepaid\nWorkingDirectory=${current}\nExecStart=${process.execPath} ${current}/test-server.js\nEnvironment=KAI_KOIN_TEST_CONFIG_DIR=${p.config}\nEnvironment=KAI_KOIN_TEST_STATE_DIR=${p.state}\nEnvironment=KAI_KOIN_TEST_PORT=3109\nEnvironmentFile=${p.config}/account.env\nReadWritePaths=${p.state}\nReadOnlyPaths=${p.config}\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nUMask=0077\n`);
  fs.writeFileSync(p.unit, unit);
  let active = "active", changed = REQUIRED.join("\n"), dirty = "", failProbe = false, hook = () => {}, dropins = "";
  const run = (exe, args) => {
    calls.push([exe, ...args]); hook(exe, args);
    if (exe === "git") {
      if (args[0] === "rev-parse") return target;
      if (args[0] === "status") return dirty;
      if (args[0] === "diff") { assert.equal(args[2], BASE); return changed; }
      if (args[0] === "archive") fs.writeFileSync(args.find(a => a.startsWith("--output=")).slice(9), "source-fixture");
    }
    if (exe === process.execPath && args[0] === "--test" && failProbe) throw Error("Protocol probe failed");
    if (exe === "systemctl") {
      if (args[0] === "stop") active = "inactive";
      if (args[0] === "start") active = "active";
      if (args[0] === "show") return { WorkingDirectory: fs.readFileSync(p.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)[1], ActiveState: active, ExecMainStatus: "0", DropInPaths: dropins, FragmentPath: p.unit }[args.at(-1).split("=")[1]];
    }
    return "";
  };
  return { p, target, calls, logs, policy, keys, accounts, payments, devices, unit, run,
    options: { paths: p, run, log: s => logs.push(s), checkHealth: async () => {} },
    set changed(v) { changed = v; }, set dirty(v) { dirty = v; }, set failProbe(v) { failProbe = v; }, set hook(v) { hook = v; }, set dropins(v) { dropins = v; },
    preserved() { assert.equal(fs.readFileSync(policy, "utf8"), originalPolicy); assert.equal(fs.readFileSync(keys, "utf8"), "private-fixture-key"); assert.ok(!logs.join("\n").includes("private-fixture")); },
  };
}
test("wallet update preserves existing policy, keys and accounts, and rechecks installed capability without restarting twice", async t => {
  const f = fixture(t); let checks = 0;
  const options = { ...f.options, checkHealth: async o => { assert.equal(o.capabilities, true); checks++; } };
  const result = await update(options); assert.equal(result.commit, f.target); f.preserved();
  assert.equal(fs.readFileSync(f.accounts, "utf8"), "existing-accounts"); assert.equal(fs.readFileSync(f.payments, "utf8"), "existing-payments");
  assert.match(fs.readFileSync(f.p.unit, "utf8"), new RegExp(f.target));
  const probe = f.calls.findIndex(c => c[0] === process.execPath && c[1] === "--test"), stop = f.calls.findIndex(c => c[0] === "systemctl" && c[1] === "stop");
  assert.ok(probe >= 0 && stop > probe);
  assert.equal((await update(options)).unchanged, true); assert.equal(checks, 2);
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, 1);
  assert.equal(fs.existsSync(path.join(f.p.work, "kai-wallet-access-update.lock")), false);
});
test("readiness failure rolls back code while preserving newly created wallet identities, device credentials and payments", async t => {
  const f = fixture(t); const checked = [];
  await assert.rejects(update({ ...f.options, checkHealth: async o => {
    checked.push(o.capabilities);
    if (o.capabilities) { fs.writeFileSync(f.accounts, "old-and-new-wallet-account"); fs.writeFileSync(f.devices, "new-device-authority"); fs.writeFileSync(f.payments, "new-payment"); throw Error("New HTTPS capability absent"); }
  } }), /New HTTPS capability absent/);
  assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
  assert.equal(fs.readFileSync(f.accounts, "utf8"), "old-and-new-wallet-account"); assert.equal(fs.readFileSync(f.devices, "utf8"), "new-device-authority"); assert.equal(fs.readFileSync(f.payments, "utf8"), "new-payment");
  assert.deepEqual(checked, [true, false]);
});
test("dirty or unrelated source, failed probes, overrides and concurrent updater stop before a service mutation", async t => {
  for (const kind of ["dirty", "source", "probe", "override", "lock"]) {
    const f = fixture(t);
    if (kind === "dirty") f.dirty = " M lib/accounts.js";
    if (kind === "source") f.changed = REQUIRED.join("\n") + "\nlib/koin-network/reward-policy.js";
    if (kind === "probe") f.failProbe = true;
    if (kind === "override") f.dropins = "/etc/systemd/system/override.conf";
    if (kind === "lock") fs.mkdirSync(path.join(f.p.work, "kai-wallet-access-update.lock"));
    await assert.rejects(update(f.options));
    assert.equal(f.calls.some(c => c[0] === "systemctl" && ["stop", "start", "daemon-reload"].includes(c[1])), false); f.preserved();
  }
});
test("preparation failure leaves running code and every financial record untouched", async t => {
  const f = fixture(t); f.hook = exe => { if (exe === "npm") throw Error("Install unavailable"); };
  await assert.rejects(update(f.options), /Install unavailable/);
  assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "stop"), false);
});
test("a concurrent runtime edit during stop is preserved instead of overwritten by install or rollback", async t => {
  const f = fixture(t); f.hook = (exe, args) => { if (exe === "systemctl" && args[0] === "stop") fs.writeFileSync(f.policy, "operator-changed-policy"); };
  await assert.rejects(update(f.options), /Concurrent service configuration change/);
  assert.equal(fs.readFileSync(f.policy, "utf8"), "operator-changed-policy"); assert.deepEqual(fs.readFileSync(f.p.unit), f.unit);
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "start"), false);
});
test("a concurrent unit edit during failed health is not replaced by automatic rollback", async t => {
  const f = fixture(t); const otherUnit = Buffer.from("operator-edited-unit");
  await assert.rejects(update({ ...f.options, checkHealth: async () => { fs.writeFileSync(f.p.unit, otherUnit); throw Error("Health failed"); } }), /Health failed/);
  assert.deepEqual(fs.readFileSync(f.p.unit), otherUnit); assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, 1); f.preserved();
});
test("symlinked configuration and a changed state directory are rejected before service stop", async t => {
  for (const mode of ["symlink", "state"]) {
    const f = fixture(t);
    if (mode === "symlink") fs.symlinkSync(f.accounts, path.join(f.p.config, "unexpected-link"));
    else fs.writeFileSync(f.p.unit, f.unit.toString().replace("Environment=KAI_KOIN_TEST_STATE_DIR=" + f.p.state, "Environment=KAI_KOIN_TEST_STATE_DIR=/other/service"));
    await assert.rejects(update(f.options));
    assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "stop"), false);
  }
});
test("health requires both public capabilities and fresh mainnet serving on loopback and HTTPS", async () => {
  const origin = "https://credits.koinosai.com", chain = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", now = 1800000000000;
  const provider = { ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 } }, buyer = { ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", serviceOrigin: origin, schedulerUrl: origin + "/scheduler", target: { chainId: chain } } };
  const seen = [], fetchImpl = async url => { seen.push(url); const body = url.endsWith("/health") ? { mode: "mainnet-pilot", product: "prepaid-usd-v1", mainnetPaymentsEnabled: true, chainId: chain, lastSuccess: now } : url.includes("provider/device") ? provider : buyer; return { ok: true, text: async () => JSON.stringify(body) }; };
  await health({ fetchImpl, clock: () => now, timeoutMs: 0 }); assert.equal(seen.length, 6);
  assert.throws(() => assertCapabilities({ capabilities: {} }, buyer), /capabilities/);
  assert.throws(() => assertCapabilities(provider, { ...buyer, capabilities: { ...buyer.capabilities, freeOnlySessions: 0 } }), /capabilities/);
  assert.throws(() => assertCapabilities(provider, { ...buyer, capabilities: { ...buyer.capabilities, serviceOrigin: "https://wrong.invalid" } }), /capabilities/);
  await assert.rejects(health({ fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({}) }), clock: () => now, timeoutMs: 0 }), /heartbeat/);
});
