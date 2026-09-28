"use strict";
// Real custody contracts, tokenizer and desktop/backend clients on the peerless
// fixture chain. The worker answer is controlled: this is not a model benchmark.
const assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), http = require("http");
const { EventEmitter } = require("events");
const { TestRuntime } = require("../../lib/koin-network/test-runtime"), { KoinChain } = require("../../lib/koin-network/chain");
const { Meter } = require("../../lib/koin-network/metering"), { loadTokenizer } = require("../../lib/koin-network/tokenizer");
const P = require("../../lib/koin-network/job-protocol"), { fundedResultHash } = require("../../lib/koin-network/funded-protocol");
const tokenizer = require("../../lib/koin-network/tokenizers/qwen25-1.5b.json");
const { DAY } = require("../../lib/koin-network/policy"), { pause } = require("./chain");
async function runTestRuntime(chain, check) {
  const desktop = chain.manifest.desktopDir, directory = path.join(chain.directory, "test-runtime");
  fs.mkdirSync(directory, { recursive: true });
  const { TestPayments } = require(path.join(desktop, "electron/koin-test-payments"));
  const { FundingRecovery } = require(path.join(desktop, "electron/koin-funding-recovery"));
  const { FundedSessionClient } = require(path.join(desktop, "electron/koin-session-client"));
  await chain.send("runtime-unpause", [await chain.operation("credits", "set_paused", { paused: false })], chain.actors.admin);
  await chain.block([], (Math.floor(chain.now / DAY) + 1) * DAY + 10000);
  const epoch = String(Math.floor(chain.now / DAY)), owner = chain.address("buyer"), workerAddress = chain.address("alice");
  const walletClient = await chain.walletClient(), client = new KoinChain(walletClient.d, chain.provider);
  const tariff = { version: 1, model: tokenizer.model, modelHash: tokenizer.modelHash, tokenizerHash: tokenizer.tokenizerHash,
    templateHash: tokenizer.templateHash, inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000",
    contextTokens: 8192, maxOutputTokens: 8, maxLatencyMs: 120000 };
  const meter = new Meter([{ tariff, adapter: loadTokenizer(chain.manifest.tokenizerDir, tokenizer) }]);
  let runtime, journal, transportError, lostSettlement = false, restarts = 0, nativeReviews = 0;
  const submissions = [], signatures = new Map(), originals = new Map();
  const baseCall = chain.provider.call.bind(chain.provider);
  const server = http.createServer(async (req, res) => {
    try {
      req.url = req.url.replace(/^\/scheduler(?=\/)/, "");
      if (req.url === "/consume/chat/completions") {
        const parts = []; for await (const p of req) parts.push(p);
        await runtime.scheduler.koinFundedSessions.work.chat(req, res, JSON.parse(Buffer.concat(parts)));
      } else await runtime.scheduler.handle(req, res);
    } catch (e) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const schedulerUrl = `http://127.0.0.1:${server.address().port}/scheduler`;
  const token = "test_" + "a".repeat(43), accountId = "fixture_runtime_account", grantId = "fixture_runtime_grant";
  const accountsFile = path.join(directory, "invitations.json"), qualificationsFile = path.join(directory, "qualifications.json");
  fs.writeFileSync(accountsFile, JSON.stringify([{ accountId, grantId, owner, tokenHash: P.hash(token), enabled: true, expiresAt: chain.now + 7 * DAY }]));
  fs.writeFileSync(qualificationsFile, JSON.stringify([{ address: workerAddress, capacityId: "controlled-native-fixture", model: tokenizer.model,
    modelHash: tokenizer.modelHash, benchmarkHash: P.hash("controlled fixture, not a benchmark"), modelWeight: "6124", coverageBps: 10000, expires: chain.now + DAY }]));
  const roles = { settlement: chain.address("sponsor"), lifecycle: chain.address("lifecycle"), claims: chain.address("manual") };
  const signers = Object.fromEntries(["verifier", "sponsor", "lifecycle", "manual"].map(k => [chain.address(k), chain.actors[k]]));
  for (const [address, signer] of Object.entries(signers)) {
    originals.set(address, signer.signTransaction);
    signer.signTransaction = async tx => {
      const key = address + ":" + tx.id; assert.ok(!signatures.has(key), "A runtime transaction was signed twice");
      signatures.set(key, true); return originals.get(address).call(signer, tx);
    };
  }
  const config = { mode: "isolated-rehearsal", deployment: client.d, schedulerUrl, version: 1, roles, tokenizer, tariff,
    policyHash: meter.policyHash, maxRcPerTransaction: "10000000000", maxRcPerDay: "1000000000000" };
  const create = () => new TestRuntime({ config, stateDir: path.join(directory, "backend"), accountsFile, qualificationsFile,
    signers, tokenizerDir: chain.manifest.tokenizerDir, operatorSecret: "fixture-operator", client, clock: () => chain.now });
  const finalize = async () => chain.finalize((await chain.provider.getHeadInfo()).head_topology.height);
  const progress = async (label, done, limit = 24) => {
    for (let i = 0; i < limit; i++) {
      if (await done()) return;
      await runtime.tick(); if (transportError) throw transportError;
      if (lostSettlement && !restarts) { await runtime.close(); runtime = create(); restarts++; }
      await finalize(); await pause(100);
    }
    throw Error(label + " did not finish: " + JSON.stringify(runtime.status()));
  };
  chain.provider.call = async (method, args) => {
    if (method !== "chain.submit_transaction") return baseCall(method, args);
    try {
      const tx = args.transaction, result = await baseCall(method, args);
      assert.ok(!submissions.includes(tx.id), "An included runtime transaction was submitted twice"); submissions.push(tx.id);
      const receipt = await chain.include("desktop-backend-runtime", tx);
      assert.notEqual(receipt.reverted, true, JSON.stringify(receipt.logs));
      const settlement = tx.operations?.[0]?.call_contract?.entry_point === require("../../lib/koin-network/credits-abi.json").methods.settle.entry_point;
      if (settlement && !lostSettlement) { lostSettlement = true; throw Object.assign(Error("Deliberately lost native settlement acknowledgment"), { deliberate: true }); }
      return result;
    } catch (e) { if (!e.deliberate) transportError = e; throw e; }
  };
  try {
    runtime = create();
    await progress("daily opening", async () => !!(await chain.read("rewards", "get_epoch", { epoch })).epoch?.opened_at);
    const paymentConfig = { schema: 1, mode: config.mode, deployment: client.d, schedulerUrl, owner, policyHash: meter.policyHash,
      version: 1, model: tokenizer.model, maxOutput: 8, maxRcPerTransaction: config.maxRcPerTransaction, maxRcPerDay: config.maxRcPerDay,
      limits: { amount: "10000000", perJob: "1000000", maxJobs: 3, durationMs: 3600000 } };
    journal = new FundingRecovery(path.join(directory, "desktop-journals"), { mode: config.mode, client: walletClient, maxRcPerDay: config.maxRcPerDay, clock: () => chain.now });
    const payments = new TestPayments({ config: paymentConfig, client: walletClient, journal,
      wallet: { address: owner, signer: chain.actors.buyer }, clock: () => chain.now,
      dialog: { showMessageBox: async () => { nativeReviews++; return { response: 1 }; } } });
    const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
    const reserve = await payments.run(window, "reserve"); if (transportError) throw transportError;
    await finalize(); assert.equal((await payments.run(window, "check", reserve.id)).state, "finalized");
    const session = await payments.session(); assert.ok(session);
    const desktopSession = new FundedSessionClient({ config: session, file: path.join(directory, "session.json"), clock: () => chain.now,
      authorize: () => ({ owner, accountId, grantId, sessionToken: token }),
      sign: async hash => Buffer.from(await chain.actors.buyer.signHash(hash)).toString("base64") });
    let review;
    for (let i = 0; !review; i++) {
      if (i >= 12) throw Error("Desktop session did not reach finality");
      try { review = await desktopSession.prepare(); } catch (e) { if (!/awaiting finality/.test(e.message)) throw e; await finalize(); }
    }
    assert.equal((await desktopSession.approve(review)).state, "active");
    const id = P.hash("runtime-paid-request"), worker = { address: workerAddress, proof: "signed", models: [tokenizer.model], capabilities: { koinFundedRehearsalJobs: 1 } };
    runtime.scheduler.workers.set("runtime-worker", worker);
    let chatError;
    const pending = desktopSession.consume({ schedulerUrl, messages: [{ role: "user", content: "What is 2 + 2?" }], model: tokenizer.model, maxOutput: 8, requestId: id,
      signal: AbortSignal.timeout(30000) }).catch(e => { chatError = e; });
    let job;
    for (let i = 0; !job; i++) {
      if (chatError) throw chatError; if (i >= 300) throw Error("No native runtime job dispatched");
      job = await runtime.scheduler.koinFundedSessions.work.next(worker); if (!job) await pause(10);
    }
    const signedResult = { jobId: id, output: "4", signature: Buffer.from(await chain.actors.alice.signHash(fundedResultHash(runtime.target, job, "4"))).toString("base64") };
    const response = await fetch(schedulerUrl + "/koin/funded/rehearsal/result?token=runtime-worker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signedResult) });
    assert.equal(response.status, 200, await response.text());
    const answer = await pending; if (chatError) throw chatError;
    assert.equal(answer.choices[0].message.content, "4");
    await progress("automatic paid settlement", async () => runtime.ledger.job(id).state === "settled");
    const hold = runtime.ledger.job(id); assert.equal(hold.receipt.usage.amount, "38"); assert.equal(restarts, 1);
    const recoveredRequest = await desktopSession.requestStatus(id);
    assert.equal(recoveredRequest.state, "settled"); assert.equal(recoveredRequest.amount, "38");
    check("desktop native review and pinned tokenizer produce a real irreversible 38-atom settlement");
    check("backend restart after lost settlement acknowledgment reuses the original signed envelope");
    const before = BigInt(await chain.balance(workerAddress));
    await chain.block([], (Number(epoch) + 1) * DAY + 10000);
    await progress("automatic reward proposal", async () => BigInt((await chain.read("rewards", "get_epoch", { epoch })).epoch?.review_until || "0") > 0n);
    await progress("review-day opening", async () => !!(await chain.read("rewards", "get_epoch", { epoch: String(Number(epoch) + 1) })).epoch?.opened_at);
    const rewardEpoch = (await chain.read("rewards", "get_epoch", { epoch })).epoch;
    assert.equal(BigInt(await chain.balance(workerAddress)), before, "Full root review must precede payout");
    await chain.block([], Number(rewardEpoch.review_until) + 1);
    await progress("automatic provider payout", async () => runtime.claims.accountStatus(workerAddress).some(r => r.state === "paid"), 36);
    const paid = BigInt(await chain.balance(workerAddress)) - before; assert.ok(paid > 0n);
    check("runtime derives rewards from settled native usage and pays automatically after the full review window");
    const emptyEpoch = String(Number(epoch) + 1);
    await progress("empty-day proposal", async () => BigInt((await chain.read("rewards", "get_epoch", { epoch: emptyEpoch })).epoch?.review_until || "0") > 0n);
    const empty = (await chain.read("rewards", "get_epoch", { epoch: emptyEpoch })).epoch;
    assert.equal(BigInt(empty.root.work || "0") + BigInt(empty.root.availability || "0"), 0n);
    await chain.block([], Number(empty.review_until) + 1);
    await progress("empty-day finalization", async () => !runtime.cycle.days().includes(emptyEpoch));
    assert.equal(BigInt(await chain.balance(workerAddress)) - before, paid);
    assert.ok(runtime.signing.resourceUsage().every(r => BigInt(r.used) <= BigInt(r.limits)));
    assert.ok(runtime.signing.resourceUsage().some(r => BigInt(r.used) > 0n));
    check("empty reward days finalize with zero payouts and native resource usage is measured from receipts");
    const released = await payments.run(window, "release", session.session); if (transportError) throw transportError;
    await finalize(); assert.equal((await payments.run(window, "check", released.id)).state, "finalized");
    const refund = await payments.run(window, "refund", "0.01"); if (transportError) throw transportError;
    await finalize(); assert.equal((await payments.run(window, "check", refund.id)).state, "finalized");
    check("desktop releases expired reservation remainder and refunds native Test funds");
    return { epoch, model: tokenizer.model, inputTokens: 37, outputTokens: 1, chargedAtoms: "38", payoutAtoms: String(paid),
      restarts, nativeReviews, transactionSignatures: signatures.size, submissions: submissions.length, providerPayoutSignatures: 0,
      controlledWorkerFixture: true, realModelBenchmark: false, productionManaCalibration: false };
  } finally {
    chain.provider.call = baseCall;
    for (const [address, original] of originals) signers[address].signTransaction = original;
    journal?.close(); await runtime?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { runTestRuntime };
