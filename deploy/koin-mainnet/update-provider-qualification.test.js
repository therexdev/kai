"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { update, health, BASE, UNIT, REQUIRED } = require("./update-provider-qualification");
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", ORIGIN = "https://credits.koinosai.com";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-recovery-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), state: path.join(root, "state"), unit: path.join(root, UNIT) };
  for (const dir of [p.releases, p.config, p.state]) fs.mkdirSync(dir);
  const current = path.join(p.releases, BASE); fs.mkdirSync(current);
  const target = "b".repeat(40), calls = [], logs = [];
  const policy = path.join(p.config, "runtime.json"), keys = path.join(p.config, "runtime-keys.json");
  const originalPolicy = JSON.stringify({ mode: "mainnet-pilot", accountMode: "public", schedulerUrl: ORIGIN + "/scheduler", policyHash: "a".repeat(64),
    purchaseQuoteBudget: { schema: 1, dailyQuoteAuthorizationUsdAtoms: "100000000", accountDailyQuoteAuthorizationUsdAtoms: "100000000" },
    qualificationPolicies: [{ model: "koinos-smart", minPass: 12, maxLatencyMs: 30000, reviewedEvidenceHash: "reviewed-before-update" }],
    deployment: { product: "prepaid-usd-v1", chainId: CHAIN, credits: "18QmSHrMszxmYPaDB1jxzY35vYDcG6aomN", creditsHash: "0x1220" + "b".repeat(64) } });
  fs.writeFileSync(policy, originalPolicy); fs.chmodSync(policy, 0o640); fs.writeFileSync(keys, "private-fixture-key", { mode: 0o600 });
  const records = Object.fromEntries(["accounts.sqlite", "payments.sqlite", "reward-journal.sqlite", "purchase-quotes.sqlite", "quote-anchor", "automatic-qualification.json.models/smart.json", "qualification-evidence/existing-signed-results.json", "provider-devices/devices.sqlite"].map(name => [name, path.join(p.state, name)]));
  for (const [name, file] of Object.entries(records)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "existing:" + name); }
  const unit = Buffer.from(`[Service]\nUser=kai-koin-prepaid\nGroup=kai-koin-prepaid\nWorkingDirectory=${current}\nExecStart=${process.execPath} ${current}/test-server.js\nEnvironment=KAI_KOIN_TEST_CONFIG_DIR=${p.config}\nEnvironment=KAI_KOIN_TEST_STATE_DIR=${p.state}\nEnvironment=KAI_KOIN_TEST_PORT=3109\nEnvironmentFile=${p.config}/account.env\nReadWritePaths=${p.state}\nReadOnlyPaths=${p.config}\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nUMask=0077\n`);
  fs.writeFileSync(p.unit, unit);
  let active = "active", changed = REQUIRED.join("\n"), dirty = "", failProbe = false, hook = () => {}, dropins = "", stopStatus = "0";
  const run = (exe, args) => {
    calls.push([exe, ...args]); hook(exe, args);
    if (exe === "git") {
      if (args[0] === "rev-parse") return target;
      if (args[0] === "status") return dirty;
      if (args[0] === "diff") { assert.equal(args[2], BASE); return changed; }
      if (args[0] === "archive") fs.writeFileSync(args.find(a => a.startsWith("--output=")).slice(9), "source-fixture");
    }
    if (exe === process.execPath && args[0] === "--test" && failProbe) throw Error("Provider recovery probe failed");
    if (exe === "systemctl") {
      if (args[0] === "stop") active = "inactive";
      if (args[0] === "start") active = "active";
      if (args[0] === "show") return { WorkingDirectory: fs.readFileSync(p.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)?.[1], ActiveState: active, ExecMainStatus: stopStatus, DropInPaths: dropins, FragmentPath: p.unit }[args.at(-1).split("=")[1]];
    }
    return "";
  };
  return { p, target, calls, logs, policy, keys, records, unit, run,
    options: { paths: p, run, log: s => logs.push(s), checkHealth: async () => {} },
    set changed(v) { changed = v; }, set dirty(v) { dirty = v; }, set failProbe(v) { failProbe = v; }, set hook(v) { hook = v; }, set dropins(v) { dropins = v; }, set stopStatus(v) { stopStatus = v; },
    preserved() { assert.equal(fs.readFileSync(policy, "utf8"), originalPolicy); assert.equal(fs.statSync(policy).mode & 0o777, 0o640); assert.equal(fs.readFileSync(keys, "utf8"), "private-fixture-key"); assert.ok(!logs.join("\n").includes("private-fixture")); },
  };
}
test("provider recovery preserves qualification policy, limits, keys and every journal byte while replacing code, and repeats without a restart", async t => {
  const f = fixture(t); let checks = 0;
  const options = { ...f.options, checkHealth: async o => { assert.equal(o.recovery, true); assert.equal(o.expected.chainId, CHAIN); checks++; } };
  assert.equal((await update(options)).commit, f.target); f.preserved();
  for (const [name, file] of Object.entries(f.records)) assert.equal(fs.readFileSync(file, "utf8"), "existing:" + name);
  assert.match(fs.readFileSync(f.p.unit, "utf8"), new RegExp(f.target));
  const probe = f.calls.findIndex(c => c[0] === process.execPath && c[1] === "--test"), stop = f.calls.findIndex(c => c[0] === "systemctl" && c[1] === "stop");
  assert.ok(probe >= 0 && stop > probe);
  assert.equal((await update(options)).unchanged, true); assert.equal(checks, 2);
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, 1);
  assert.equal(fs.existsSync(path.join(f.p.work, "kai-provider-qualification-update.lock")), false);
});
test("failed recovery health restores only code, retains new payments and qualification evidence, and permits an exact retry", async t => {
  const f = fixture(t), checked = [];
  await assert.rejects(update({ ...f.options, checkHealth: async o => {
    checked.push(o.recovery);
    if (o.recovery) { for (const [name, file] of Object.entries(f.records)) fs.writeFileSync(file, "new:" + name); throw Error("Public provider recovery not active"); }
  } }), /Public provider recovery not active/);
  assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
  for (const [name, file] of Object.entries(f.records)) assert.equal(fs.readFileSync(file, "utf8"), "new:" + name);
  assert.deepEqual(checked, [true, false]); assert.equal(fs.existsSync(path.join(f.p.releases, f.target)), false);
  assert.equal((await update(f.options)).installed, true);
});
test("unreviewed source, failed probes, dirty checkout, overrides, identity changes and a concurrent updater cannot stop the service", async t => {
  for (const kind of ["dirty", "source", "probe", "override", "lock", "identity"]) {
    const f = fixture(t);
    if (kind === "dirty") f.dirty = " M lib/accounts.js";
    if (kind === "source") f.changed = REQUIRED.join("\n") + "\nlib/koin-network/reward-policy.js";
    if (kind === "probe") f.failProbe = true;
    if (kind === "override") f.dropins = "/etc/systemd/system/override.conf";
    if (kind === "lock") fs.mkdirSync(path.join(f.p.work, "kai-provider-qualification-update.lock"));
    if (kind === "identity") fs.writeFileSync(f.p.unit, f.unit.toString().replace("User=kai-koin-prepaid", "User=root"));
    await assert.rejects(update(f.options));
    assert.equal(f.calls.some(c => c[0] === "systemctl" && ["stop", "start", "daemon-reload"].includes(c[1])), false); f.preserved();
  }
});
test("dependency preparation failure keeps the old service running and permits an exact retry", async t => {
  const f = fixture(t); f.hook = exe => { if (exe === "npm") throw Error("Install unavailable"); };
  await assert.rejects(update(f.options), /Install unavailable/);
  assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "stop"), false);
  assert.equal(fs.existsSync(path.join(f.p.releases, f.target)), false);
  assert.equal(fs.readdirSync(f.p.releases).some(name => name.startsWith(".provider-qualification-")), false);
  f.hook = () => {}; assert.equal((await update(f.options)).installed, true);
});
test("concurrent configuration and unit changes survive failed activation or rollback", async t => {
  for (const change of ["configuration", "unit"]) {
    const f = fixture(t);
    if (change === "configuration") f.hook = (exe, args) => { if (exe === "systemctl" && args[0] === "stop") fs.writeFileSync(f.policy, "operator-changed-policy"); };
    const options = change === "unit" ? { ...f.options, checkHealth: async () => { fs.writeFileSync(f.p.unit, "operator-changed-unit"); throw Error("Health failed"); } } : f.options;
    await assert.rejects(update(options));
    if (change === "configuration") { assert.equal(fs.readFileSync(f.policy, "utf8"), "operator-changed-policy"); assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); }
    else { assert.equal(fs.readFileSync(f.p.unit, "utf8"), "operator-changed-unit"); f.preserved(); }
    assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, 1);
  }
});
test("unit persistence failures before and after rename recover old code without losing the retry path", async t => {
  for (const failedFlush of [2, 3]) {
    const f = fixture(t), sync = fs.fsyncSync; let flushes = 0;
    fs.fsyncSync = fd => { if (++flushes === failedFlush) throw Error("Injected unit persistence failure"); return sync(fd); };
    try { await assert.rejects(update(f.options), /Injected unit persistence failure/); }
    finally { fs.fsyncSync = sync; }
    assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
    assert.equal(fs.existsSync(path.join(f.p.releases, f.target)), false);
    assert.equal((await update(f.options)).installed, true);
  }
});
test("provider recovery health requires the active qualifier and existing unlimited purchase behavior on both loopback and HTTPS", async () => {
  const now = 1800000000000;
  const provider = { ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 } }, buyer = { ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", serviceOrigin: ORIGIN, schedulerUrl: ORIGIN + "/scheduler", target: { chainId: CHAIN } } };
  for (const absentAt of [null, "http://127.0.0.1:3109", ORIGIN]) {
    const seen = [], fetchImpl = async url => {
      seen.push(url);
      const body = url.endsWith("/health") ? { mode: "mainnet-pilot", product: "prepaid-usd-v1", mainnetPaymentsEnabled: true, chainId: CHAIN, lastSuccess: now, purchaseQuotesUnlimited: true, providerQualificationRecovery: absentAt && url.startsWith(absentAt) ? 0 : 1 } : url.includes("provider/device") ? provider : buyer;
      return { ok: true, text: async () => JSON.stringify(body) };
    };
    const options = { fetchImpl, clock: () => now, timeoutMs: 0 };
    if (absentAt) await assert.rejects(health(options), /Provider qualification recovery is not active/);
    else { await health(options); assert.equal(seen.length, 6); }
    // A failed activation may return to b853, whose health lacks the new
    // qualifier marker, but existing buyer/provider capabilities still verify.
    await health({ ...options, recovery: false });
  }
  for (const recovery of [true, false]) await assert.rejects(health({ recovery, clock: () => now, timeoutMs: 0,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ purchaseQuotesUnlimited: false, providerQualificationRecovery: 1 }) }) }), /unlimited purchase quotes/);
});
test("public health advertises recovery only for the active implementation and exposes no qualifier evidence", async t => {
  const http = require("node:http"), { createHandler } = require("../../test-server");
  const config = { mode: "mainnet-pilot", schedulerUrl: ORIGIN + "/scheduler", deployment: { chainId: CHAIN, product: "prepaid-usd-v1", credits: "18QmSHrMszxmYPaDB1jxzY35vYDcG6aomN" } };
  const runtime = { prepaid: true, lastServing: Date.now(), qualifier: { recoveryVersion: 1, state: { signature: "private-fixture-evidence" } } };
  const server = http.createServer(createHandler({ config, runtime, secret: "a".repeat(64) }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = "http://127.0.0.1:" + server.address().port + "/health";
  const response = await fetch(url), value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.providerQualificationRecovery, 1); assert.equal(value.purchaseQuotesUnlimited, true);
  assert.equal(JSON.stringify(value).includes("private-fixture-evidence"), false);
  runtime.qualifier = {}; assert.equal((await fetch(url).then(r => r.json())).providerQualificationRecovery, 0);
  delete runtime.qualifier; assert.equal((await fetch(url).then(r => r.json())).providerQualificationRecovery, 0);
});
