"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { update, health, gracefulShutdown, progress, BASE, PRIOR_RELEASES, UNIT, REQUIRED } = require("./update-reward-runtime");
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", ORIGIN = "https://credits.koinosai.com";
function fixture(t, prior = BASE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-reward-progress-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  let active = "active", changed = REQUIRED.join("\n"), dirty = "", failProbe = false, hook = () => {}, dropins = "", stopStatus = "0", stopPid = "0", pid = "42", execPid = "42", restarts = "0", result = "success", exitCode = "1", signalMode = "normal";
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
      if (args[0] === "kill") {
        assert.deepEqual(args, ["kill", "--kill-whom=main", "--signal=SIGTERM", UNIT]);
        if (signalMode === "default-signal") { active = "inactive"; pid = "0"; stopStatus = "15"; exitCode = "2"; result = "success"; }
        else if (signalMode === "restart") { pid = execPid = "43"; restarts = String(Number(restarts) + 1); }
        else if (signalMode !== "survives") {
          active = stopStatus === "0" ? "inactive" : "failed"; pid = stopPid;
          result = stopStatus === "0" ? "success" : "exit-code";
        }
      }
      if (args[0] === "start") { active = "active"; pid = execPid = String(Number(execPid) + 1); stopStatus = "0"; result = "success"; exitCode = "1"; }
      if (args[0] === "show") {
        const state = { WorkingDirectory: fs.readFileSync(p.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)?.[1], ActiveState: active,
          ExecMainStatus: stopStatus, ExecMainCode: exitCode, ExecMainPID: execPid, MainPID: pid, NRestarts: restarts,
          Result: result, DropInPaths: dropins, FragmentPath: p.unit };
        const requested = args.at(-1).split("=")[1];
        return requested.includes(",") ? requested.split(",").map(k => k + "=" + state[k]).join("\n") : state[requested];
      }
    }
    return "";
  };
  return { p, target, calls, logs, policy, keys, records, unit, run,
    options: { paths: p, run, log: s => logs.push(s), checkHealth: async () => {}, reportProgress: async () => {}, drainOptions: { timeoutMs: 5, wait: async () => {} } },
    set changed(v) { changed = v; }, set dirty(v) { dirty = v; }, set failProbe(v) { failProbe = v; }, set hook(v) { hook = v; }, set dropins(v) { dropins = v; }, set stopStatus(v) { stopStatus = v; },
    get active() { return active; }, set active(v) { active = v; }, set stopPid(v) { stopPid = v; }, set signalMode(v) { signalMode = v; }, set restarts(v) { restarts = v; }, set pid(v) { pid = execPid = v; },
    preserved() { assert.equal(fs.readFileSync(policy, "utf8"), originalPolicy); assert.equal(fs.statSync(policy).mode & 0o777, 0o640); assert.equal(fs.readFileSync(keys, "utf8"), "private-fixture-key"); assert.ok(!logs.join("\n").includes("private-fixture")); },
  };
}
test("Reward runtime update preserves configuration, keys and every journal byte while replacing code, and repeats without a restart", async t => {
  const f = fixture(t); let checks = 0;
  const allowance = path.join(f.p.config, "claim-sponsorship.json");
  const savedAllowance = '{"schema":1,"ledgerIdentityHash":"fixture","maxRcPerDay":"12500000000"}';
  fs.writeFileSync(allowance, savedAllowance, { mode: 0o640 });
  // Fixture setup must match installed permissions even under the CLI's 0077 umask.
  fs.chmodSync(allowance, 0o640);
  const options = { ...f.options, checkHealth: async o => { assert.equal(o.summary, true); assert.equal(o.expected.chainId, CHAIN); checks++; } };
  assert.equal((await update(options)).commit, f.target); f.preserved();
  for (const [name, file] of Object.entries(f.records)) assert.equal(fs.readFileSync(file, "utf8"), "existing:" + name);
  assert.match(fs.readFileSync(f.p.unit, "utf8"), new RegExp(f.target));
  const probe = f.calls.findIndex(c => c[0] === process.execPath && c[1] === "--test"), stop = f.calls.findIndex(c => c[0] === "systemctl" && c[1] === "kill");
  assert.ok(probe >= 0 && stop > probe);
  assert.ok(f.calls[probe].includes("--test-concurrency=1"));
  const preflight = f.calls.findIndex(c => c[0] === "runuser" && c.some(a => String(a).endsWith("/check-rpc-recovery.js")));
  assert.ok(preflight > probe && preflight < stop);
  assert.equal(f.calls[preflight].at(-1), f.policy);
  assert.equal(fs.readFileSync(allowance, "utf8"), savedAllowance);
  assert.equal(fs.statSync(allowance).mode & 0o777, 0o640);
  assert.equal((await update(options)).unchanged, true); assert.equal(checks, 2);
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "kill").length, 1);
  assert.equal(fs.existsSync(path.join(f.p.work, "kai-reward-progress-update.lock")), false);
});
test("failed live transport verification never stops the old service and permits exact retry", async t => {
  const f = fixture(t);
  f.hook = (exe, args) => {
    if (exe === "runuser" && args.some(a => String(a).endsWith("/check-rpc-recovery.js"))) throw Error("Pinned transport preflight failed");
  };
  await assert.rejects(update(f.options), /Pinned transport preflight failed/);
  assert.equal(f.calls.some(c => c[0] === "systemctl" && ["kill", "start"].includes(c[1])), false);
  assert.equal(f.active, "active"); assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
  assert.equal(fs.existsSync(path.join(f.p.releases, f.target)), false);
  f.hook = () => {}; assert.equal((await update(f.options)).installed, true);
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
    if (kind === "lock") fs.mkdirSync(path.join(f.p.work, "kai-reward-progress-update.lock"));
    if (kind === "identity") fs.writeFileSync(f.p.unit, f.unit.toString().replace("User=kai-koin-prepaid", "User=root"));
    await assert.rejects(update(f.options));
    assert.equal(f.calls.some(c => c[0] === "systemctl" && ["kill", "start", "daemon-reload"].includes(c[1])), false); f.preserved();
  }
});
test("dependency preparation failure keeps the old service running and permits an exact retry", async t => {
  const f = fixture(t); f.hook = exe => { if (exe === "npm") throw Error("Install unavailable"); };
  await assert.rejects(update(f.options), /Install unavailable/);
  assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "kill"), false);
  assert.equal(fs.existsSync(path.join(f.p.releases, f.target)), false);
  assert.equal(fs.readdirSync(f.p.releases).some(name => name.startsWith(".reward-runtime-")), false);
  f.hook = () => {}; assert.equal((await update(f.options)).installed, true);
});
test("concurrent configuration and unit changes survive failed activation or rollback", async t => {
  for (const change of ["configuration", "unit"]) {
    const f = fixture(t);
    if (change === "configuration") f.hook = (exe, args) => { if (exe === "systemctl" && args[0] === "kill") fs.writeFileSync(f.policy, "operator-changed-policy"); };
    const options = change === "unit" ? { ...f.options, checkHealth: async () => { fs.writeFileSync(f.p.unit, "operator-changed-unit"); throw Error("Health failed"); } } : f.options;
    await assert.rejects(update(options));
    if (change === "configuration") { assert.equal(fs.readFileSync(f.policy, "utf8"), "operator-changed-policy"); assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); }
    else { assert.equal(fs.readFileSync(f.p.unit, "utf8"), "operator-changed-unit"); f.preserved(); }
    assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "kill").length, 1);
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
test("Reward runtime health verifies the capability on loopback and public HTTPS", async () => {
  const now = 1800000000000;
  const provider = { ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 } }, buyer = { ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", serviceOrigin: ORIGIN, schedulerUrl: ORIGIN + "/scheduler", target: { chainId: CHAIN } } };
  for (const absentAt of [null, "http://127.0.0.1:3109", ORIGIN]) {
    const seen = [], fetchImpl = async url => {
      seen.push(url);
      const body = url.endsWith("/health") ? { mode: "mainnet-pilot", product: "prepaid-usd-v1", mainnetPaymentsEnabled: true, chainId: CHAIN, lastSuccess: now, rewardRuntimeVersion: (!absentAt || !url.startsWith(absentAt)) ? 1 : 0, freeAllowanceRefreshVersion: (!absentAt || !url.startsWith(absentAt)) ? 1 : 0, rewardSummaryVersion: 1, rpcReadGroupVersion: (!absentAt || !url.startsWith(absentAt)) ? 1 : 0, rpcTransportVersion: (!absentAt || !url.startsWith(absentAt)) ? 1 : 0, claimSponsorshipVersion: (!absentAt || !url.startsWith(absentAt)) ? 1 : 0, ...(!absentAt || !url.startsWith(absentAt) ? { lastRewardSuccess: null } : {}) } : url.includes("provider/device") ? provider : buyer;
      return { ok: true, text: async () => JSON.stringify(body) };
    };
    const options = { fetchImpl, clock: () => now, timeoutMs: 0 };
    if (absentAt) await assert.rejects(health(options), /Reward runtime progress/);
    else { await health(options); assert.equal(seen.length, 6); }
    await health({ ...options, summary: false });
  }
});

test("Reward runtime update accepts the observed release", async t => {
  for (const prior of PRIOR_RELEASES) {
    const f = fixture(t, prior); assert.equal((await update(f.options)).installed, true); f.preserved();
  }
});

test("old transport capabilities cannot substitute for the reward runtime capability", async () => {
  const now = 1800000000000;
  for (const marker of [undefined, 0]) {
    const fetchImpl = async () => new Response(JSON.stringify({
      mode: "mainnet-pilot", product: "prepaid-usd-v1", mainnetPaymentsEnabled: true,
      chainId: CHAIN, lastSuccess: now, lastRewardSuccess: now,
      freeAllowanceRefreshVersion: 1, rewardSummaryVersion: 1,
      rpcTransportVersion: 1, claimSponsorshipVersion: 1, rpcReadGroupVersion: 1, rewardRuntimeVersion: marker,
    }));
    await assert.rejects(health({ fetchImpl, clock: () => now, timeoutMs: 0 }), /Reward runtime progress/);
  }
});


test("graceful drain only sends main-process SIGTERM and refuses nonzero exit, restart or timeout", async t => {
  for (const mode of ["failure", "restart", "survives"]) {
    const f = fixture(t); const checked = [];
    if (mode === "failure") f.stopStatus = "1"; else f.signalMode = mode;
    await assert.rejects(update({ ...f.options, checkHealth: async o => checked.push(o.summary) }),
      mode === "failure" ? /did not exit cleanly/ : mode === "restart" ? /restarted or changed/ : /drain timed out/);
    assert.equal(f.active, "active"); assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
    assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "kill").length, 1);
    assert.equal(f.calls.some(c => c[0] === "systemctl" && ["stop", "restart", "daemon-reload"].includes(c[1])), false);
    assert.equal(f.calls.some(c => c.includes("SIGKILL") || c.includes("--signal=SIGKILL")), false);
    assert.deepEqual(checked, [false]);
    if (mode !== "failure") assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "start"), false);
  }
});
test("process identity changes before the signal prevent any signal or code change", async t => {
  const f = fixture(t); let observations = 0;
  f.hook = (exe, args) => {
    if (exe === "systemctl" && args[0] === "show" && args.at(-1).includes("NRestarts") && ++observations === 2) f.pid = "77";
  };
  await assert.rejects(update(f.options), /process changed before SIGTERM/);
  assert.equal(f.calls.some(c => c[0] === "systemctl" && ["kill", "start", "daemon-reload"].includes(c[1])), false);
  assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
});
test("malformed or incomplete process status cannot authorize a signal", async t => {
  const f = fixture(t);
  for (const value of ["", "ActiveState=active\nMainPID=42", "ActiveState=active\nMainPID=unknown"]) {
    const run = (exe, args, ...rest) => exe === "systemctl" && args[0] === "show" && args.at(-1).includes("NRestarts") ? value : f.run(exe, args, ...rest);
    await assert.rejects(update({ ...f.options, run }), /process identity/);
    assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "kill"), false);
  }
});
test("new code is retained when its own graceful rollback drain cannot finish", async t => {
  const f = fixture(t); let checks = 0;
  await assert.rejects(update({ ...f.options, checkHealth: async () => {
    if (++checks === 1) { f.signalMode = "survives"; throw Error("Activation health failed"); }
  } }), /Activation health failed/);
  assert.match(fs.readFileSync(f.p.unit, "utf8"), new RegExp(f.target));
  assert.equal(f.active, "active"); f.preserved();
  assert.match(f.logs.join("\n"), /Automatic code recovery could not finish/);
  assert.doesNotMatch(f.logs.join("\n"), /Previous code restored/);
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "kill").length, 2);
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "stop"), false);
});
test("lightweight progress uses internal authentication and does not query full operator status", async t => {
  const f = fixture(t), secret = "e".repeat(64); fs.writeFileSync(path.join(f.p.config, "operator-secret"), secret);
  const logs = [], now = 1800000000000;
  const output = await progress({ paths: f.p, log: row => logs.push(row), fetchImpl: async (url, options) => {
    assert.equal(url, "http://127.0.0.1:3109/operator/progress"); assert.equal(options.headers["x-operator-secret"], secret);
    assert.equal(options.redirect, "error"); assert.ok(options.signal);
    return new Response(JSON.stringify({ rewardRuntimeVersion: 1, observedAt: now, lastServing: now, busy: true, stopped: false, processingStage: "reward_collection",
      processingStartedAt: now - 2000, lastRewardSuccess: null, lastSettlementSuccess: null,
      currentEpoch: { epoch: "20833", budgetPresent: false, dayPresent: false, openedAt: null, intervalCount: 0, lastIntervalEnd: null },
      errors: [{ at: now, stage: "reward_pool", message: secret, rpc: [] }], secret }));
  } });
  assert.equal(output.processingStage, "reward_collection"); assert.ok(!logs.join("\n").includes(secret));
  assert.match(logs.join("\n"), /budgetPresent/); assert.match(logs.join("\n"), /recentErrors/);
});
test("unavailable progress fails activation and rolls back code without rolling back journals", async t => {
  const f = fixture(t);
  await assert.rejects(update({ ...f.options, reportProgress: async () => { throw Error("Lightweight reward progress could not be verified"); } }), /progress could not/);
  assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); assert.equal(f.active, "active"); f.preserved();
});
test("progress errors never print the operator secret", async t => {
  const f = fixture(t), secret = "d".repeat(64); fs.writeFileSync(path.join(f.p.config, "operator-secret"), secret);
  for (const fetchImpl of [async () => { throw Error(secret); }, async () => new Response("private", { status: 403 }), async () => new Response("x".repeat(32769))])
    await assert.rejects(progress({ paths: f.p, fetchImpl }), error => !error.message.includes(secret) && /progress could not/.test(error.message));
});
test("default SIGTERM termination is refused even when systemd reports success", async t => {
  const f = fixture(t); f.signalMode = "default-signal";
  await assert.rejects(update(f.options), /did not exit cleanly/);
  assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); assert.equal(f.active, "active"); f.preserved();
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "daemon-reload"), false);
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "start").length, 1);
});
test("configuration changes during the last identity read prevent SIGTERM", async t => {
  const f = fixture(t); let observations = 0;
  f.hook = (exe, args) => {
    if (exe === "systemctl" && args[0] === "show" && args.at(-1).includes("NRestarts") && ++observations === 2)
      fs.writeFileSync(f.policy, "operator-changed-policy");
  };
  await assert.rejects(update(f.options), /Concurrent service or configuration change/);
  assert.equal(f.calls.some(c => c[0] === "systemctl" && ["kill", "start", "daemon-reload"].includes(c[1])), false);
  assert.equal(fs.readFileSync(f.policy, "utf8"), "operator-changed-policy");
  assert.deepEqual(fs.readFileSync(f.p.unit), f.unit);
});
test("the exited PID and restart counter remain pinned through the code replacement gate", async t => {
  for (const change of ["after_drain", "before_write", "before_rename"]) {
    const f = fixture(t); let observations = 0;
    const options = { ...f.options };
    if (change === "after_drain") options.drain = async o => { const exited = await gracefulShutdown(o); f.restarts = "1"; return exited; };
    else f.hook = (exe, args) => {
      if (exe === "systemctl" && args[0] === "show" && args.at(-1).includes("NRestarts") && ++observations === (change === "before_write" ? 5 : 6))
        f.restarts = "1";
    };
    await assert.rejects(update(options), /process identity|main-process identity/);
    assert.deepEqual(fs.readFileSync(f.p.unit), f.unit); f.preserved();
    assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "daemon-reload"), false);
  }
});
