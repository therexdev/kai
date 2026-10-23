"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer, Serializer, utils } = require("koilib");
const { prepare, verifyIdentity, MAINNET_CHAIN, MAINNET_TOKEN, ROLES } = require("../deploy/koin-mainnet/prepare");
const { configure, checkFunding } = require("../deploy/koin-mainnet/setup");
const { deploy } = require("../deploy/koin-test/setup");
const { TestDeployer } = require("../lib/koin-network/test-deployer");
const urls = ["https://one.invalid", "https://two.invalid"], tokenHash = "0x1220" + "a".repeat(64);
const reply = (r, result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
const unavailable = () => new Response("unavailable", { status: 503 });
const nestedBytes = bytes => Buffer.concat([Buffer.from([10, bytes.length + 2, 10, bytes.length]), bytes]).toString("base64url");
function identity(r) {
  if (r.method === "chain.get_chain_id") return { chain_id: MAINNET_CHAIN };
  if (r.method === "chain.invoke_system_call") {
    if (r.params.name === "get_contract_address") return { value: nestedBytes(Buffer.from(utils.decodeBase58(MAINNET_TOKEN))) };
    if (r.params.name === "get_contract_metadata") return { value: nestedBytes(Buffer.from(tokenHash.slice(2), "hex")) };
  }
  throw Error("Unexpected fixture RPC " + r.method);
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-deployment-rpc-")), bootstrap = path.join(directory, "bootstrap");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settings = { mode: "mainnet-pilot-plan", rpc: urls,
    settings: { owner: Signer.fromSeed("deployment-rpc-buyer").getAddress(), schedulerUrl: "https://credits.invalid/scheduler",
      deployRcLimit: "7500000000", maxRcPerTransaction: "100000000", maxRcPerDay: "500000000",
      limits: { amount: "10000000", perJob: "1000000", maxJobs: 10, durationMs: 3600000 },
      tariff: { inputAtomsPerMillion: "100000000", outputAtomsPerMillion: "400000000", contextTokens: 8192, maxOutputTokens: 256, maxLatencyMs: 120000 } },
    funding: { buyerCreditsAtoms: "100000000", rewardPoolAtoms: "1000000000000", maxTotalKoinAtoms: "1100000000000",
      roles: Object.fromEntries(ROLES.map(r => [r, ["credits", "rewards"].includes(r) ? "10000000000" : "1000000000"])) } };
  const file = path.join(directory, "settings.json"); fs.writeFileSync(file, JSON.stringify(settings));
  for (const kind of ["credits", "rewards"]) fs.writeFileSync(path.join(directory, kind + ".wasm"), Buffer.from("0061736d01000000", "hex"));
  const providerFactory = () => ({ getChainId: async () => MAINNET_CHAIN,
    invokeGetContractAddress: async () => ({ value: { address: MAINNET_TOKEN } }),
    invokeGetContractMetadata: async () => ({ value: { hash: tokenHash } }) });
  const plan = await prepare(bootstrap, file, directory, { providerFactory });
  const configured = await configure(bootstrap, plan.planHash, providerFactory);
  return { directory, bootstrap, planHash: configured.planHash,
    deploy: () => deploy(bootstrap, directory, configured.planHash, { planFile: "deployment-plan.json", hashFile: "deployment-plan.sha256" }),
    step: () => {
      const journal = new TestDeployer(path.join(bootstrap, "deployment-journal"), { identity: configured.planHash, tokenHash, mode: "mainnet-pilot" });
      try { return journal.get("credits:upload"); } finally { journal.close(); }
    } };
}
test("identity verification retries a transient 503 on its original host and still checks both hosts", async t => {
  const seen = []; let failed = false;
  t.mock.method(globalThis, "fetch", async (url, request) => {
    const r = JSON.parse(request.body); seen.push(url);
    if (url === urls[0] && !failed) { failed = true; return unavailable(); }
    return reply(r, identity(r));
  });
  const evidence = await verifyIdentity(urls);
  assert.deepEqual(evidence.map(e => e.rpc), urls);
  assert.ok(evidence.every(e => e.tokenHash === tokenHash));
  assert.equal(seen.filter(u => u === urls[0]).length, 6);
});
test("a permanently unavailable identity host stops after three attempts without substituting the backup", async t => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async url => { seen.push(url); return unavailable(); });
  await assert.rejects(verifyIdentity(urls), /identity check at one.invalid/);
  assert.deepEqual(seen, [urls[0], urls[0], urls[0]]);
});
test("a wrong-chain identity response stops immediately", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, request) => { calls++; return reply(JSON.parse(request.body), { chain_id: "wrong-chain" }); });
  await assert.rejects(verifyIdentity(urls), /chain mismatch/);
  assert.equal(calls, 1);
});
test("funding checks use the chain-pinned backup after primary balance-read failure", async t => {
  const f = await fixture(t), reads = [], native = new Serializer(utils.tokenAbi.types);
  const balance = utils.encodeBase64url(await native.serialize({ value: "10000000000" }, utils.tokenAbi.methods.balanceOf.return));
  t.mock.method(globalThis, "fetch", async (url, request) => {
    const r = JSON.parse(request.body);
    if (r.method === "chain.read_contract") {
      reads.push(url); return url === urls[0] ? unavailable() : reply(r, { result: balance });
    }
    if (r.method === "chain.get_account_rc") return reply(r, { rc: "10000000000" });
    return reply(r, identity(r));
  });
  const result = await checkFunding(f.bootstrap);
  assert.equal(result.ready, true); assert.equal(result.roles.length, 9);
  assert.deepEqual(reads, [urls[0], ...Array(9).fill(urls[1])]);
});
test("deployment fails over reads and simulation, sends once on a lost acknowledgment, then recovers its exact saved transaction", async t => {
  const f = await fixture(t), simulations = [], broadcasts = [], blockId = "0x1220" + "b".repeat(64);
  let phase = "submit", finalized = false;
  t.mock.method(globalThis, "fetch", async (url, request) => {
    const r = JSON.parse(request.body);
    if (r.method === "chain.get_account_rc") {
      // Stop the next, unsigned initialize step after recovering the upload.
      if (finalized) return unavailable();
      return reply(r, { rc: "10000000000" });
    }
    if (r.method === "chain.get_account_nonce") return reply(r, { nonce: "KAA=" });
    if (r.method === "chain.submit_transaction") {
      if (r.params.broadcast === false) {
        simulations.push({ url, tx: r.params.transaction });
        return url === urls[0] ? unavailable() : reply(r, { receipt: { id: r.params.transaction.id, rc_used: "1000000" } });
      }
      broadcasts.push({ url, tx: r.params.transaction }); return unavailable();
    }
    if (r.method === "transaction_store.get_transactions_by_id") {
      if (!broadcasts.length) return reply(r, { transactions: [] });
      if (phase === "submit") return unavailable();
      return reply(r, { transactions: [{ transaction: broadcasts[0].tx, containing_blocks: [blockId] }] });
    }
    if (r.method === "chain.get_head_info") return reply(r, { head_block_time: String(Date.now()), last_irreversible_block: "100", head_topology: { id: blockId, height: "100" } });
    if (r.method === "block_store.get_blocks_by_id") return reply(r, { block_items: [{ block_id: blockId, block_height: "10" }] });
    if (r.method === "block_store.get_blocks_by_height") {
      finalized = true;
      return reply(r, { block_items: [{ block_id: blockId, block_height: "10",
        block: { id: blockId, header: { height: "10" }, transactions: [broadcasts[0].tx] },
        receipt: { id: blockId, height: "10", transaction_receipts: [{ id: broadcasts[0].tx.id, rc_used: "1000000" }] } }] });
    }
    return reply(r, identity(r));
  });
  await assert.rejects(f.deploy(), /temporarily unavailable/);
  assert.deepEqual(simulations.map(s => s.url), urls);
  assert.equal(broadcasts.length, 1); assert.equal(broadcasts[0].url, urls[1]);
  assert.deepEqual(simulations[0].tx, simulations[1].tx);
  const saved = f.step(); assert.equal(saved.state, "signed"); assert.equal(saved.attempts, 1);
  assert.deepEqual(saved.transaction, broadcasts[0].tx);
  phase = "recover";
  await assert.rejects(f.deploy(), /temporarily unavailable/);
  const recovered = f.step(); assert.equal(recovered.state, "finalized"); assert.equal(recovered.attempts, 1);
  assert.deepEqual(recovered.transaction, saved.transaction);
  assert.equal(simulations.length, 2); assert.equal(broadcasts.length, 1);
});
