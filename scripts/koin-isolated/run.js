"use strict";
const fs = require("fs"), path = require("path"), assert = require("node:assert/strict");
const { utils } = require("koilib"), { IsolatedChain, bytes, pause } = require("./chain");
const { DAY } = require("../../lib/koin-network/policy"), P = require("../../lib/koin-network/job-protocol");
const Tree = require("../../lib/koin-network/merkle"), Manifest = require("../../lib/koin-network/reward-manifest");
const { RewardObserver } = require("../../lib/koin-network/reward-observer"), { RewardClaims } = require("../../lib/koin-network/reward-claims");
const { RehearsalSubmitter } = require("../../lib/koin-network/rehearsal-submitter");
const enc = utils.encodeBase64url, digest = text => enc(Buffer.from(P.hash(text), "hex"));
async function run(directory) {
  const chain = new IsolatedChain(directory), report = { schema: 1, mode: "isolated-chain", paymentsEnabled: false,
    productionManaCalibration: false, passed: false, checks: [], measurements: [] };
  let ledger;
  const check = name => { report.checks.push(name); console.log("PASS " + name); };
  const call = async (kind, method, args, actor, options) => chain.send(method, [await chain.operation(kind, method, args)], actor, options);
  try {
    await chain.connect(); report.chainId = chain.chainId;
    await chain.bootstrap(); check("fresh peerless chain bootstrapped with native token and enabled resource accounting");
    assert.equal(await chain.balance(chain.address("credits")), "0"); assert.equal(await chain.balance(chain.address("rewards")), "0");
    await call("rewards", "fund", { account: bytes(chain.address("admin")), amount: "100000000000" }, chain.actors.admin, { reverted: true });
    assert.equal(await chain.balance(chain.address("rewards")), "0");
    await chain.deposit("rewards", "fund", chain.actors.admin, "100000000000");
    await chain.deposit("credits", "purchase", chain.actors.buyer, "10000000000");
    check("deposits require an exact native allowance and consume it atomically with no residual approval");
    assert.equal(await chain.balance(chain.address("credits")), "10000000000");
    assert.equal((await chain.read("credits", "balances", { account: bytes(chain.address("buyer")) })).liabilities, "10000000000");
    check("native deposit funds customer custody independently of the seeded rewards pool");
    const epoch = String(Math.floor(chain.now / DAY)); await call("rewards", "open_epoch", {}, chain.actors.admin);
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
    const target = { chainId: chain.chainId, rewards: chain.address("rewards"), rewardsHash: "0x1220" + chain.manifest.artifacts.rewards.sha256,
      credits: chain.address("credits"), creditsHash: "0x1220" + chain.manifest.artifacts.credits.sha256,
      token: chain.keys.Koin.getAddress(), tokenHash: (await chain.provider.invokeGetContractMetadata(chain.keys.Koin.getAddress())).value.hash,
      verifier: chain.address("verifier"), version: "1", workCapBps: 8000 };
    const tree = Tree.build({ chainId: target.chainId, contract: target.rewards, epoch, version: "1" }, [
      { address: chain.address("alice"), availability: "100000000", work: "400000000" },
      { address: chain.address("bob"), availability: "50000000", work: "0" },
    ]);
    const node = n => ({ ...n, hash: enc(Buffer.from(n.hash, "hex")) });
    await chain.block([], (Number(epoch) + 1) * DAY + 1);
    await call("rewards", "propose_root", { epoch, root: node(tree.root) }, chain.actors.verifier);
    const review = (await chain.read("rewards", "get_epoch", { epoch })).epoch;
    await call("rewards", "finalize_root", { epoch }, chain.actors.admin, { reverted: true });
    assert.notEqual((await chain.read("rewards", "get_epoch", { epoch })).epoch.finalized, true);
    await chain.block([], Number(review.review_until) + 1);
    await call("rewards", "finalize_root", { epoch }, chain.actors.admin);
    await chain.finalize((await chain.provider.getHeadInfo()).head_topology.height);
    check("real contract enforces the full 24-hour review before finalization");
    const sponsor = chain.address("sponsor"), policy = { verifier: sponsor, payer: sponsor, maxRcPerTransaction: "10000000000", maxRcPerDay: "20000000000", maxAttempts: 3, minRetryMs: 1000 };
    const envelope = { manifest: { schema: 1, mode: "reward-rehearsal", target, epoch, evidenceHash: P.hash(JSON.stringify(chain.records.map(r => r.transaction.id))),
      root: tree.root, allocations: tree.claims.map(({ address, availability, work }) => ({ address, availability, work })) } };
    envelope.signature = Buffer.from(await chain.actors.verifier.signHash(Manifest.signingHash(envelope.manifest))).toString("base64");
    const open = () => { ledger = new RewardClaims(path.join(directory, "claims"), { target, policy,
      observer: new RewardObserver(chain.provider, { target, clock: () => chain.now }), clock: () => chain.now }); };
    open(); const ids = ledger.importManifest(envelope), before = {};
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
    // Finalized claims have consumed only reward liabilities; customer principal remains refundable.
    await call("credits", "set_paused", { paused: true }, chain.actors.admin);
    await call("credits", "refund", { account: bytes(chain.address("buyer")), amount: "1000000000" }, chain.actors.buyer);
    assert.equal(await chain.balance(target.credits), "8500000000");
    check("customer refund transfers native tokens while new spending is paused");
    report.passed = true; report.signatures = signatures; report.submissions = submissions; report.target = target;
    report.maxObservedClaimRc = String(report.measurements.reduce((max, m) => BigInt(m.rcUsed) > max ? BigInt(m.rcUsed) : max, 0n));
    return report;
  } catch (e) { report.error = e.message; throw e; }
  finally {
    ledger?.close(); report.records = chain.records; report.manifest = chain.manifest;
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, maxObservedClaimRc: report.maxObservedClaimRc, productionManaCalibration: false }));
  }
}
if (require.main === module) {
  if (process.argv.length !== 3) throw Error("Usage: run.js DISPOSABLE_DIRECTORY");
  run(path.resolve(process.argv[2])).catch(e => { console.error(e.stack); process.exitCode = 1; });
}
module.exports = { run };
