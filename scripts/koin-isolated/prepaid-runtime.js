"use strict";
// Real native KOIN, new WASM contracts, private desktop purchase/chat clients,
// scheduler HTTP, pinned tokenizer and signed provider receipts. No live funds.
const fs = require("fs"), path = require("path"), http = require("http"), assert = require("node:assert/strict");
const { Signer, utils, Contract } = require("koilib"), { EventEmitter } = require("events");
const { KoinChain } = require("../../lib/koin-network/chain"), { TestRuntime } = require("../../lib/koin-network/test-runtime");
const { Meter } = require("../../lib/koin-network/metering"), { loadTokenizer } = require("../../lib/koin-network/tokenizer");
const P = require("../../lib/koin-network/job-protocol"), { fundedResultHash, fundedChunkHash } = require("../../lib/koin-network/funded-protocol");
const tokenizer = require("../../lib/koin-network/tokenizers/qwen25-1.5b.json"), { bytes, pause } = require("./chain");
const enc = utils.encodeBase64url;
async function runPrepaidRuntime(chain, reportCheck, usd = false) {
  const product = usd ? "prepaid-usd-v1" : "prepaid-v1", prefix = usd ? "prepaid-usd" : "prepaid";
  const check = text => reportCheck((usd ? "USD: " : "") + text);
  const root = path.join(chain.directory, prefix + "-runtime"), desktop = chain.manifest.desktopDir;
  fs.mkdirSync(root, { mode: 0o700 });
  const legacyBalance = await chain.balance(chain.address("credits"));
  const credits = Signer.fromSeed("isolated-" + prefix + "-credits"), rewards = Signer.fromSeed("isolated-" + prefix + "-rewards");
  for (const [kind, signer, artifact] of [["credits", credits, prefix], ["rewards", rewards, "rewards"]]) {
    await chain.send("prepaid-deploy-" + kind, [{ upload_contract: { contract_id: signer.getAddress(), bytecode: enc(fs.readFileSync(chain.manifest.artifacts[artifact].wasm)) } }], signer, { payer: chain.keys.Genesis });
  }
  const old = await chain.walletClient(), deployment = { ...old.d, product, ...(usd ? { masterNode: chain.address("mining") } : {}), credits: credits.getAddress(), rewards: rewards.getAddress(),
    creditsHash: "0x1220" + chain.manifest.artifacts[prefix].sha256 };
  const client = new KoinChain(deployment, chain.provider), DesktopChain = require(path.join(desktop, "core/lib/koin-network/chain")).KoinChain;
  const walletClient = new DesktopChain(deployment, chain.provider), contractConfig = { ...chain.config, credits: bytes(deployment.credits), treasury: bytes(deployment.rewards), ...(usd ? { master_node: bytes(deployment.masterNode), reward_basis: 1 } : {}) };
  for (const [kind, signer] of [["credits", credits], ["rewards", rewards]]) await chain.send("prepaid-initialize-" + kind,
    [{ call_contract: await client.operation(kind, "initialize", { config: contractConfig }) }], signer, { payer: chain.keys.Genesis });
  await client.verify(); check("new prepaid and reward contracts deploy without changing legacy custody");
  // Exercise both values on each compiled contract with native authority and
  // storage, before the purchase/settlement/reward flow relies on them.
  for (const kind of ["credits", "rewards"]) {
    for (const paused of [true, false, true, false]) {
      await chain.send(prefix + "-" + kind + "-pause-" + paused,
        [{ call_contract: await client.operation(kind, "set_paused", { paused }) }], chain.actors.admin);
      assert.equal(Boolean((await client.read(kind, "config")).paused), paused);
    }
  }
  check("administrator pause and resume execute repeatedly in native prepaid and reward WASM");
  const masterBefore = usd ? BigInt(await chain.balance(deployment.masterNode)) : 0n;
  if (usd) {
    const { operation } = await new Contract({ id: deployment.token, abi: utils.tokenAbi }).functions.transfer({ from: chain.keys.Genesis.getAddress(), to: deployment.rewards, value: "1000000000000" }, { onlyOperation: true });
    await chain.send("usd-pool-seed-10000-KOIN", [operation], chain.keys.Genesis);
  }
  const owner = chain.address("buyer"), workerAddress = chain.address("alice"), tariff = { version: 1, model: tokenizer.model, modelHash: tokenizer.modelHash,
    tokenizerHash: tokenizer.tokenizerHash, templateHash: tokenizer.templateHash, inputAtomsPerMillion: "1000000000", outputAtomsPerMillion: "1000000000",
    contextTokens: 8192, maxOutputTokens: 8, maxLatencyMs: 120000 };
  const meter = new Meter([{ tariff, adapter: loadTokenizer(chain.manifest.tokenizerDir, tokenizer) }]);
  let runtime, journal, nativeReviews = 0, transportError, lost = false;
  const originalCall = chain.provider.call.bind(chain.provider), submitted = [];
  const server = http.createServer(async (req, res) => {
    try {
      req.url = req.url.replace(/^\/scheduler(?=\/)/, "");
      await runtime.scheduler.handle(req, res);
    } catch (e) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const schedulerUrl = `http://127.0.0.1:${server.address().port}/scheduler`, token = "test_" + "b".repeat(43);
  const accountsFile = path.join(root, "accounts.json"), qualificationsFile = path.join(root, "qualifications.json");
  fs.writeFileSync(accountsFile, JSON.stringify([{ accountId: "prepaid_customer", grantId: "unused_legacy_grant", owner, tokenHash: P.hash(token), enabled: true, expiresAt: chain.now + 86400000 }]));
  fs.writeFileSync(qualificationsFile, JSON.stringify([{ address: workerAddress, capacityId: "prepaid-native-fixture", model: tokenizer.model,
    modelHash: tokenizer.modelHash, benchmarkHash: P.hash("reviewed-fixture"), expires: chain.now + 86400000 }]));
  const roles = { settlement: chain.address("sponsor"), lifecycle: chain.address("lifecycle"), claims: chain.address("manual") };
  const signers = Object.fromEntries(["verifier", "sponsor", "lifecycle", "manual"].map(n => [chain.address(n), chain.actors[n]]));
  const config = { mode: "isolated-rehearsal", deployment, schedulerUrl, roles, tokenizer, tariff, version: 1, policyHash: meter.policyHash,
    maxRcPerTransaction: "10000000000", maxRcPerDay: "1000000000000" };
  const create = () => new TestRuntime({ config, stateDir: path.join(root, "backend"), accountsFile, qualificationsFile, tokenizerDir: chain.manifest.tokenizerDir,
    operatorSecret: "fixture-prepaid-encryption", signers, client, clock: () => chain.now,
    ...(usd ? { purchasePrice: { read: async () => ({ usdPerKoin: "25000000" }) } } : {}) });
  const finalize = async () => chain.finalize((await chain.provider.getHeadInfo()).head_topology.height);
  chain.provider.call = async (method, args) => {
    if (method !== "chain.submit_transaction" || args.broadcast === false) return originalCall(method, args);
    try {
      const tx = args.transaction, result = await originalCall(method, args);
      assert.ok(!submitted.includes(tx.id), "Already included prepaid transaction must not be broadcast again"); submitted.push(tx.id);
      const receipt = await chain.include("prepaid-submit", tx); assert.notEqual(receipt.reverted, true, JSON.stringify(receipt.logs));
      if (!lost && tx.operations[0].call_contract?.entry_point === client.abis.credits.methods.settle_usage.entry_point) {
        lost = true; throw Object.assign(Error("Lost prepaid settlement response"), { deliberate: true });
      }
      return result;
    } catch (e) { if (!e.deliberate) transportError = e; throw e; }
  };
  try {
    runtime = create();
    const paymentConfig = { schema: 1, ...config, owner, model: tokenizer.model, maxOutput: 8,
      limits: { amount: "10000000", perJob: "1000000", maxJobs: 3, durationMs: 3600000 } };
    const { FundingRecovery } = require(path.join(desktop, "electron/koin-funding-recovery")), { TestPayments } = require(path.join(desktop, "electron/koin-test-payments"));
    journal = new FundingRecovery(path.join(root, "desktop-journals"), { mode: config.mode, client: walletClient, maxRcPerDay: config.maxRcPerDay, clock: () => chain.now });
    const payments = new TestPayments({ config: paymentConfig, client: walletClient, journal, wallet: { address: owner, signer: chain.actors.buyer },
      purchaseQuote: async amount => {
        const response = await fetch(schedulerUrl + "/koin/prepaid/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken: token, amount }) });
        const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.args;
      },
      clock: () => chain.now, dialog: { showMessageBox: async (_window, review) => { assert.match(review.detail, /nonrefundable AI credits/); if (usd) { assert.match(review.detail, /USD credit value: \$0.025/); assert.ok(review.detail.includes(deployment.masterNode)); } nativeReviews++; return { response: 1 }; } } });
    const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
    const creditAtoms = usd ? "2500000" : "10000000";
    const bought = await payments.run(window, "purchase", "0.1"); if (transportError) throw transportError;
    assert.ok(bought.deposit?.txId, JSON.stringify(bought)); await finalize();
    if (usd) assert.equal(BigInt(await chain.balance(deployment.masterNode)) - masterBefore, 10000000n);
    assert.equal((await payments.run(window, "check", bought.deposit.id)).funding.state, "funded");
    const { PrepaidChat } = require(path.join(desktop, "electron/koin-prepaid-chat"));
    const progressEvents = [];
    const chat = new PrepaidChat({ file: path.join(root, "desktop-chat.json"), config: paymentConfig, payments, progress: event => progressEvents.push(event),
      storage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(b => b ^ 42), decryptString: b => b.map(n => n ^ 42).toString() },
      access: { authorize: () => ({ owner, sessionToken: token }) } });
    await chat.call("purchase", { txId: bought.deposit.txId });
    assert.equal((await runtime.scheduler.koinPrepaid.purchases.inspect(bought.deposit.txId, owner)).state, "finalized");
    await runtime.scheduler.koinPrepaid.purchases.tick();
    assert.equal((await chat.status()).balance.available, creditAtoms);
    await chat.call("purchase", { txId: bought.deposit.txId });
    assert.equal((await runtime.scheduler.koinPrepaid.purchases.inspect(bought.deposit.txId, owner)).state, "finalized");
    await runtime.scheduler.koinPrepaid.purchases.tick();
    assert.equal((await chat.status()).balance.available, creditAtoms);
    check("one native KOIN purchase approval creates prepaid credits once after irreversible confirmation");
    const worker = { address: workerAddress, proof: "signed", models: [tokenizer.model], lastSeen: chain.now,
      capabilities: { koinFundedRehearsalJobs: 1, koinMeteredStreaming: 1 } };
    const complete = async text => {
      runtime.scheduler.workers.set("prepaid-worker", worker); let error;
      const pending = chat.chat(window, { model: "koinos-network", messages: [{ role: "user", content: text }], max_tokens: 8 }, AbortSignal.timeout(30000)).catch(e => { error = e; });
      let job;
      for (let i = 0; !job; i++) { if (error) throw error; if (i > 300) throw Error("Prepaid provider did not receive chat"); job = await runtime.scheduler.koinPrepaid.work.next(worker); if (!job) await pause(10); }
      assert.equal(job.stream, true, "Use the current desktop's normal streaming path");
      const chunk = { jobId: job.id, output: "4", sequence: 1,
        signature: Buffer.from(await chain.actors.alice.signHash(fundedChunkHash(runtime.target, job, "4", 1))).toString("base64") };
      const sendChunk = () => fetch(schedulerUrl + "/koin/funded/rehearsal/chunk?token=prepaid-worker",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chunk) });
      const streamed = await sendChunk(); assert.equal(streamed.status, 200, await streamed.text());
      const streamedSpent = runtime.ledger.balance(owner).spent;
      const repeated = await sendChunk(); assert.equal(repeated.status, 200, await repeated.text());
      assert.equal(runtime.ledger.balance(owner).spent, streamedSpent, "Repeated signed prefix cannot debit twice");
      const signature = Buffer.from(await chain.actors.alice.signHash(fundedResultHash(runtime.target, job, "4"))).toString("base64");
      const reply = await fetch(schedulerUrl + "/koin/funded/rehearsal/result?token=prepaid-worker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id, output: "4", signature }) });
      assert.equal(reply.status, 200, await reply.text()); const answer = await pending; if (error) throw error;
      assert.equal(runtime.ledger.balance(owner).spent, streamedSpent, "Finalizing the same answer cannot debit its prefix twice");
      assert.deepEqual(progressEvents.filter(event => event?.requestId === job.id).map(event => event.delta), ["4"]);
      assert.equal(answer.choices[0].message.content, "4"); chat.acknowledge(answer.id); return answer;
    };
    const first = await complete("What is 2 + 2?");
    await runtime.prepaidSettlement.tick(); if (transportError) throw transportError; assert.equal(lost, true);
    const second = await complete("What is 3 + 1?"); assert.notEqual(second.id, first.id);
    assert.equal(nativeReviews, 1, "Chat must never request session approvals");
    check("normal desktop streaming chat verifies signed prefixes once while an earlier KOIN settlement response is lost");
    await runtime.close(); runtime = create();
    for (let n = 0; runtime.ledger.pendingJobs().length && n < 10; n++) { await finalize(); await runtime.prepaidSettlement.tick(); if (transportError) throw transportError; }
    assert.equal(runtime.ledger.pendingJobs().length, 0);
    const spent = runtime.ledger.balance(owner).spent, onchain = await client.read("credits", "balances", { account: bytes(owner) });
    assert.equal(onchain.prepaid.consumed, spent); assert.equal(onchain.balance.available, String(BigInt(creditAtoms) - BigInt(spent)));
    assert.equal(await chain.balance(deployment.credits), usd ? "0" : onchain.balance.available);
    if (usd) { assert.equal(await chain.balance(deployment.rewards), "1000000000000"); assert.equal(BigInt(await chain.balance(deployment.masterNode)) - masterBefore, 10000000n); }
    else assert.ok(BigInt(await chain.balance(deployment.rewards)) > 0n);
    assert.equal(await chain.balance(chain.address("credits")), legacyBalance);
    check(usd ? "USD usage settles once after restart without moving KOIN; independent 10,000 KOIN pool and legacy funds are preserved" : "prepaid usage settles once after restart, funds the reward pool, and preserves all legacy KOIN");
    const day = String(Math.floor(chain.now / 86400000)), providerBefore = BigInt(await chain.balance(workerAddress));
    const progress = async (label, done) => {
      for (let i = 0; i < 40; i++) {
        if (await done()) return;
        await runtime.tick(); if (transportError) throw transportError;
        await finalize(); await pause(100);
      }
      throw Error(label + " did not finish: " + JSON.stringify(runtime.status()));
    };
    await progress("prepaid daily opening", async () => !!(await client.read("rewards", "get_epoch", { epoch: day })).epoch?.opened_at);
    await chain.block([], (Number(day) + 1) * 86400000 + 10000);
    await progress("prepaid reward proposal", async () => BigInt((await client.read("rewards", "get_epoch", { epoch: day })).epoch?.review_until || "0") > 0n);
    const rewardDay = (await client.read("rewards", "get_epoch", { epoch: day })).epoch;
    if (usd) {
      const expected = require("../../lib/koin-network/policy").dailyBudget({ balance: "1000000000000", openedAt: Number(rewardDay.opened_at) });
      assert.equal(rewardDay.budget, expected.total); assert.equal(rewardDay.root.work, expected.work);
    }
    assert.equal(BigInt(await chain.balance(workerAddress)), providerBefore, "Provider payout must wait through review");
    await chain.block([], Number(rewardDay.review_until) + 1);
    await progress("prepaid provider payout", async () => runtime.claims.accountStatus(workerAddress).some(row => row.state === "paid"));
    const paid = BigInt(await chain.balance(workerAddress)) - providerBefore;
    assert.ok(paid > 0n); assert.equal(runtime.ledger.balance(owner).spent, spent);
    assert.equal(await chain.balance(chain.address("credits")), legacyBalance);
    check("new prepaid contracts pay the provider automatically without changing customer credits or legacy funds");
    return { passed: true, nativeReviews, requests: 2, spentAtoms: spent, creditAtoms: onchain.balance.available, providerPayoutAtoms: String(paid), submitted: submitted.length };
  } finally {
    chain.provider.call = originalCall; journal?.close(); await runtime?.close(); await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { runPrepaidRuntime };
