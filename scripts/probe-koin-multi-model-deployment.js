"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer } = require("koilib"), P = require("../lib/koin-network/job-protocol");
const { configuration, prepare, MAINNET_CHAIN, MAINNET_TOKEN, ROLES } = require("../deploy/koin-mainnet/prepare");
const { configure } = require("../deploy/koin-mainnet/setup");
const { runtimeModels, settings } = require("../deploy/koin-test/setup");
const { stageConfiguration } = require("../deploy/koin-mainnet/prepaid-install-config");
const Models = require("../lib/koin-network/model-configuration");
const approved = require("../deploy/koin-mainnet/model-rates.proposal.json").models;
const owner = Signer.fromSeed("isolated-multi-model-deployment-owner").getAddress();
const artifact = Buffer.from("{}"), artifactHash = P.hash(artifact);

test("deployment example retains the exact prepared tokenizer for every approved model", () => {
  const example = require("../deploy/koin-mainnet/settings.prepaid-usd.models.example.json");
  const index = require("../lib/koin-network/tokenizers/candidates/index.json");
  assert.deepEqual(example.settings.models.map(e => e.tariff.model).sort(), approved.map(m => m.model).sort());
  Models.entries(example.settings);
  for (const { tariff, tokenizer } of example.settings.models) {
    const model = approved.find(m => m.model === tariff.model), indexed = index.models.find(m => m.model === tariff.model);
    const file = path.resolve(__dirname, "../lib/koin-network/tokenizers/candidates", indexed.manifest), bytes = fs.readFileSync(file);
    assert.equal(P.hash(bytes), indexed.manifestFileSha256, tariff.model + " manifest pin");
    assert.deepEqual(tokenizer, JSON.parse(bytes), tariff.model + " prepared tokenizer");
    assert.equal(tariff.modelHash, model.modelHash);
    assert.equal(tariff.inputAtomsPerMillion, model.usdAtomsPerMillion.input);
    assert.equal(tariff.outputAtomsPerMillion, model.usdAtomsPerMillion.output);
  }
});

function entry(alias) {
  const model = approved.find(m => m.model === alias);
  // Deliberately synthetic tokenizer bytes: these test configuration and staging,
  // never invoke a tokenizer or establish production model calibration.
  const tokenizer = { schema: 1, mode: "shadow", model: alias, modelHash: model.modelHash,
    revision: "a".repeat(40), repository: "isolated/fixture", tokenizerHash: artifactHash,
    configHash: artifactHash, templateHash: "b".repeat(64), vectors: ["A", "B", "C"].map((text, i) => ({ text, count: 1, idsHash: P.hash(JSON.stringify([i])) })) };
  const tariff = { version: 1, model: alias, modelHash: model.modelHash, tokenizerHash: artifactHash,
    templateHash: tokenizer.templateHash, inputAtomsPerMillion: model.usdAtomsPerMillion.input,
    outputAtomsPerMillion: model.usdAtomsPerMillion.output, contextTokens: 4096, maxOutputTokens: 256, maxLatencyMs: 120000 };
  return { tariff, tokenizer };
}
function input() {
  return { mode: "mainnet-prepaid-usd-plan", rpc: ["https://rpc-a.example", "https://rpc-b.example"],
    settings: { owner, schedulerUrl: "https://credits.example/scheduler", deployRcLimit: "10000", maxRcPerTransaction: "100", maxRcPerDay: "1000",
      accountMode: "public", purchaseQuoteBudget: { schema: 1, dailyQuoteAuthorizationUsdAtoms: "100000000", accountDailyQuoteAuthorizationUsdAtoms: "100000000" }, limits: { amount: "100", perJob: "1000000", maxJobs: 10, durationMs: 60000 },
      models: [entry("koinos-fast"), entry("koinos-balanced")] },
    funding: { buyerCreditsAtoms: "100", rewardPoolAtoms: "100", maxTotalKoinAtoms: "1100", roles: Object.fromEntries(ROLES.map(r => [r, "100"])) } };
}
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-multi-deploy-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function write(file, value) { fs.writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 }); }
const provider = () => ({ getChainId: async () => MAINNET_CHAIN,
  invokeGetContractAddress: async () => ({ value: { address: MAINNET_TOKEN } }),
  invokeGetContractMetadata: async () => ({ value: { hash: "0x1220" + "a".repeat(64) } }) });

test("USD model settings commit both exact rates and identities without silently reverting to Fast", () => {
  const c = input(); assert.equal(configuration(c).total, "1100");
  const models = runtimeModels(c.settings);
  assert.equal(models.schema, 2); assert.equal(models.tariff, undefined); assert.equal(models.tokenizer, undefined);
  assert.deepEqual(models.models.map(e => e.tariff.model), ["koinos-balanced", "koinos-fast"]);
  assert.equal(models.policyHash, Models.policyHash(models));
  const fastOnly = runtimeModels({ models: [entry("koinos-fast")] });
  assert.notEqual(models.policyHash, fastOnly.policyHash);
  for (const change of [
    c => { c.settings.models = []; },
    c => { c.settings.tariff = c.settings.models[0].tariff; },
    c => { c.settings.models[1] = c.settings.models[0]; },
    c => { c.settings.models[1].tokenizer = null; },
    c => { c.settings.models[1].tariff.modelHash = "c".repeat(64); c.settings.models[1].tokenizer.modelHash = "c".repeat(64); },
    c => { c.settings.models[1].tariff.inputAtomsPerMillion = "1"; },
    c => { c.settings.models[1].tariff.model = "private-openai"; c.settings.models[1].tokenizer.model = "private-openai"; },
    c => { c.settings.models[1].tariff.version = 2; },
    c => { c.mode = "mainnet-pilot-plan"; },
  ]) { const changed = input(); change(changed); assert.throws(() => configuration(changed)); }
});
test("public USD setup requires explicit global and per-account quote authorization amounts", () => {
  for (const change of [c => delete c.settings.purchaseQuoteBudget,
    c => delete c.settings.purchaseQuoteBudget.accountDailyQuoteAuthorizationUsdAtoms,
    c => c.settings.purchaseQuoteBudget.dailyQuoteAuthorizationUsdAtoms = null,
    c => c.settings.purchaseQuoteBudget.accountDailyQuoteAuthorizationUsdAtoms = "100000001"]) {
    const c = input(); change(c); assert.throws(() => configuration(c), /quote authorization budgets/);
  }
});

test("per-model free and qualification settings cannot name an unpriced model", () => {
  const c = input();
  c.settings.freePolicy = { version: 1, accountConcurrent: 1, accountDaily: "1", networkDaily: "2", originDaily: "1", eligibleModels: ["private-openai"] };
  assert.throws(() => configuration(c), /Free-credit models/);
  c.settings.freePolicy.eligibleModels = ["koinos-fast"]; assert.equal(configuration(c).total, "1100");
  c.settings.qualificationPolicies = [{ model: "unpriced" }]; assert.throws(() => configuration(c), /Unknown or duplicate/);
  c.settings.qualificationPolicies = []; assert.throws(() => configuration(c), /Explicit per-model/);
  c.settings.qualificationPolicy = {}; assert.throws(() => configuration(c), /one qualification/);
});

test("multi-model prepare and configure are idempotent and preserve the whole catalog in the reviewed plan", async t => {
  const dir = temp(t), file = path.join(dir, "settings.json"), bootstrap = path.join(dir, "bootstrap"), c = input();
  write(file, c);
  for (const kind of ["prepaid-usd", "rewards"]) fs.writeFileSync(path.join(dir, kind + ".wasm"), Buffer.from("0061736d01000000", "hex"));
  const prepared = await prepare(bootstrap, file, dir, { providerFactory: provider });
  const first = await configure(bootstrap, prepared.planHash, provider), before = fs.readFileSync(path.join(bootstrap, "runtime.json"));
  assert.equal(first.deployed, false); assert.deepEqual(await configure(bootstrap, prepared.planHash, provider), first);
  assert.deepEqual(fs.readFileSync(path.join(bootstrap, "runtime.json")), before);
  const runtime = JSON.parse(before), plan = JSON.parse(fs.readFileSync(path.join(bootstrap, "deployment-plan.json")));
  assert.equal(runtime.schema, 2); assert.equal(runtime.models.length, 2); assert.equal(runtime.tariff, undefined);
  assert.equal(runtime.policyHash, Models.policyHash(runtime)); assert.deepEqual(plan.runtime, runtime);
  assert.equal(fs.existsSync(path.join(bootstrap, "invitations.json")), false);
  assert.equal(fs.existsSync(path.join(bootstrap, "deployment-journal")), false);
});

function stageFixture(t) {
  const dir = temp(t), bootstrap = path.join(dir, "bootstrap"), stage = path.join(dir, "stage"), auth = path.join(dir, "auth.json");
  fs.mkdirSync(bootstrap, { mode: 0o700 }); fs.mkdirSync(stage, { mode: 0o700 });
  const runtime = { ...runtimeModels(input().settings), version: 1, accountMode: "public", deployment: { product: "prepaid-usd-v1" } };
  write(path.join(bootstrap, "runtime.json"), runtime); write(path.join(bootstrap, "runtime-keys.json"), {});
  write(path.join(bootstrap, "qualifications.json"), []); fs.writeFileSync(path.join(bootstrap, "operator-secret"), "a".repeat(64), { mode: 0o600 });
  write(auth, { SMTP_HOST: "smtp.example.invalid", SMTP_FROM: "isolated@example.invalid" });
  for (const { tariff } of runtime.models) {
    const pack = path.join(bootstrap, "tokenizer", tariff.model); fs.mkdirSync(pack, { recursive: true, mode: 0o700 });
    for (const name of ["tokenizer.json", "tokenizer_config.json"]) write(path.join(pack, name), artifact);
  }
  return { dir, bootstrap, stage, auth, runtime };
}

test("multi-model installation copies every pinned pack into its own read-only service path", t => {
  const f = stageFixture(t), result = stageConfiguration(f.bootstrap, f.stage, f.auth);
  assert.deepEqual(result, { accountMode: "public", parityInstalled: false });
  assert.deepEqual(fs.readdirSync(path.join(f.stage, "tokenizer")).sort(), ["koinos-balanced", "koinos-fast"]);
  for (const { tariff } of f.runtime.models) for (const name of ["tokenizer.json", "tokenizer_config.json"]) {
    const staged = path.join(f.stage, "tokenizer", tariff.model, name);
    assert.deepEqual(fs.readFileSync(staged), artifact); assert.equal(fs.statSync(staged).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readFileSync(path.join(f.stage, "runtime.json")), fs.readFileSync(path.join(f.bootstrap, "runtime.json")));
});

test("missing, changed or linked model packs fail before any configuration is staged", t => {
  for (const mutate of [
    f => fs.unlinkSync(path.join(f.bootstrap, "tokenizer/koinos-balanced/tokenizer.json")),
    f => fs.writeFileSync(path.join(f.bootstrap, "tokenizer/koinos-balanced/tokenizer.json"), "changed"),
    f => { const pack = path.join(f.bootstrap, "tokenizer/koinos-balanced"), moved = path.join(f.dir, "moved"); fs.renameSync(pack, moved); fs.symlinkSync(moved, pack); },
  ]) {
    const f = stageFixture(t); mutate(f);
    assert.throws(() => stageConfiguration(f.bootstrap, f.stage, f.auth)); assert.deepEqual(fs.readdirSync(f.stage), []);
  }
});

test("multi-model installer accepts larger pinned template configuration within the loader's shared bound", t => {
  const f = stageFixture(t), data = Buffer.from(JSON.stringify({ chat_template: "x".repeat(141000) }));
  const entry = f.runtime.models.find(e => e.tariff.model === "koinos-balanced");
  entry.tokenizer.configHash = P.hash(data);
  write(path.join(f.bootstrap, "runtime.json"), f.runtime);
  write(path.join(f.bootstrap, "tokenizer/koinos-balanced/tokenizer_config.json"), data);
  stageConfiguration(f.bootstrap, f.stage, f.auth);
  assert.deepEqual(fs.readFileSync(path.join(f.stage, "tokenizer/koinos-balanced/tokenizer_config.json")), data);
});
