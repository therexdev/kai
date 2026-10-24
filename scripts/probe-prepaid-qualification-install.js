"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { evidence, nextRuntime, install, BASE, UNIT, ALLOWED } = require("../deploy/koin-mainnet/install-smart-qualification");
const e = evidence();
function runtime() {
  const s = e.review.scope;
  return { schema: 2, mode: s.mode, schedulerUrl: s.schedulerUrl, policyHash: s.policyHash, version: 1, accountMode: "public",
    deployment: { schema: 1, decimals: 8, rpc: ["https://api.koinosai.com", "https://api.koinos.io"], ...s.deployment,
      token: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", tokenHash: "0x1220eb38ea471cf855ff4d336e51bf47df8cfc8a0a9ae49193b0d7e103b890d464d6",
      admin: "1EZFE7yY9waCFR454BkKmxbehQLUvEDDpK", verifier: "1HdgLvVRbvrwnF547sbEbmSu5USTu7Gy1K",
      mining: "1G4L15H3TWKUzzg9i3CV5w97exuvQ6vNVz", operations: "1PVLC9iF1rZ1zxEQDLJiniXL973GPateK8" },
    roles: { settlement: "1P9pLR3fLqBUwT2tuShBdpBBQEaarcFRE1", lifecycle: "1NgDtrzJfPwdaWskKMfWVvjJQmW4dLdvYw", claims: "1NMaeSzHS9rZsAMK9FZTZt2vGMcSzr7pDr" },
    models: structuredClone(require("../deploy/koin-mainnet/settings.prepaid-usd.models.example.json").settings.models),
    maxRcPerTransaction: "100000000", maxRcPerDay: "500000000",
    purchaseQuoteBudget: { schema: 1, dailyQuoteAuthorizationUsdAtoms: "100000000", accountDailyQuoteAuthorizationUsdAtoms: "100000000" },
    freePolicy: { version: 1, accountConcurrent: 1, accountDaily: "750000", networkDaily: "30000000", originDaily: "2250000", eligibleModels: ["koinos-fast"] } };
}
function fixture(t, runtimeMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-admission-probe-")); fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { config: path.join(root, "config"), state: path.join(root, "state"), work: root, release: path.join(root, "releases", BASE), unit: path.join(root, UNIT) };
  fs.mkdirSync(paths.config, { mode: 0o700 }); fs.mkdirSync(paths.state, { mode: 0o700 });
  const file = path.join(paths.config, "runtime.json"), original = Buffer.from(JSON.stringify(runtime(), null, 2) + "\n");
  fs.writeFileSync(file, original, { mode: 0o640 });
  // Default creation respects the caller's umask; explicit cases also exercise
  // an existing group-readable service file under a restrictive operator mask.
  if (runtimeMode !== undefined) fs.chmodSync(file, runtimeMode);
  const permissions = () => { const s = fs.statSync(file); return { mode: s.mode & 0o777, uid: s.uid, gid: s.gid }; };
  const originalPermissions = permissions();
  const preserved = new Map([[path.join(paths.config, "runtime-keys.json"), "private-fixture-key"], [path.join(paths.config, "qualifications.json"), "[]"],
    [path.join(paths.state, "accounts.sqlite"), "existing-account"], [path.join(paths.state, "payments.sqlite"), "pending-purchase"],
    [path.join(root, "bootstrap-plan.json"), "immutable-original-plan"]]);
  for (const [file, bytes] of preserved) fs.writeFileSync(file, bytes, { mode: 0o600 });
  const unit = `Environment=KAI_KOIN_TEST_CONFIG_DIR=${paths.config}\nEnvironment=KAI_KOIN_TEST_STATE_DIR=${paths.state}\nEnvironment=KAI_KOIN_TEST_PORT=3109\n`;
  fs.writeFileSync(paths.unit, unit, { mode: 0o644 });
  let active = "active", overrides = {}, changed = [...ALLOWED].join("\n"), dirty = "";
  const calls = [], logs = [];
  const run = (exe, args) => {
    calls.push([exe, ...args]);
    if (exe === "git") return args[0] === "status" ? dirty : args[0] === "diff" ? changed : "";
    if (exe === "systemctl") {
      if (args[0] === "stop") { active = "inactive"; return ""; }
      if (args[0] === "start") { active = "active"; return ""; }
      if (args[0] === "show") return ({ WorkingDirectory: paths.release, FragmentPath: paths.unit, DropInPaths: "", ActiveState: active, ExecMainStatus: "0", ...overrides })[args.at(-1).split("=")[1]];
    }
    throw Error("Unexpected command");
  };
  const args = { approve: e.approvalHash, paths, run, checkHealth: async () => {}, log: s => logs.push(s) };
  const unchanged = () => { for (const [file, bytes] of preserved) assert.equal(fs.readFileSync(file, "utf8"), bytes); assert.equal(fs.readFileSync(paths.unit, "utf8"), unit); assert.ok(!logs.join(" ").includes("private-fixture-key")); };
  return { root, paths, file, original, originalPermissions, permissions, preserved, calls, logs, args, run, unchanged, set overrides(v) { overrides = v; }, set changed(v) { changed = v; }, set dirty(v) { dirty = v; } };
}
test("Smart review retains all candidate answers and commits the actual unsigned measurement", () => {
  assert.equal(e.policy.minPass, 12); assert.equal(e.policy.cases.length, 12); assert.equal(e.review.measured.answersPassed, 12);
  const observation = JSON.parse(e.files["observation.json"]);
  assert.equal(observation.report.networkReady, false); assert.equal(observation.report.signed, false);
  assert.equal(observation.report.publicWallet, undefined); assert.equal(observation.report.hardware, undefined);
  for (const change of [c => c.schedulerUrl = "https://other.example/scheduler", c => c.deployment.creditsHash = "0x1220" + "a".repeat(64),
    c => c.qualificationPolicies = [{ ...e.policy, minPass: 11 }]]) {
    const c = runtime(); change(c); assert.throws(() => nextRuntime(Buffer.from(JSON.stringify(c)), e));
  }
});
test("configuration-only admission preserves prices, limits, keys, accounts, plans and journals, and is idempotent", async t => {
  for (const runtimeMode of [undefined, 0o600, 0o640]) {
    const f = fixture(t, runtimeMode); await install(f.args); f.unchanged();
    const current = JSON.parse(fs.readFileSync(f.file)); assert.deepEqual(current.qualificationPolicies, [e.policy]); delete current.qualificationPolicies;
    assert.deepEqual(current, JSON.parse(f.original)); assert.deepEqual(f.permissions(), f.originalPermissions);
    const stops = f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length;
    await install(f.args); assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "stop").length, stops); f.unchanged();
    assert.deepEqual(f.permissions(), f.originalPermissions);
  }
});
test("failed new-policy health restores only runtime settings and retains newly written payment and qualification records", async t => {
  for (const runtimeMode of [undefined, 0o600, 0o640]) {
    const f = fixture(t, runtimeMode), payment = path.join(f.paths.state, "payments.sqlite"), journal = path.join(f.paths.state, "automatic-qualification.json");
    await assert.rejects(install({ ...f.args, checkHealth: async () => {
      fs.writeFileSync(payment, "new-payment"); fs.writeFileSync(journal, "new-signed-qualification"); throw Error("health failed");
    } }), /health failed/);
    assert.deepEqual(fs.readFileSync(f.file), f.original); assert.equal(fs.readFileSync(payment, "utf8"), "new-payment");
    assert.equal(fs.readFileSync(journal, "utf8"), "new-signed-qualification"); f.preserved.set(payment, "new-payment"); f.unchanged();
    assert.deepEqual(f.permissions(), f.originalPermissions);
  }
});
test("wrong approval, source edits, service identity, dirty checkout, existing policy and lock stop before service changes", async t => {
  for (const mutate of [f => f.args.approve = "0".repeat(64), f => f.changed = [...ALLOWED, "lib/accounts.js"].join("\n"), f => f.dirty = " M package.json",
    f => f.overrides = { WorkingDirectory: "/other/release" }, f => f.overrides = { DropInPaths: "/override" },
    f => { const c = runtime(); c.qualificationPolicies = [{ ...e.policy, minPass: 11 }]; fs.writeFileSync(f.file, JSON.stringify(c)); },
    f => fs.mkdirSync(path.join(f.paths.config, ".smart-qualification-lock"))]) {
    const f = fixture(t); mutate(f); await assert.rejects(install(f.args));
    assert.equal(f.calls.some(c => c[0] === "systemctl" && ["stop", "start"].includes(c[1])), false); f.unchanged();
  }
});
test("changed observation and symbolic runtime are rejected before service changes", async t => {
  const f = fixture(t), dir = path.join(f.root, "evidence"); fs.mkdirSync(dir);
  for (const [name, bytes] of Object.entries(e.files)) fs.writeFileSync(path.join(dir, "smart-2026-10-24." + name), bytes);
  fs.appendFileSync(path.join(dir, "smart-2026-10-24.observation.json"), " "); assert.throws(() => evidence(dir), /evidence/);
  fs.renameSync(f.file, f.file + ".saved"); fs.symlinkSync(f.file + ".saved", f.file);
  await assert.rejects(install(f.args)); assert.equal(f.calls.some(c => c[1] === "stop"), false); f.unchanged();
});
test("a concurrent runtime edit during shutdown is preserved and never replaced by admission or rollback", async t => {
  const f = fixture(t), changed = Buffer.from(JSON.stringify({ ...runtime(), maxRcPerDay: "600000000" })); let first = true;
  const run = (exe, args, ...rest) => { const result = f.run(exe, args, ...rest); if (exe === "systemctl" && args[0] === "stop" && first) { first = false; fs.writeFileSync(f.file, changed); } return result; };
  await assert.rejects(install({ ...f.args, run }), /Runtime changed/); assert.deepEqual(fs.readFileSync(f.file), changed); f.unchanged();
  assert.ok(f.logs.some(l => l.includes("Recovery needs operator attention")));
});
test("the reviewed twelve-case policy requires fresh signatures, rejects eleven answers and grants one-day evidence only after twelve", async t => {
  // Byte-token fixture checks protocol gating, never claims actual Smart quality.
  const { Meter } = require("../lib/koin-network/metering"), Q = require("../lib/koin-network/qualification-protocol"), P = require("../lib/koin-network/job-protocol");
  const tariff = runtime().models.find(m => m.tariff.model === e.policy.model).tariff, encode = s => [...Buffer.from(s)];
  const meter = new Meter([{ tariff, adapter: { ...tariff, render: JSON.stringify, encode, input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } }]);
  const f = require("./helpers/koin-prepaid-fixture").fixture(t, { meter }), Engine = require("../lib/koin-network/provider-qualification").ProviderQualification;
  const worker = { address: f.provider, fingerprint: "a".repeat(16), proof: "signed", capabilities: { koinQualification: 1 }, models: [e.policy.model] };
  const options = { file: path.join(f.dir, "qualification.json"), policy: e.policy, target: f.target, meter, clock: () => f.ledger.clock() };
  let engine = new Engine(options); assert.equal(engine.next({ ...worker, proof: "unsigned" }), null);
  async function complete(wrongIndex) {
    for (let i = 0; i < 12; i++) {
      const job = engine.next(worker), c = e.policy.cases.find(c => JSON.stringify(c.messages) === job.challenge.prompt);
      const output = i === wrongIndex ? "WRONG" : c.expected[0], body = { jobId: job.challenge.id, output, signature: Buffer.from(await f.worker.signHash(Q.resultHash(job, P.hash(output)))).toString("base64") };
      if (i === 0) assert.throws(() => engine.result(worker, { ...body, output: "changed" }), /Signature/);
      engine.result(worker, body); engine = new Engine(options);
      if (i < 11) assert.equal(engine.records().length, 0);
    }
  }
  await complete(0); assert.equal(engine.status(f.provider).state, "failed"); assert.equal(engine.records().length, 0);
  f.time(300001); await complete(-1); assert.equal(engine.status(f.provider).state, "qualified");
  assert.equal(engine.records()[0].expires - f.ledger.clock(), 86400000);
});
