"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { update, health, BASE, INSTALLED, LOCKS, UNIT, REQUIRED } = require("./update-model-readiness");
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", ORIGIN = "https://credits.koinosai.com", APPROVE = "a".repeat(64);
const guestCapabilities = target => ({ ok: true, capabilities: { deviceFreeCredits: 1, scope: "device-free", freeOnly: true, algorithm: "Ed25519",
  serviceOrigin: ORIGIN, schedulerUrl: ORIGIN + "/scheduler", target, challengeTtlMs: 300000, sessionTtlMs: 86400000 } });
function fixture(t, installed = INSTALLED[0]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-model-readiness-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), state: path.join(root, "state"), unit: path.join(root, UNIT) };
  for (const dir of [p.releases, p.config, p.state]) fs.mkdirSync(dir);
  const current = path.join(p.releases, installed); fs.mkdirSync(current);
  const target = "b".repeat(40), calls = [], logs = [], policy = path.join(p.config, "runtime.json"), keys = path.join(p.config, "runtime-keys.json");
  const oldPolicies = [{ schema: 1, model: "koinos-smart", minPass: 12, maxLatencyMs: 30000, reviewedEvidenceHash: "old-reviewed-policy" }];
  const nextPolicies = [{ schema: 2, kind: "runtime-readiness", model: "koinos-smart", minPass: 3, maxLatencyMs: 30000, reviewedEvidenceHash: APPROVE }];
  const models = [{ model: "koinos-smart", modelHash: "c".repeat(64), policyHash: "d".repeat(64), minPass: 3, total: 3, maxLatencyMs: 30000 }];
  const original = { schema: 2, mode: "mainnet-pilot", accountMode: "public", schedulerUrl: ORIGIN + "/scheduler", policyHash: "a".repeat(64),
    purchaseQuoteBudget: { schema: 1, dailyQuoteAuthorizationUsdAtoms: "100000000", accountDailyQuoteAuthorizationUsdAtoms: "100000000" },
    qualificationPolicies: oldPolicies, freePolicy: { dailyLimit: "retained" }, tariff: { price: "retained" }, roles: { claims: "retained" },
    deployment: { product: "prepaid-usd-v1", chainId: CHAIN, credits: "18QmSHrMszxmYPaDB1jxzY35vYDcG6aomN", creditsHash: "0x1220" + "b".repeat(64) } };
  const originalBytes = Buffer.from(JSON.stringify(original, null, 2) + "\n");
  const reviewRuntime = bytes => {
    const value = JSON.parse(bytes), already = JSON.stringify(value.qualificationPolicies) === JSON.stringify(nextPolicies);
    if (!already && JSON.stringify(value.qualificationPolicies) !== JSON.stringify(oldPolicies)) throw Error("Unknown existing model admission policy");
    value.qualificationPolicies = nextPolicies;
    return { bytes: already ? bytes : Buffer.from(JSON.stringify(value, null, 2) + "\n"), already,
      review: { schema: 2, kind: "runtime-readiness", reviewHash: APPROVE, models, eligibilityCreated: false } };
  };
  fs.writeFileSync(policy, originalBytes); fs.chmodSync(policy, 0o640); fs.writeFileSync(keys, "private-fixture-key", { mode: 0o600 });
  const records = Object.fromEntries(["accounts.sqlite", "payments.sqlite", "reward-journal.sqlite", "purchase-quotes.sqlite", "quote-anchor", "automatic-qualification.json.models/smart.json", "qualification-evidence/existing-signed-results.json", "provider-devices/devices.sqlite"].map(name => [name, path.join(p.state, name)]));
  for (const [name, file] of Object.entries(records)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "existing:" + name); }
  const unit = Buffer.from(`[Service]\nUser=kai-koin-prepaid\nGroup=kai-koin-prepaid\nWorkingDirectory=${current}\nExecStart=${process.execPath} ${current}/test-server.js\nEnvironment=KAI_KOIN_TEST_CONFIG_DIR=${p.config}\nEnvironment=KAI_KOIN_TEST_STATE_DIR=${p.state}\nEnvironment=KAI_KOIN_TEST_PORT=3109\nEnvironmentFile=${p.config}/account.env\nReadWritePaths=${p.state}\nReadOnlyPaths=${p.config}\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nUMask=0077\n`);
  fs.writeFileSync(p.unit, unit); fs.chmodSync(p.unit, 0o644);
  let active = "active", changed = REQUIRED.join("\n"), dirty = "", failProbe = false, hook = () => {}, dropins = "", stopStatus = "0";
  const run = (exe, args) => {
    calls.push([exe, ...args]); hook(exe, args);
    if (exe === "git") {
      if (args[0] === "rev-parse") return target;
      if (args[0] === "status") return dirty;
      if (args[0] === "diff") { assert.equal(args[2], BASE); return changed; }
      if (args[0] === "archive") fs.writeFileSync(args.find(a => a.startsWith("--output=")).slice(9), "source-fixture");
    }
    if (exe === process.execPath && args[0] === "--test" && failProbe) throw Error("Readiness probe failed");
    if (exe === "systemctl") {
      if (args[0] === "stop") active = "inactive";
      if (args[0] === "start") active = "active";
      if (args[0] === "show") return { WorkingDirectory: fs.readFileSync(p.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)?.[1], ActiveState: active, ExecMainStatus: stopStatus, DropInPaths: dropins, FragmentPath: p.unit }[args.at(-1).split("=")[1]];
    }
    return "";
  };
  return { p, target, current, calls, logs, policy, keys, records, unit, originalBytes, original, nextPolicies, models, reviewRuntime,
    options: { approve: APPROVE, paths: p, run, log: s => logs.push(s), checkHealth: async () => {}, reviewRuntime },
    set changed(v) { changed = v; }, set dirty(v) { dirty = v; }, set failProbe(v) { failProbe = v; }, set hook(v) { hook = v; }, set dropins(v) { dropins = v; }, set stopStatus(v) { stopStatus = v; },
    preserved() {
      const value = JSON.parse(fs.readFileSync(policy)), prior = structuredClone(original); delete value.qualificationPolicies; delete prior.qualificationPolicies;
      assert.deepEqual(value, prior); assert.equal(fs.statSync(policy).mode & 0o777, 0o640); assert.equal(fs.statSync(p.unit).mode & 0o777, 0o644);
      assert.equal(fs.readFileSync(keys, "utf8"), "private-fixture-key"); assert.ok(!logs.join("\n").includes("private-fixture"));
    },
    unchanged() { assert.deepEqual(fs.readFileSync(policy), originalBytes); assert.deepEqual(fs.readFileSync(p.unit), unit); this.preserved(); },
  };
}
test("reviewed readiness installs from either supported backend, changes only admission and keeps all previous evidence; exact repeat does not restart", async t => {
  for (const installed of INSTALLED) {
    const f = fixture(t, installed); let checks = 0;
    const options = { ...f.options, checkHealth: async o => { assert.equal(o.admission, true); assert.equal(o.recovery, true); assert.deepEqual(o.expectedQualification, f.models); checks++; } };
    const result = await update(options); assert.equal(result.commit, f.target); assert.equal(result.reviewHash, APPROVE); assert.equal(result.eligibilityCreated, false); f.preserved();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.policy)).qualificationPolicies, f.nextPolicies);
    for (const [name, file] of Object.entries(f.records)) assert.equal(fs.readFileSync(file, "utf8"), "existing:" + name);
    assert.deepEqual(fs.readFileSync(path.join(result.backup, "previous-runtime.json")), f.originalBytes);
    assert.deepEqual(fs.readFileSync(path.join(result.backup, "previous.service")), f.unit);
    assert.equal(fs.statSync(result.backup).mode & 0o777, 0o700);
    for (const name of ["previous-runtime.json", "previous.service", "next-runtime.json"]) assert.equal(fs.statSync(path.join(result.backup, name)).mode & 0o777, 0o600);
    const probe = f.calls.findIndex(c => c[0] === process.execPath && c[1] === "--test"), stop = f.calls.findIndex(c => c[0] === "systemctl" && c[1] === "stop"); assert.ok(probe >= 0 && stop > probe);
    assert.equal((await update(options)).unchanged, true); assert.equal(checks, 2);
    assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, 1);
    for (const lock of LOCKS) assert.equal(fs.existsSync(path.join(f.p.work, lock)), false);
  }
});
test("the actual reviewed fifteen-model migration reaches the updater health check with the exact runtime status policy summaries", async t => {
  const Previous = require("./catalog-qualification"), Readiness = require("./model-readiness"), { TestRuntime } = require("../../lib/koin-network/test-runtime");
  const old = Previous.reviewed(), next = Readiness.reviewed(), scope = old.review.scope;
  const config = { schema: 2, mode: scope.mode, schedulerUrl: scope.schedulerUrl, policyHash: scope.policyHash, version: 1, accountMode: "public",
    deployment: { schema: 1, decimals: 8, rpc: ["https://api.koinosai.com", "https://api.koinos.io"], ...scope.deployment,
      token: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", tokenHash: "0x1220eb38ea471cf855ff4d336e51bf47df8cfc8a0a9ae49193b0d7e103b890d464d6",
      admin: "1EZFE7yY9waCFR454BkKmxbehQLUvEDDpK", verifier: "1HdgLvVRbvrwnF547sbEbmSu5USTu7Gy1K", mining: "1G4L15H3TWKUzzg9i3CV5w97exuvQ6vNVz", operations: "1PVLC9iF1rZ1zxEQDLJiniXL973GPateK8" },
    roles: { settlement: "1P9pLR3fLqBUwT2tuShBdpBBQEaarcFRE1", lifecycle: "1NgDtrzJfPwdaWskKMfWVvjJQmW4dLdvYw", claims: "1NMaeSzHS9rZsAMK9FZTZt2vGMcSzr7pDr" },
    models: structuredClone(require("./settings.prepaid-usd.models.example.json").settings.models), maxRcPerTransaction: "100000000", maxRcPerDay: "500000000",
    qualificationPolicies: old.policies };
  const bytes = Buffer.from(JSON.stringify(config, null, 2) + "\n");
  for (const installed of INSTALLED) {
    const f = fixture(t, installed); fs.writeFileSync(f.policy, bytes); let healthCalls = 0;
    const options = { ...f.options, approve: next.reviewHash, reviewRuntime: undefined, checkHealth: async o => {
      const running = JSON.parse(fs.readFileSync(f.policy));
      // Execute the actual operator-status serializer with controlled ledger
      // collaborators, without opening a live database or contacting an RPC.
      const value = TestRuntime.prototype.status.call({ config: running, client: { d: running.deployment },
        ledger: { settledJobs: () => [], pendingJobs: () => [] }, cycle: { days: () => [] }, signing: { status: () => [], resourceUsage: () => ({}) },
        meter: { tariffs: () => running.models.map(m => m.tariff) }, qualifier: { readinessVersion: 1 }, errors: [] });
      assert.equal(JSON.stringify(value.qualificationModels), JSON.stringify(o.expectedQualification));
      assert.deepEqual(o.expectedQualification, Readiness.summary(next.policies)); healthCalls++;
    } };
    assert.equal((await update(options)).reviewHash, next.reviewHash);
    const written = JSON.parse(fs.readFileSync(f.policy)); assert.deepEqual(written.qualificationPolicies, next.policies);
    written.qualificationPolicies = config.qualificationPolicies; assert.deepEqual(written, config);
    assert.equal((await update(options)).unchanged, true); assert.equal(healthCalls, 2);
    for (const [name, file] of Object.entries(f.records)) assert.equal(fs.readFileSync(file, "utf8"), "existing:" + name);
  }
});
test("failed activation restores code and exact previous runtime while retaining all newly written live records and allowing retry", async t => {
  for (const installed of INSTALLED) {
    const f = fixture(t, installed), checked = [];
    await assert.rejects(update({ ...f.options, checkHealth: async o => {
      checked.push([o.admission, o.recovery]);
      if (o.admission) { for (const [name, file] of Object.entries(f.records)) fs.writeFileSync(file, "new:" + name); throw Error("Public readiness not active"); }
    } }), /Public readiness not active/);
    f.unchanged();
    for (const [name, file] of Object.entries(f.records)) assert.equal(fs.readFileSync(file, "utf8"), "new:" + name);
    assert.deepEqual(checked, [[true, true], [false, installed === BASE]]);
    assert.equal(fs.existsSync(path.join(f.p.releases, f.target)), false);
    assert.equal((await update(f.options)).installed, true);
  }
});
test("wrong approval, unknown policy, source, probes, service identity and unsafe configuration stop before service changes", async t => {
  for (const kind of ["approval", "missing-approval", "policy", "policy-code-mismatch", "version", "dirty", "source", "probe", "override", "identity", "runtime-symlink", "other-symlink", "mode", "target-exists"]) {
    const f = fixture(t); let options = f.options;
    if (kind === "approval") options = { ...options, approve: "f".repeat(64) };
    if (kind === "missing-approval") options = { ...options, approve: undefined };
    if (kind === "policy") { const value = structuredClone(f.original); value.qualificationPolicies[0].minPass--; fs.writeFileSync(f.policy, JSON.stringify(value)); }
    if (kind === "policy-code-mismatch") fs.writeFileSync(f.policy, f.reviewRuntime(f.originalBytes).bytes);
    if (kind === "version") fs.writeFileSync(f.p.unit, f.unit.toString().replaceAll(f.current, path.join(f.p.releases, "f".repeat(40))));
    if (kind === "dirty") f.dirty = " M lib/accounts.js";
    if (kind === "source") f.changed = REQUIRED.join("\n") + "\nlib/koin-network/reward-policy.js";
    if (kind === "probe") f.failProbe = true;
    if (kind === "override") f.dropins = "/etc/systemd/system/override.conf";
    if (kind === "identity") fs.writeFileSync(f.p.unit, f.unit.toString().replace("User=kai-koin-prepaid", "User=root"));
    if (kind === "runtime-symlink") { fs.renameSync(f.policy, f.policy + ".original"); fs.symlinkSync(f.policy + ".original", f.policy); }
    if (kind === "other-symlink") fs.symlinkSync(f.keys, path.join(f.p.config, "unexpected"));
    if (kind === "mode") fs.chmodSync(f.policy, 0o666);
    if (kind === "target-exists") fs.mkdirSync(path.join(f.p.releases, f.target));
    await assert.rejects(update(options));
    assert.equal(f.calls.some(c => c[0] === "systemctl" && ["stop", "start", "daemon-reload"].includes(c[1])), false, kind);
    for (const [name, file] of Object.entries(f.records)) assert.equal(fs.readFileSync(file, "utf8"), "existing:" + name);
  }
});
test("previous updater locks are respected and partial lock acquisition never removes another updater's lock", async t => {
  for (const lock of LOCKS) {
    const f = fixture(t), existing = path.join(f.p.work, lock); fs.mkdirSync(existing);
    await assert.rejects(update(f.options)); assert.equal(fs.existsSync(existing), true);
    assert.equal(f.calls.some(c => c[0] === "systemctl"), false);
    for (const other of LOCKS.filter(x => x !== lock)) assert.equal(fs.existsSync(path.join(f.p.work, other)), false);
    f.unchanged();
  }
});
test("even the reviewed migration cannot alter tariffs, free policy, roles, budgets or other runtime fields", async t => {
  for (const field of ["tariff", "freePolicy", "roles", "purchaseQuoteBudget", "deployment"]) {
    const f = fixture(t);
    await assert.rejects(update({ ...f.options, reviewRuntime: bytes => { const result = f.reviewRuntime(bytes), value = JSON.parse(result.bytes); value[field] = { changed: true }; return { ...result, bytes: Buffer.from(JSON.stringify(value)) }; } }), /only qualificationPolicies/);
    assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "stop"), false); f.unchanged();
  }
});
test("preparation failure leaves the current backend running and does not block an exact retry", async t => {
  for (const stage of ["npm", "runuser"]) {
    const f = fixture(t); f.hook = exe => { if (exe === stage) throw Error("Preparation unavailable"); };
    await assert.rejects(update(f.options), /Preparation unavailable/); f.unchanged();
    assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "stop"), false);
    assert.equal(fs.existsSync(path.join(f.p.releases, f.target)), false);
    assert.equal(fs.readdirSync(f.p.releases).some(name => name.startsWith(".model-readiness-")), false);
    f.hook = () => {}; assert.equal((await update(f.options)).installed, true);
  }
});
test("runtime and unit fsync failures on either side of rename recover both files without losing records or retryability", async t => {
  for (const failedFlush of [1, 2, 3, 4]) {
    const f = fixture(t), sync = fs.fsyncSync; let transition = false, flushes = 0;
    f.hook = (exe, args) => { if (exe === "systemctl" && args[0] === "stop") transition = true; };
    fs.fsyncSync = fd => { if (transition && ++flushes === failedFlush) throw Error("Injected persistence failure"); return sync(fd); };
    try { await assert.rejects(update(f.options), /Injected persistence failure/); }
    finally { fs.fsyncSync = sync; }
    f.unchanged();
    assert.equal(fs.readdirSync(f.p.config).some(name => name.includes(".readiness-")), false);
    assert.equal(fs.readdirSync(f.p.work).some(name => name.includes(".service.readiness-")), false);
    assert.equal(fs.existsSync(path.join(f.p.releases, f.target)), false);
    for (const [name, file] of Object.entries(f.records)) assert.equal(fs.readFileSync(file, "utf8"), "existing:" + name);
    f.hook = () => {}; assert.equal((await update(f.options)).installed, true);
  }
});
test("concurrent runtime, unit and other configuration edits are preserved during stop and failed health", async t => {
  for (const timing of ["stop", "health"]) for (const kind of ["runtime", "unit", "other"]) {
    const f = fixture(t), file = kind === "runtime" ? f.policy : kind === "unit" ? f.p.unit : f.keys;
    const edit = () => fs.writeFileSync(file, "operator-changed-" + kind);
    if (timing === "stop") f.hook = (exe, args) => { if (exe === "systemctl" && args[0] === "stop") edit(); };
    const options = timing === "health" ? { ...f.options, checkHealth: async () => { edit(); throw Error("Health unavailable"); } } : f.options;
    await assert.rejects(update(options)); assert.equal(fs.readFileSync(file, "utf8"), "operator-changed-" + kind);
    assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, 1);
    if (timing === "stop") assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "start"), false);
  }
});
test("unclean shutdown never changes the active code or policy and reports incomplete recovery", async t => {
  const f = fixture(t); f.stopStatus = "1";
  await assert.rejects(update(f.options), /did not stop cleanly/); f.unchanged();
  assert.equal(f.calls.some(c => c[0] === "systemctl" && c[1] === "start"), false);
  assert.ok(f.logs.some(line => /recovery could not finish/.test(line)));
});
test("readiness health verifies both active markers and existing purchase behavior on loopback and HTTPS", async () => {
  const now = 1800000000000;
  const provider = { ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 } }, buyer = { ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", serviceOrigin: ORIGIN, schedulerUrl: ORIGIN + "/scheduler", target: { chainId: CHAIN } } };
  for (const missing of [null, "modelReadinessAdmission", "providerQualificationRecovery", "purchaseQuotesUnlimited", "device-free"]) for (const origin of ["http://127.0.0.1:3109", ORIGIN]) {
    const seen = [], fetchImpl = async url => {
      seen.push(url); const body = url.endsWith("/health") ? { mode: "mainnet-pilot", product: "prepaid-usd-v1", mainnetPaymentsEnabled: true, chainId: CHAIN, lastSuccess: now, purchaseQuotesUnlimited: true, providerQualificationRecovery: 1, modelReadinessAdmission: 1 } : url.includes("device-free") ? guestCapabilities(buyer.capabilities.target) : url.includes("provider/device") ? provider : buyer;
      if (missing && url.startsWith(origin) && url.endsWith("/health")) delete body[missing];
      if (missing === "device-free" && url.startsWith(origin) && url.includes("/auth/device-free/")) body.capabilities.freeOnly = false;
      return { ok: true, text: async () => JSON.stringify(body) };
    };
    const options = { fetchImpl, clock: () => now, timeoutMs: 0 };
    if (missing) await assert.rejects(health(options)); else { await health(options); assert.equal(seen.length, 8); }
    if (missing !== "purchaseQuotesUnlimited") await health({ ...options, admission: false, recovery: false });
  }
});
test("health verifies exact running model policies and uses the operator credential only on loopback", async t => {
  const f = fixture(t), secret = "e".repeat(64), now = 1800000000000; fs.writeFileSync(path.join(f.p.config, "operator-secret"), secret, { mode: 0o600 });
  let models = f.models, operatorReads = 0;
  const fetchImpl = async (url, init) => {
    let body;
    if (url.endsWith("/operator/status")) {
      assert.equal(url, "http://127.0.0.1:3109/operator/status"); assert.equal(init.headers["x-operator-secret"], secret); operatorReads++;
      body = { product: "prepaid-usd-v1", chainId: CHAIN, qualificationModels: models };
    } else {
      assert.equal(init.headers, undefined);
      body = url.endsWith("/health") ? { mode: "mainnet-pilot", product: "prepaid-usd-v1", mainnetPaymentsEnabled: true, chainId: CHAIN, lastSuccess: now, purchaseQuotesUnlimited: true, providerQualificationRecovery: 1, modelReadinessAdmission: 1 }
        : url.includes("device-free") ? guestCapabilities({ chainId: CHAIN })
        : url.includes("provider/device") ? { ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 } }
        : { ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", serviceOrigin: ORIGIN, schedulerUrl: ORIGIN + "/scheduler", target: { chainId: CHAIN } } };
    }
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  const options = { fetchImpl, expectedQualification: f.models, paths: f.p, clock: () => now, timeoutMs: 0 };
  await health(options); assert.equal(operatorReads, 1);
  models = [{ ...f.models[0], policyHash: "f".repeat(64) }]; await assert.rejects(health(options), /Running model qualification/);
});
