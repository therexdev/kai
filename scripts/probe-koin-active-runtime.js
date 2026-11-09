"use strict";
// Full constructor and journal lifecycle with an isolated chain, a tiny pinned
// tokenizer and generated fixture identities. No chain read or signer is used.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer, utils } = require("koilib");
const { TestRuntime } = require("../lib/koin-network/test-runtime");
const { KoinChain } = require("../lib/koin-network/chain");
const { Meter } = require("../lib/koin-network/metering");
const { loadTokenizer } = require("../lib/koin-network/tokenizer");
const { rewardStorageStatus } = require("../lib/koin-network/earning-health");
const Activation = require("../lib/koin-network/shadow-storage-activation");
const P = require("../lib/koin-network/job-protocol"), { DAY } = require("../lib/koin-network/policy");

function tokenizerFixture(directory) {
  fs.mkdirSync(directory);
  const tokenizer = { version: "1.0", truncation: null, padding: null, added_tokens: [], normalizer: null,
    pre_tokenizer: { type: "Whitespace" }, post_processor: null, decoder: null,
    model: { type: "WordLevel", vocab: { "[UNK]": 0, hello: 1, world: 2 }, unk_token: "[UNK]" } };
  const config = { chat_template: "{% for message in messages %}{{ message.content }} {% endfor %}", bos_token: "", eos_token: "", unk_token: "[UNK]" };
  const json = JSON.stringify(tokenizer), configJson = JSON.stringify(config);
  fs.writeFileSync(path.join(directory, "tokenizer.json"), json);
  fs.writeFileSync(path.join(directory, "tokenizer_config.json"), configJson);
  const manifest = { schema: 1, mode: "shadow", model: "fixture-runtime", modelHash: P.hash("fixture-runtime-model"),
    repository: "fixture/tokenizer", revision: "a".repeat(40), tokenizerHash: P.hash(json), configHash: P.hash(configJson), templateHash: P.hash(config.chat_template),
    vectors: [{ text: "hello", count: 1, idsHash: P.hash("[1]") }, { text: "world", count: 1, idsHash: P.hash("[2]") },
      { messages: [{ role: "user", content: "hello world" }], count: 2, idsHash: P.hash("[1,2]"), promptHash: P.hash("hello world ") }] };
  const tariff = { version: 1, model: manifest.model, modelHash: manifest.modelHash, tokenizerHash: manifest.tokenizerHash,
    templateHash: manifest.templateHash, inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000",
    contextTokens: 4096, maxOutputTokens: 64, maxLatencyMs: 5000 };
  const meter = new Meter([{ tariff, adapter: loadTokenizer(directory, manifest) }]);
  return { tokenizer: manifest, tariff, policyHash: meter.policyHash };
}

test("the complete public runtime stays legacy by default, activates an idle worker explicitly and reopens after clean drain", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-active-runtime-")), stateDir = path.join(directory, "state");
  let runtime = null, now = DAY, forbiddenCalls = 0;
  t.after(async () => { if (runtime) await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const address = name => Signer.fromSeed("active-runtime-fixture-" + name).address;
  const deployment = { schema: 1, network: "isolated", decimals: 8, rpc: ["http://127.0.0.1:1"],
    chainId: utils.encodeBase64url(Buffer.from("1220" + P.hash("active-runtime-fixture-chain"), "hex")), product: "prepaid-usd-v1",
    ...Object.fromEntries(["token", "credits", "rewards", "admin", "verifier", "mining", "operations", "masterNode"].map(name => [name, address(name)])),
    ...Object.fromEntries(["token", "credits", "rewards"].map(name => [name + "Hash", "0x1220" + P.hash("fixture-" + name)])) };
  const forbidden = () => { forbiddenCalls++; throw Error("Storage startup must not read a chain or sign a transaction"); };
  const provider = new Proxy({}, { get: () => forbidden }), client = new KoinChain(deployment, provider);
  const tokenizerDir = path.join(directory, "tokenizer"), tokenizer = tokenizerFixture(tokenizerDir);
  const config = { schema: 1, mode: "isolated-rehearsal", deployment, schedulerUrl: "http://127.0.0.1:1/scheduler", accountMode: "public",
    version: 1, ...tokenizer, roles: { settlement: address("settlement"), lifecycle: address("lifecycle"), claims: address("claims") },
    maxRcPerTransaction: "1000000", maxRcPerDay: "10000000" };
  const qualificationsFile = path.join(directory, "qualifications.json"); fs.writeFileSync(qualificationsFile, "[]");
  const signers = Object.fromEntries([deployment.verifier, ...Object.values(config.roles)].map(a => [a, { signHash: forbidden, signTransaction: forbidden }]));
  const accountService = { configureWalletCredits() {}, accountView: () => ({ wallets: [] }) };
  const open = () => new TestRuntime({ config, stateDir, signers, qualificationsFile, tokenizerDir,
    operatorSecret: "isolated-storage-fixture-secret", client, accountService, clock: () => now });

  runtime = open();
  assert.equal(rewardStorageStatus(runtime).mode, "legacy-json");
  assert.equal(runtime.providerDevices.pendingPresenceStatus().enabled, false);
  const shadow = runtime.scheduler.koinShadow.ledger, wallet = address("provider");
  shadow.open("100000000000");
  shadow.qualify({ address: wallet, capacityId: "fixture-capacity", model: tokenizer.tariff.model, modelHash: tokenizer.tariff.modelHash,
    benchmarkHash: P.hash("fixture-benchmark"), modelWeight: "10000", coverageBps: 10000, expires: DAY * 2 });
  for (let index = 0; index < 4; index++) {
    now = DAY + index * 25000;
    shadow.observe(wallet, { schema: 1, session: "a".repeat(32), sequence: index, at: now, model: tokenizer.tariff.model, modelHash: tokenizer.tariff.modelHash, ready: true });
  }
  now = DAY + 105001; shadow.tick();
  const budget = shadow.getBudget("1"), availability = shadow.getAvailability("1", wallet), evidence = shadow.getManifestEvidence("1", { workBasis: "usd-pool" });
  await runtime.close(); runtime = null;

  const identity = Activation.storageIdentity(config), options = { stateDir, identity, assertQuiescent() { assert.equal(runtime, null); } };
  Activation.prepareStorage(options); Activation.activateStorage(options);
  const paths = Activation.storagePaths(stateDir), sentinel = fs.readFileSync(paths.sourceFile);
  for (let restart = 0; restart < 2; restart++) {
    runtime = open();
    assert.equal(runtime.providerDevices.pendingPresenceStatus().enabled, true);
    assert.deepEqual(rewardStorageStatus(runtime), { schema: 1, mode: "sqlite-shadow", ready: false, initialized: false,
      worker: { state: "new", ready: false, projectionAgeMs: null, queueDepth: 0 } });
    await runtime.initialize();
    const status = rewardStorageStatus(runtime);
    assert.equal(status.ready, true); assert.equal(status.initialized, true); assert.equal(status.worker.state, "ready");
    assert.equal(runtime.providerDevices.pendingPresenceStatus().pending, 0);
    assert.deepEqual(runtime.scheduler.koinShadow.ledger.getBudget("1"), budget);
    assert.deepEqual(runtime.scheduler.koinShadow.ledger.getAvailability("1", wallet), availability);
    assert.deepEqual(await runtime.scheduler.koinShadow.ledger.getManifestEvidence("1", { workBasis: "usd-pool" }), evidence);
    const closedRuntime = runtime; await runtime.close(); runtime = null;
    assert.equal(rewardStorageStatus(closedRuntime).ready, false);
    assert.equal(rewardStorageStatus(closedRuntime).worker.state, "closed");
    assert.deepEqual(fs.readFileSync(paths.sourceFile), sentinel, "worker runtime never overwrites the legacy downgrade sentinel");
  }
  assert.equal(forbiddenCalls, 0);
});
