"use strict";
const fs = require("fs"), path = require("path"), assert = require("node:assert/strict");
const { utils } = require("koilib"), { IsolatedChain, bytes, pause } = require("./chain");
const { DAY } = require("../../lib/koin-network/policy"), P = require("../../lib/koin-network/job-protocol");
const Tree = require("../../lib/koin-network/merkle"), Manifest = require("../../lib/koin-network/reward-manifest");
const { RewardObserver } = require("../../lib/koin-network/reward-observer"), { RewardClaims } = require("../../lib/koin-network/reward-claims");
const { RehearsalSubmitter } = require("../../lib/koin-network/rehearsal-submitter");
const { RewardCycle } = require("../../lib/koin-network/reward-cycle"), { RewardCycleRunner } = require("../../lib/koin-network/reward-cycle-runner");
const ABI = require("../../lib/koin-network/rewards-abi.json");
const enc = utils.encodeBase64url, digest = text => enc(Buffer.from(P.hash(text), "hex"));
async function run(directory) {
  const chain = new IsolatedChain(directory), report = { schema: 1, mode: "isolated-chain", paymentsEnabled: false,
    productionManaCalibration: false, passed: false, checks: [], measurements: [] };
  let ledger, cycle, fundingRollback;
  const check = name => { report.checks.push(name); console.log("PASS " + name); };
  const call = async (kind, method, args, actor, options) => chain.send(method, [await chain.operation(kind, method, args)], actor, options);
  try {
    await chain.connect(); report.chainId = chain.chainId;
    await chain.bootstrap(); check("fresh peerless chain bootstrapped with native token and enabled resource accounting");
    assert.equal(await chain.balance(chain.address("credits")), "0"); assert.equal(await chain.balance(chain.address("rewards")), "0");
    await call("rewards", "fund", { account: bytes(chain.address("admin")), amount: "100000000000" }, chain.actors.admin, { reverted: true });
    assert.equal(await chain.balance(chain.address("rewards")), "0");
    // Customer balances belong to credits; rewards expose aggregate custody.
    for (const kind of ["credits", "rewards"]) {
      const empty = await chain.read(kind, "balances", kind === "credits" ? { account: bytes(chain.address("buyer")) } : {});
      assert.equal(empty.liquid ?? "0", "0"); assert.equal(empty.liabilities ?? "0", "0");
    }
    await chain.deposit("rewards", "fund", chain.actors.admin, "100000000000");
    await chain.deposit("credits", "purchase", chain.actors.buyer, "10000000000");
    check("deposits require an exact native allowance and consume it atomically with no residual approval");
    check("the pinned desktop wallet prepares, validates and submits both exact funding bundles");
    check("native funding approval binds the exact transaction and Stop saves late signatures without broadcasting");
    check("stopped deposits survive restart and require a new review to resume the same signed envelope");
    check("desktop deposit journals recover lost inclusion responses without signing or depositing twice");
    check("credit and reward deposits require exact native receipts and irreversible backed custody before confirmation");
    report.fundingRecovery = chain.fundingStats;
    assert.equal(await chain.balance(chain.address("credits")), "10000000000");
    assert.equal((await chain.read("credits", "balances", { account: bytes(chain.address("buyer")) })).liabilities, "10000000000");
    check("native deposit funds customer custody independently of the seeded rewards pool");
    const target = { chainId: chain.chainId, rewards: chain.address("rewards"), rewardsHash: "0x1220" + chain.manifest.artifacts.rewards.sha256,
      credits: chain.address("credits"), creditsHash: "0x1220" + chain.manifest.artifacts.credits.sha256,
      token: chain.keys.Koin.getAddress(), tokenHash: (await chain.provider.invokeGetContractMetadata(chain.keys.Koin.getAddress())).value.hash,
      verifier: chain.address("verifier"), version: "1", workCapBps: 8000 };
    const sponsor = chain.address("sponsor"), policy = { verifier: sponsor, payer: sponsor, maxRcPerTransaction: "10000000000", maxRcPerDay: "20000000000", maxAttempts: 3, minRetryMs: 1000 };
    const open = () => { ledger = new RewardClaims(path.join(directory, "claims"), { target, policy,
      observer: new RewardObserver(chain.provider, { target, clock: () => chain.now }), clock: () => chain.now }); };
    open();
    const epoch = String(Math.floor(chain.now / DAY)), lifecyclePayer = chain.address("lifecycle");
    const openCycle = () => { cycle = new RewardCycle(path.join(directory, "cycle"), { mode: "isolated-rehearsal", target,
      policy: { ...policy, verifier: target.verifier, payer: lifecyclePayer, maxRcPerDay: "30000000000" },
      budgetPolicy: { dailyBps: 500, availabilityBps: 7000 }, observer: new RewardObserver(chain.provider, { target, clock: () => chain.now }), clock: () => chain.now }); };
    openCycle(); cycle.queueDay(epoch);
    let cycleSignatures = 0, cycleSubmissions = 0, cycleLost = false, cycleRestarted = false, cycleError;
    const cycleRunner = () => new RewardCycleRunner({ mode: "isolated-rehearsal", cycle, claims: ledger,
      prepare: async d => {
        assert.equal(d.payer, lifecyclePayer); const tx = await chain.signed([{ call_contract: d.operation }], chain.actors.lifecycle, { rcLimit: d.maxRc });
        cycleSignatures++;
        if (d.method === "propose_root") { await chain.actors.verifier.signTransaction(tx); cycleSignatures++; }
        assert.equal(tx.header.payee, undefined); return tx;
      }, submit: async tx => {
        const method = ["open_epoch", "propose_root", "finalize_root"].find(k => ABI.methods[k].entry_point === tx.operations[0].call_contract.entry_point);
        try {
          cycleSubmissions++; await chain.provider.call("chain.submit_transaction", { transaction: tx, broadcast: true });
          const receipt = await chain.include("cycle-" + method, tx);
          assert.notEqual(receipt.reverted, true, JSON.stringify(receipt.logs));
        } catch (e) { cycleError = e; throw e; }
        if (method === "propose_root" && !cycleLost) { cycleLost = true; throw Error("Lost lifecycle acknowledgment after inclusion"); }
        return { txId: tx.id };
      } });
    const cycleUntil = async method => {
      for (let i = 0; i < 24; i++) {
        const result = await cycleRunner().tick({ openCurrentDay: false });
        if (cycleError) throw cycleError;
        console.log(JSON.stringify({ cycle: result.results[0] }));
        if (cycleLost && !cycleRestarted) { cycle.close(); openCycle(); cycleRestarted = true; }
        if (cycle.status(epoch).steps.find(s => s.method === method).state === "complete") return;
        await chain.finalize((await chain.provider.getHeadInfo()).head_topology.height);
      }
      throw Error("Daily cycle did not resolve " + method);
    };
    await cycleUntil("open_epoch");
    const opened = (await chain.read("rewards", "get_epoch", { epoch })).epoch;
    assert.ok(BigInt(opened.budget) <= 5000000000n && BigInt(opened.budget) > 4900000000n);
    const sessionId = digest("isolated-paid-session"), policyHash = digest("isolated-tariff");
    await call("credits", "reserve", { session: { id: sessionId, owner: bytes(chain.address("buyer")), verifier: bytes(chain.address("verifier")),
      policy_hash: policyHash, remaining: "2000000000", per_job: "1000000000", max_jobs: "3", expires: String(chain.now + 3600000) } }, chain.actors.buyer);
    const session = (await chain.read("credits", "get_session", { id: sessionId })).session;
    const charge = { id: digest("isolated-job"), session_id: sessionId, provider: bytes(chain.address("alice")), policy_hash: policyHash,
      receipt_hash: digest("isolated-accepted-work"), amount: "500000000", dispatched_at: session.opened_at, nonce: "1" };
    await call("credits", "settle", { charge }, chain.actors.manual, { reverted: true });
    assert.equal((await chain.read("credits", "get_session", { id: sessionId })).session.remaining, "2000000000");
    await call("credits", "settle", { charge }, chain.actors.verifier);
    assert.equal(await chain.balance(chain.address("credits")), "9500000000");
    assert.equal(await chain.balance(chain.address("rewards")), "100300000000");
    assert.equal(await chain.balance(chain.address("mining")), "125000000");
    assert.equal(await chain.balance(chain.address("operations")), "75000000");
    assert.equal((await chain.read("credits", "get_spend", { epoch, account: bytes(chain.address("alice")) })).amount, charge.amount);
    check("authorized usage moves the exact 60/25/15 native-token split and records provider paid work");
    const tree = Tree.build({ chainId: target.chainId, contract: target.rewards, epoch, version: "1" }, [
      { address: chain.address("alice"), availability: "100000000", work: "400000000" },
      { address: chain.address("bob"), availability: "50000000", work: "0" },
    ]);
    const node = n => ({ ...n, hash: enc(Buffer.from(n.hash, "hex")) });
    const envelope = { manifest: { schema: 1, mode: "reward-rehearsal", target, epoch, evidenceHash: P.hash(JSON.stringify(chain.records.map(r => r.transaction.id))),
      root: tree.root, allocations: tree.claims.map(({ address, availability, work }) => ({ address, availability, work })) } };
    envelope.signature = Buffer.from(await chain.actors.verifier.signHash(Manifest.signingHash(envelope.manifest))).toString("base64");
    cycle.importManifest(envelope);
    const delayedOpen = await chain.signed([await chain.operation("rewards", "open_epoch", { epoch })], chain.actors.manual);
    await chain.block([], (Number(epoch) + 1) * DAY + 1);
    assert.equal((await chain.include("delayed-cycle-open", delayedOpen)).reverted, true);
    assert.equal((await chain.read("rewards", "get_epoch", { epoch: String(BigInt(epoch) + 1n) })).epoch ?? null, null);
    check("a delayed budget-opening transaction cannot open a different reward day");
    await cycleUntil("propose_root");
    const review = (await chain.read("rewards", "get_epoch", { epoch })).epoch;
    await call("rewards", "finalize_root", { epoch, root: node(tree.root) }, chain.actors.admin, { reverted: true });
    assert.notEqual((await chain.read("rewards", "get_epoch", { epoch })).epoch.finalized, true);
    const held = await cycleRunner().tick({ openCurrentDay: false });
    assert.equal(held.results[0].reason, "root_under_review"); assert.equal(cycleSignatures, 3);
    await chain.block([], Number(review.review_until) + 1);
    await call("rewards", "finalize_root", { epoch, root: { ...node(tree.root), availability: String(BigInt(tree.root.availability) + 1n) } }, chain.actors.admin, { reverted: true });
    check("finalization is bound to the exact reviewed root and category totals");
    await cycleUntil("finalize_root");
    check("real contract enforces the full 24-hour review before finalization");
    assert.equal(cycleSubmissions, 3); assert.equal(cycleSignatures, 4); assert.equal(cycleRestarted, true);
    assert.deepEqual(cycle.readyDays(), []); assert.ok(ledger.next());
    check("the daily runner opens, proposes, finalizes and durably hands rewards to automatic claims");
    check("lifecycle restart after a lost root acknowledgment does not sign or submit twice");
    report.lifecycle = { signatures: cycleSignatures, submissions: cycleSubmissions, restarted: cycleRestarted, status: cycle.status(epoch) };
    const ids = tree.claims.map(c => P.hash(Manifest.signingHash(envelope.manifest).toString("hex") + ":" + c.address)), before = {};
    for (const row of tree.claims) { before[row.address] = await chain.balance(row.address); assert.equal(before[row.address], "0"); }
    const unpaidOp = await ledger.operation(ids[0]);
    const empty = await chain.signed([{ call_contract: unpaidOp }], chain.actors.empty);
    await assert.rejects(chain.provider.call("chain.submit_transaction", { transaction: empty, broadcast: false }), /mana|resource|rc|payer/i);
    assert.notEqual((await chain.read("rewards", "claimed", { epoch, account: bytes(ledger.status(ids[0]).account) })).claimed, true);
    check("a sponsor with no Mana cannot consume a valid unpaid entitlement");
    let signatures = 0, submissions = 0, lostResponse = false, submissionError;
    const runner = () => new RehearsalSubmitter({ mode: "isolated-rehearsal", claims: ledger,
      prepareClaim: async decision => {
        assert.equal(decision.chainId, chain.chainId); assert.equal(decision.payer, sponsor); signatures++;
        return chain.signed([{ call_contract: decision.operation }], chain.actors.sponsor, { rcLimit: decision.maxRc });
      }, submit: async transaction => {
        try {
          submissions++; const rcBefore = await chain.provider.getAccountRc(sponsor), balanceBefore = await chain.balance(sponsor);
          // Exercise the real RPC admission path, then produce exactly this tx.
          await chain.provider.call("chain.submit_transaction", { transaction, broadcast: true });
          const receipt = await chain.include("automatic-claim", transaction);
          assert.notEqual(receipt.reverted, true, JSON.stringify(receipt.logs));
          const rcAfter = await chain.provider.getAccountRc(sponsor);
          assert.equal(receipt.payer, sponsor); assert.ok(BigInt(receipt.rc_used) > 0n && BigInt(receipt.rc_used) <= BigInt(transaction.header.rc_limit));
          assert.ok(BigInt(rcAfter) < BigInt(rcBefore)); assert.equal(await chain.balance(sponsor), balanceBefore);
          report.measurements.push({ txId: transaction.id, rcBefore, rcAfter, rcLimit: transaction.header.rc_limit, rcUsed: receipt.rc_used,
            disk: receipt.disk_storage_used ?? "0", network: receipt.network_bandwidth_used ?? "0", compute: receipt.compute_bandwidth_used ?? "0" });
        } catch (e) { submissionError = e; throw e; }
        if (!lostResponse) { lostResponse = true; throw Error("Deliberately lost acknowledgment after real block inclusion"); }
        return { txId: transaction.id };
      } });
    let restarted = false;
    for (let attempts = 0; ledger.next(); attempts++) {
      if (attempts >= 24) throw Error("Automatic claim queue did not resolve");
      const result = await runner().tick(); console.log(JSON.stringify({ claim: result.results[0]?.id, action: result.results[0]?.action, reason: result.results[0]?.reason }));
      if (submissionError) throw submissionError;
      if (lostResponse && !restarted) {
        assert.equal(ledger.status(ids[0]).state, "unknown"); ledger.close(); open(); restarted = true;
      }
      await chain.finalize((await chain.provider.getHeadInfo()).head_topology.height); await pause(100);
    }
    assert.equal(signatures, 2); assert.equal(submissions, 2); assert.equal(restarted, true);
    assert.equal(report.measurements.length, 2, "Every claim must pass the actual Mana assertions");
    for (const row of tree.claims) assert.equal(BigInt(await chain.balance(row.address)) - BigInt(before[row.address]), BigInt(row.availability) + BigInt(row.work));
    for (const id of ids) assert.equal(ledger.status(id).state, "paid");
    assert.equal((await chain.read("rewards", "get_epoch", { epoch })).epoch.paid, "550000000");
    assert.equal((await chain.read("rewards", "balances")).liabilities ?? "0", "0");
    check("automatic claims pay exact native amounts to providers with no provider signatures");
    check("restart after a lost inclusion response recovers finality without signing or paying twice");
    check("both claim receipts charge real sponsor Mana within their signed limits");
    const priorBalance = await chain.balance(ledger.status(ids[0]).account), priorPool = await chain.balance(target.rewards);
    await chain.send("duplicate-claim", [{ call_contract: await ledger.operation(ids[0]) }], chain.actors.manual, { reverted: true });
    assert.equal(await chain.balance(ledger.status(ids[0]).account), priorBalance); assert.equal(await chain.balance(target.rewards), priorPool);
    check("duplicate native payout reverts without changing provider or treasury balances");
    const low = await chain.signed([await chain.operation("credits", "purchase", { account: bytes(chain.address("buyer")), amount: "1" })], chain.actors.buyer, { rcLimit: "1" });
    const creditBalance = await chain.balance(target.credits);
    await assert.rejects(chain.provider.call("chain.submit_transaction", { transaction: low, broadcast: false }), /bandwidth|resource|rc|limit/i);
    assert.equal(await chain.balance(target.credits), creditBalance);
    check("an insufficient transaction RC limit cannot move customer funds");
    // A pause between review and inclusion must roll back the preceding approval.
    const wallet = await chain.walletClient(), fundingArgs = { account: bytes(chain.address("buyer")), amount: "100000000" };
    const fundingIntent = { kind: "credits", method: "purchase", args: fundingArgs, actor: chain.address("buyer"), maxRc: "10000000000" };
    fundingRollback = chain.fundingJournal(wallet);
    const rollbackId = P.hash("isolated-paused-funding");
    const pausedFunding = (await fundingRollback.begin(rollbackId, fundingIntent)).transaction;
    await chain.actors.buyer.signTransaction(pausedFunding);
    await fundingRollback.stage(rollbackId, pausedFunding);
    const buyerBefore = await chain.balance(fundingIntent.actor), custodyBefore = await chain.balance(target.credits);
    await call("credits", "set_paused", { paused: true }, chain.actors.admin);
    await assert.rejects(wallet.submit(pausedFunding, fundingIntent), /paused/i);
    assert.equal((await chain.include("paused-funding-rollback", pausedFunding)).reverted, true);
    assert.equal(await chain.allowance("credits", chain.actors.buyer), "0");
    assert.equal(await chain.balance(fundingIntent.actor), buyerBefore);
    assert.equal(await chain.balance(target.credits), custodyBefore);
    assert.equal((await chain.read("credits", "balances", { account: fundingArgs.account })).liabilities, custodyBefore);
    check("a paused deposit rolls back its native approval and moves no customer funds");
    fundingRollback.close(); fundingRollback = chain.fundingJournal(wallet);
    for (let attempts = 0; fundingRollback.status(rollbackId).state !== "reverted"; attempts++) {
      if (attempts >= 12) throw Error("Paused funding recovery did not resolve");
      await chain.finalize((await chain.provider.getHeadInfo()).head_topology.height);
      await fundingRollback.advance(rollbackId);
    }
    report.fundingRevert = fundingRollback.status(rollbackId);
    check("a saved externally included deposit is recovered as reverted after irreversible approval rollback");
    // Finalized claims have consumed only reward liabilities; customer principal remains refundable.
    await call("credits", "refund", { account: bytes(chain.address("buyer")), amount: "1000000000" }, chain.actors.buyer);
    assert.equal(await chain.balance(target.credits), "8500000000");
    check("customer refund transfers native tokens while new spending is paused");
    report.passed = true; report.signatures = signatures; report.submissions = submissions; report.target = target;
    report.maxObservedClaimRc = String(report.measurements.reduce((max, m) => BigInt(m.rcUsed) > max ? BigInt(m.rcUsed) : max, 0n));
    return report;
  } catch (e) { report.error = e.message; throw e; }
  finally {
    ledger?.close(); cycle?.close(); fundingRollback?.close(); report.records = chain.records; report.manifest = chain.manifest;
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, maxObservedClaimRc: report.maxObservedClaimRc, productionManaCalibration: false }));
  }
}
if (require.main === module) {
  if (process.argv.length !== 3) throw Error("Usage: run.js DISPOSABLE_DIRECTORY");
  run(path.resolve(process.argv[2])).catch(e => { console.error(e.stack); process.exitCode = 1; });
}
module.exports = { run };
