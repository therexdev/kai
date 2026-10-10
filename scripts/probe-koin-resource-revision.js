"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Signer } = require("koilib"), P = require("../lib/koin-network/job-protocol");
const { prepare, MAINNET_CHAIN, MAINNET_TOKEN, ROLES } = require("../deploy/koin-mainnet/prepare");
const { configure, reviseResources, currentResourceRevision, reviewedPlan } = require("../deploy/koin-mainnet/setup");
const { TestDeployer } = require("../lib/koin-network/test-deployer");
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-resource-revision-")), directory = path.join(root, "bootstrap");
  let journal; t.after(() => { journal?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = { mode: "mainnet-pilot-plan", rpc: ["https://one.invalid", "https://two.invalid"],
    settings: { owner: Signer.fromSeed("resource-revision-buyer").getAddress(), schedulerUrl: "https://test.invalid/scheduler", deployRcLimit: "100000000",
      maxRcPerTransaction: "100000000", maxRcPerDay: "1000000000", limits: { amount: "10000000", perJob: "1000000", maxJobs: 10, durationMs: 3600000 },
      tariff: { inputAtomsPerMillion: "100000000", outputAtomsPerMillion: "400000000", contextTokens: 8192, maxOutputTokens: 256, maxLatencyMs: 120000 } },
    funding: { buyerCreditsAtoms: "100000000", rewardPoolAtoms: "1500000000", maxTotalKoinAtoms: "100000000000",
      roles: Object.fromEntries(ROLES.map(r => [r, ["admin", "mining", "operations"].includes(r) ? "0" : "500000000"])) } };
  const file = path.join(root, "settings.json"); fs.writeFileSync(file, JSON.stringify(config));
  const wasm = Buffer.from("0061736d01000000", "hex");
  for (const kind of ["credits", "rewards"]) fs.writeFileSync(path.join(root, kind + ".wasm"), wasm);
  const calls = [], controls = { rc: "500000000", nonce: "KAE=", seen: false, contract: false, stale: false, wrongChain: false, fail: false };
  const providerFactory = url => ({
    getChainId: async () => controls.wrongChain ? "wrong" : MAINNET_CHAIN,
    invokeGetContractAddress: async () => ({ value: { address: MAINNET_TOKEN } }),
    invokeGetContractMetadata: async account => account === MAINNET_TOKEN || controls.contract ? ({ value: { hash: "0x1220" + "a".repeat(64) } }) : undefined,
    getHeadInfo: async () => ({ head_block_time: String(controls.stale ? 0 : Date.now()) }),
    getAccountRc: async () => controls.rc,
    getNextNonce: async () => controls.nonce,
    getTransactionsById: async () => { if (controls.fail) throw Error("RPC unavailable"); return { transactions: controls.seen ? [{}] : [] }; },
    call: async (method, body) => { calls.push({ url, method, body: structuredClone(body) });
      if (BigInt(body.transaction.header.rc_limit) < 3800000000n) throw Error("insufficient rc");
      return { receipt: { id: body.transaction.id, rc_used: "3800000000" } }; }
  });
  const boot = await prepare(directory, file, root, { providerFactory }), ready = await configure(directory, boot.planHash, providerFactory);
  const plan = JSON.parse(fs.readFileSync(path.join(directory, "deployment-plan.json"))), keys = JSON.parse(fs.readFileSync(path.join(directory, "offline-keys.json")));
  const signer = Signer.fromWif(keys.credits), provider = providerFactory(config.rpc[0]);
  const options = { provider, identity: ready.planHash, tokenHash: plan.runtime.deployment.tokenHash, mode: "mainnet-pilot" };
  const open = () => { journal?.close(); journal = new TestDeployer(path.join(directory, "deployment-journal"), options); return journal; };
  const close = () => { journal?.close(); journal = null; };
  const operations = [{ upload_contract: { contract_id: signer.getAddress(), bytecode: wasm.toString("base64url") } }];
  open(); const first = await journal.prepare("credits:upload", operations, signer, plan.deployRcLimit);
  await assert.rejects(journal.submit("credits:upload", ready.planHash), /insufficient rc/); close(); calls.length = 0;
  return { root, directory, plan, first, signer, operations, controls, calls, provider, providerFactory, open, close,
    revise: (limit = "7500000000", balance = "10000000000") => reviseResources(directory, ready.planHash, limit, balance, providerFactory) };
}
test("resource revision retains keys, original plans and envelope; requires its new approval and never broadcasts during revision", async t => {
  const f = await fixture(t), before = Object.fromEntries(["offline-keys.json", "runtime-keys.json", "runtime.json", "plan.json", "deployment-plan.json", "owner-access.json"].map(n => [n, fs.readFileSync(path.join(f.directory, n), "utf8")]));
  const result = await f.revise(); assert.equal(f.calls.length, 0); assert.equal(result.funding.totalKoin, "236.00000000");
  assert.equal(result.funding.maxTotalKoinAtoms, "100000000000"); assert.equal(result.supersededTxId, f.first.draft.id);
  assert.notEqual(result.planHash, result.originalPlanHash); assert.equal(result.deployRcLimit, "7500000000");
  for (const [n, text] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(f.directory, n), "utf8"), text);
  assert.deepEqual(await f.revise(), result);
  await assert.rejects(f.revise("8000000000"), /cannot be replaced/);
  let journal = f.open(); assert.equal(journal.get("credits:upload").state, "superseded");
  assert.deepEqual(journal.get("credits:upload").transaction, f.first.transaction);
  await assert.rejects(journal.submit("credits:upload", result.originalPlanHash), /exact deployment plan/);
  f.controls.rc = "10000000000";
  const replacement = await journal.prepare("credits:upload", f.operations, f.signer, await journal.deploymentLimit("credits:upload", result.deployRcLimit, f.signer.getAddress()));
  assert.deepEqual(replacement.superseded.transaction, f.first.transaction); assert.equal(replacement.superseded.attempts, 0);
  assert.equal(replacement.draft.header.nonce, f.first.draft.header.nonce); assert.notEqual(replacement.draft.id, f.first.draft.id);
  assert.deepEqual(replacement.draft.operations, f.first.draft.operations);
  await assert.rejects(journal.submit("credits:upload", result.originalPlanHash), /exact deployment plan/);
  await journal.submit("credits:upload", result.planHash);
  assert.deepEqual(f.calls.map(c => c.body.broadcast), [false, true]);
  assert.equal(journal.get("credits:upload").simulation.rcUsed, "3800000000");
  journal = f.open(); assert.deepEqual(journal.get("credits:upload").transaction, replacement.transaction);
  f.controls.rc = "1000000000";
  assert.equal(await journal.deploymentLimit("credits:upload", result.deployRcLimit, f.signer.getAddress()), result.deployRcLimit);
  assert.equal(await journal.deploymentLimit("credits:initialize", result.deployRcLimit, f.signer.getAddress()), f.controls.rc);
  f.close(); assert.equal(currentResourceRevision(f.directory, reviewedPlan(f.directory)).planHash, result.planHash);
});
for (const flag of ["seen", "contract", "stale", "wrongChain", "fail"]) test("resource revision refuses " + flag + " chain evidence without retiring the saved upload", async t => {
  const f = await fixture(t); f.controls[flag] = true;
  await assert.rejects(f.revise()); assert.equal(f.calls.length, 0);
  const j = f.open(); assert.equal(j.resourceRevision(), null); assert.equal(j.get("credits:upload").state, "signed");
  assert.deepEqual(j.get("credits:upload").transaction, f.first.transaction);
});
test("resource revision refuses a changed nonce or any prior broadcast attempt", async t => {
  const f = await fixture(t); f.controls.nonce = "KAI=";
  await assert.rejects(f.revise(), /already used|pending/); f.controls.nonce = "KAE=";
  let j = f.open();
  j.guard.write(j.db, () => { const r = j.get("credits:upload"); r.attempts = 1; r.lastAttempt = Date.now(); j.save(r); }); f.close();
  await assert.rejects(f.revise(), /never broadcast/);
  j = f.open(); assert.equal(j.resourceRevision(), null); assert.equal(j.get("credits:upload").attempts, 1);
});
test("resource revision refuses changed custody bytecode without deleting the original signature", async t => {
  const f = await fixture(t); let j = f.open();
  j.guard.write(j.db, () => { const r = j.get("credits:upload"); r.draft.operations[0].upload_contract.bytecode = "AGFzbQEAAAAB"; j.save(r); }); f.close();
  await assert.rejects(f.revise(), /reviewed custody code/);
  j = f.open(); assert.equal(j.resourceRevision(), null); assert.deepEqual(j.get("credits:upload").transaction, f.first.transaction);
});
test("a concurrent resource review cannot retire an upload after a broadcast attempt appears", async t => {
  const f = await fixture(t), j = f.open(), providers = [f.providerFactory("one"), f.providerFactory("two")];
  const getHead = providers[1].getHeadInfo;
  providers[1].getHeadInfo = async () => {
    j.guard.write(j.db, () => { const r = j.get("credits:upload"); r.attempts = 1; r.lastAttempt = Date.now(); j.save(r); });
    return getHead();
  };
  await assert.rejects(j.reviseResources(f.plan, "7500000000", "10000000000", providers), /changed during resource review/);
  assert.equal(j.resourceRevision(), null); assert.equal(j.get("credits:upload").attempts, 1);
});
test("resource revision rejects budget increases beyond the pilot cap and preserves reviewed runtime limits", async t => {
  const f = await fixture(t);
  for (const [limit, balance] of [["7500000000", "60000000000"], ["7500000000", "500000000"], ["100000000", "10000000000"], ["7.5", "10000000000"]]) await assert.rejects(f.revise(limit, balance));
  const result = await f.revise(), j = f.open(), revised = j.resourceRevision().plan;
  assert.deepEqual(revised.runtime, f.plan.runtime); assert.deepEqual(revised.artifacts, f.plan.artifacts); assert.deepEqual(revised.limits, f.plan.limits);
  assert.deepEqual(revised.fundingAddresses, f.plan.fundingAddresses); assert.equal(revised.owner, f.plan.owner);
  assert.equal(result.funding.buyerCreditsAtoms, f.plan.funding.buyerCreditsAtoms); assert.equal(result.funding.rewardPoolAtoms, f.plan.funding.rewardPoolAtoms);
});
test("a revised upload cannot change operations or nonce, exceed its ceiling, or use the original low limit", async t => {
  const f = await fixture(t); await f.revise(); const j = f.open(); f.controls.rc = "10000000000";
  await assert.rejects(j.prepare("credits:upload", [{ upload_contract: { ...f.operations[0].upload_contract, bytecode: "changed" } }], f.signer, "7500000000"), /original operations/);
  await assert.rejects(j.prepare("credits:upload", f.operations, f.signer, "7500000001"), /ceiling/);
  await assert.rejects(j.prepare("credits:upload", f.operations, f.signer, "100000000"), /original operations/);
  f.controls.nonce = "KAI=";
  await assert.rejects(j.prepare("credits:upload", f.operations, f.signer, "7500000000"), /original operations/);
  assert.equal(j.get("credits:upload").state, "superseded"); assert.equal(f.calls.length, 0);
});
