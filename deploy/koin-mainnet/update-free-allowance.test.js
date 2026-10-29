"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { update, health, BASE, PRIOR_RELEASES, UNIT, REQUIRED } = require("./update-free-allowance");
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", ORIGIN = "https://credits.koinosai.com";
function fixture(t, prior = BASE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-quote-update-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), state: path.join(root, "state"), unit: path.join(root, UNIT) };
  for (const dir of [p.releases, p.config, p.state]) fs.mkdirSync(dir);
  const current = path.join(p.releases, prior); fs.mkdirSync(current);
  const target = "b".repeat(40), calls = [], logs = [];
  const policy = path.join(p.config, "runtime.json"), keys = path.join(p.config, "runtime-keys.json");
  const originalPolicy = JSON.stringify({ mode: "mainnet-pilot", accountMode: "public", schedulerUrl: ORIGIN + "/scheduler", policyHash: "a".repeat(64),
    purchaseQuoteBudget: { schema: 1, dailyQuoteAuthorizationUsdAtoms: "100000000", accountDailyQuoteAuthorizationUsdAtoms: "100000000" },
    deployment: { product: "prepaid-usd-v1", chainId: CHAIN, credits: "18QmSHrMszxmYPaDB1jxzY35vYDcG6aomN", creditsHash: "0x1220" + "b".repeat(64) } });
  fs.writeFileSync(policy, originalPolicy); fs.chmodSync(policy, 0o640); fs.writeFileSync(keys, "private-fixture-key", { mode: 0o600 });
  const records = Object.fromEntries(["accounts.sqlite", "payments.sqlite", "reward-journal.sqlite", "purchase-quotes.sqlite", "quote-anchor"].map(name => [name, path.join(p.state, name)]));
  for (const [name, file] of Object.entries(records)) fs.writeFileSync(file, "existing:" + name);
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
    if (exe === process.execPath && args[0] === "--test" && failProbe) throw Error("Quote probe failed");
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
test("free allowance update preserves configuration, keys and every journal byte while replacing code, and repeats without a restart", async t => {
  const f = fixture(t); let checks = 0;
  const options = { ...f.options, checkHealth: async o => { assert.equal(o.summary, true); assert.equal(o.expected.chainId, CHAIN); checks++; } };
  assert.equal((await update(options)).commit, f.target); f.preserved();
  for (const [name, file] of Object.entries(f.records)) assert.equal(fs.readFileSync(file, "utf8"), "existing:" + name);
  assert.match(fs.readFileSync(f.p.unit, "utf8"), new RegExp(f.target));
  const probe = f.calls.findIndex(c => c[0] === process.execPath && c[1] === "--test"), stop = f.calls.findIndex(c => c[0] === "systemctl" && c[1] === "stop");
  assert.ok(probe >= 0 && stop > probe);
  assert.equal((await update(options)).unchanged, true); assert.equal(checks, 2);
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, 1);
  assert.equal(fs.existsSync(path.join(f.p.work, "kai-reward-summary-update.lock")), false);
});
test("failed new health restores only code, retains new accounts, credits, quote history and anchors, and allows exact retry", async t => {
  const f = fixture(t), checked = [];
  await assert.rejects(update({ ...f.options, checkHealth: async o => {
    checked.push(o.summary);
    if (o.summary) { for (const [name, file] of Object.entries(f.records)) fs.writeFileSync(file, "new:" + name); throw Error("Public daily summarys not active"); }
  } }), /Public daily summarys not active/);
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
    if (kind === "lock") fs.mkdirSync(path.join(f.p.work, "kai-reward-summary-update.lock"));
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
  assert.equal(fs.readdirSync(f.p.releases).some(name => name.startsWith(".reward-summary-")), false);
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
test("reward summary health verifies the capability on loopback and public HTTPS", async () => {
  const now = 1800000000000;
  const provider = { ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 } }, buyer = { ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", serviceOrigin: ORIGIN, schedulerUrl: ORIGIN + "/scheduler", target: { chainId: CHAIN } } };
  for (const absentAt of [null, "http://127.0.0.1:3109", ORIGIN]) {
    const seen = [], fetchImpl = async url => {
      seen.push(url);
      const body = url.endsWith("/health") ? { mode: "mainnet-pilot", product: "prepaid-usd-v1", mainnetPaymentsEnabled: true, chainId: CHAIN, lastSuccess: now, freeAllowanceRefreshVersion: (!absentAt || !url.startsWith(absentAt)) ? 1 : 0, rewardSummaryVersion: 1 } : url.includes("provider/device") ? provider : buyer;
      return { ok: true, text: async () => JSON.stringify(body) };
    };
    const options = { fetchImpl, clock: () => now, timeoutMs: 0 };
    if (absentAt) await assert.rejects(health(options), /Free allowance refresh/);
    else { await health(options); assert.equal(seen.length, 6); }
    await health({ ...options, summary: false });
  }
});

test("free allowance update accepts either exact prior reward-summary release", async t => {
  for (const prior of PRIOR_RELEASES.slice(1)) {
    const f = fixture(t, prior); assert.equal((await update(f.options)).installed, true); f.preserved();
  }
});
