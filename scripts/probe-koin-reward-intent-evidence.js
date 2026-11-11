"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Serializer, utils } = require("koilib");
const { fixture: cycleFixture } = require("./helpers/koin-cycle-fixture");
const { fixture: claimFixture } = require("./helpers/koin-claims-fixture");
const { RewardObserver, assertRewardIntentEvidence, assertClosedEpochWorkEvidence } = require("../lib/koin-network/reward-observer");
const { DAY } = require("../lib/koin-network/policy");
const P = require("../lib/koin-network/job-protocol"), CABI = require("../lib/koin-network/credits-abi.json");
const hash = operation => P.hash(JSON.stringify(operation));
const observer = f => new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
async function opened(t, { closed = true } = {}) {
  const f = await cycleFixture(t);
  await f.runner().tick({ openCurrentDay: false }); await f.include(f.sent[0]);
  for (let i = 0; i < 3; i++) if ((await f.cycle.advance("1")).action === "step_complete") break;
  assert.equal(f.cycle.status("1").steps[0].state, "complete");
  f.cycle.importManifest(f.envelope); if (closed) f.advance(DAY);
  return f;
}
async function cycleArgs(f, method = "propose_root") {
  return { epoch: "1", method, operationHash: hash(await f.cycle.operation("1", method)) };
}
async function claimArgs(f, id = f.ids[0]) {
  return { epoch: "1", account: f.ledger.status(id).account, operationHash: hash(await f.ledger.operation(id)) };
}
function depositOnVerification(f, change = () => {}) {
  const get = f.rpc.getBlocks;
  f.rpc.getBlocks = async (...args) => {
    const result = await get(...args); f.balances.liquid = String(BigInt(f.balances.liquid) + 100n);
    change(); f.advance(1); return result;
  };
}
function changeSpend(f, amount, ownOnly = false) {
  const read = f.rpc.readContract, serializer = new Serializer(CABI.types);
  f.rpc.readContract = async op => {
    if (op.contract_id === f.target.credits && op.entry_point === CABI.methods.get_spend.entry_point) {
      const args = await serializer.deserialize(op.args, "koin.Request");
      if (!ownOnly || args.account) return { result: utils.encodeBase64url(await serializer.serialize({ amount }, "koin.Result")) };
    }
    return read(op);
  };
}

test("funded proposals progress through continuous deposits and other-day payments without relaxing new-open admission", async t => {
  const f = await opened(t), o = observer(f), args = await cycleArgs(f);
  // Model another funded day's remaining liability, which its claims release.
  f.balances.liabilities = "80";
  depositOnVerification(f, () => { if (BigInt(f.balances.liabilities) > 50n) f.balances.liabilities = String(BigInt(f.balances.liabilities) - 1n); });
  for (let i = 0; i < 3; i++) {
    const proof = await o.inspectFundedCycle(args);
    assert.equal(proof.state, "verified");
    assertRewardIntentEvidence(proof, { target: f.target, now: f.clock(), scope: "funded_cycle", ...args });
    assert.equal(proof.liveCustody.liquid, f.balances.liquid);
    assert.ok(!Object.hasOwn(proof, "balances")); assert.ok(!Object.hasOwn(proof.epoch, "paid"));
  }
  assert.equal((await o.inspectCycle({ epoch: "1" })).state, "changed", "full new-open scope still observes pool changes");
  const result = await f.runner().tick({ openCurrentDay: false });
  assert.equal(result.results[0].method, "propose_root"); assert.equal(f.sent.length, 2); assert.equal(f.signed.length, 2);
  await f.include(f.sent[1]);
  for (let i = 0; i < 3; i++) if ((await f.cycle.advance("1")).action === "step_complete") break;
  assert.equal(f.cycle.status("1").steps[1].state, "complete");
  assert.equal(f.sent.length, 2, "confirmation never broadcasts a replacement");
});

test("claim evidence ignores another wallet's payment but returns only current custody alongside own irreversible claim state", async t => {
  const f = await claimFixture(t), args = await claimArgs(f); let paid = false;
  depositOnVerification(f, () => { if (!paid) { f.pay(f.ledger.status(f.ids[1]).account); paid = true; } });
  const proof = await f.observer.inspectClaim(args);
  assert.equal(proof.state, "verified"); assert.equal(proof.claimed, false);
  assert.equal(proof.liveCustody.epochPaid, "18"); assert.equal(proof.liveCustody.liabilities, "18");
  assertRewardIntentEvidence(proof, { target: f.target, now: f.clock(), scope: "reward_claim", method: "claim", ...args, claimAmount: "18" });
  await f.runner().tick(); assert.equal(f.sent.length, 1); assert.equal(f.signed.length, 1);
  f.finalized(f.sent[0]);
  for (let i = 0; i < 3; i++) if ((await f.ledger.advance(f.ids[0])).action === "done") break;
  assert.equal(f.ledger.status(f.ids[0]).state, "paid");
  assert.equal(f.sent.length, 1); assert.equal(f.signed.length, 1);
});

test("our claim, own spend, total spend, root and configuration changes reset scoped irreversible evidence", async t => {
  for (const change of ["claimed", "own_spend", "total_spend", "root", "config"]) {
    const f = await claimFixture(t), args = await claimArgs(f);
    assert.equal((await f.observer.inspectClaim(args)).state, "verified");
    if (change === "claimed") f.pay(args.account);
    if (change === "own_spend") changeSpend(f, "9", true);
    if (change === "total_spend") changeSpend(f, "21");
    if (change === "root") f.epoch.root.hash = utils.encodeBase64url(Buffer.from(P.hash("changed-root"), "hex"));
    if (change === "config") f.config.config.daily_bps = 501;
    f.advance(1);
    assert.equal((await f.observer.inspectClaim(args)).state, "changed", change);
    assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0);
  }
});

test("closed work stays available during deposits and other-day claims but binds the exact irreversible day boundary", async t => {
  const f = await opened(t, { closed: false }), o = observer(f), args = { epoch: "1", minimumTime: String(2 * DAY) };
  await assert.rejects(o.inspectClosedEpochWork({ ...args, minimumTime: String(2 * DAY - 1) }), /Exact closed/);
  assert.equal((await o.inspectClosedEpochWork(args)).state, "before_boundary");
  f.advance(DAY); const oldLib = String(BigInt(f.head.head_topology.height) - 1n); f.head.last_irreversible_block = oldLib;
  assert.equal((await o.inspectClosedEpochWork(args)).state, "reversible");
  f.head.last_irreversible_block = f.head.head_topology.height; f.balances.liabilities = "70";
  depositOnVerification(f, () => { if (BigInt(f.balances.liabilities) > 50n) f.balances.liabilities = String(BigInt(f.balances.liabilities) - 1n); });
  const proof = await o.inspectClosedEpochWork(args);
  assert.equal(proof.state, "verified"); assert.equal(proof.totalSpent, "20");
  assertClosedEpochWorkEvidence(proof, { target: f.target, now: f.clock(), ...args });
  assert.throws(() => assertClosedEpochWorkEvidence(proof, { target: f.target, now: f.clock(), ...args, epoch: "2" }));
  assert.ok(!Object.hasOwn(proof, "spent")); assert.ok(!Object.hasOwn(proof, "balances"));
});

test("closed work and funded intents keep root, cancellation, expiry, and total-spend changes in their projections", async t => {
  for (const scope of ["funded_cycle", "closed_epoch_work"]) for (const change of ["root", "cancel", "expire", "spend"]) {
    const f = await opened(t), o = observer(f), e = f.epochs.get("1");
    e.root = { ...f.envelope.manifest.root, hash: utils.encodeBase64url(Buffer.from(f.envelope.manifest.root.hash, "hex")) };
    e.review_until = String(3 * DAY + 1000);
    const args = scope === "funded_cycle" ? await cycleArgs(f) : { epoch: "1", minimumTime: String(2 * DAY) };
    const inspect = () => scope === "funded_cycle" ? o.inspectFundedCycle(args) : o.inspectClosedEpochWork(args);
    assert.equal((await inspect()).state, "verified");
    if (change === "root") e.root.hash = utils.encodeBase64url(Buffer.from(P.hash("replacement"), "hex"));
    if (change === "cancel" || change === "expire") { delete e.root; delete e.review_until; }
    if (change === "expire") { e.expired = true; f.balances.liabilities = "0"; }
    if (change === "spend") changeSpend(f, "21");
    f.advance(1); assert.equal((await inspect()).state, "changed", scope + ":" + change);
    if (change === "expire" && scope === "closed_epoch_work") {
      const expired = await inspect();
      assert.throws(() => assertClosedEpochWorkEvidence(expired, { target: f.target, now: f.clock(), ...args }), /Funded irreversible/);
    }
  }
});

test("scoped proofs reject underfunding and an unpaid claim larger than its remaining root", async t => {
  const f = await opened(t), args = await cycleArgs(f); f.balances.liabilities = "49";
  await assert.rejects(observer(f).inspectFundedCycle(args), /custody/);
  for (const change of ["liquid", "liability", "root_remaining"]) {
    const g = await claimFixture(t), claim = await claimArgs(g);
    if (change === "liquid") g.balances.liquid = "1";
    if (change === "liability") g.balances.liabilities = "1";
    if (change === "root_remaining") { g.epoch.paid = "35"; g.balances.liabilities = "1"; }
    if (change === "root_remaining") {
      const proof = await g.observer.inspectClaim(claim);
      assert.throws(() => assertRewardIntentEvidence(proof, { target: g.target, now: g.clock(), scope: "reward_claim", method: "claim", ...claim, claimAmount: "18" }), /Unfunded/);
      await assert.rejects(g.ledger.advance(g.ids[0]), /Unfunded/);
    } else await assert.rejects(g.observer.inspectClaim(claim), /custody/);
    assert.equal(g.signed.length, 0); assert.equal(g.sent.length, 0);
  }
});

test("the second capture must still back the full unfinalized budget or finalized root remaining", async t => {
  for (const scope of ["funded_cycle", "reward_claim", "closed_epoch_work"]) {
    const f = scope === "reward_claim" ? await claimFixture(t) : await opened(t), o = observer(f);
    const get = f.rpc.getBlocks;
    f.rpc.getBlocks = async (...args) => { const result = await get(...args); f.balances.liabilities = "0"; f.advance(1); return result; };
    if (scope === "reward_claim") await assert.rejects(o.inspectClaim(await claimArgs(f)), /custody/);
    else if (scope === "funded_cycle") await assert.rejects(o.inspectFundedCycle(await cycleArgs(f)), /custody/);
    else await assert.rejects(o.inspectClosedEpochWork({ epoch: "1", minimumTime: String(2 * DAY) }), /custody/);
  }
});

test("our claimed transition cannot resolve a queued claim until its new state becomes irreversible", async t => {
  const f = await claimFixture(t), args = await claimArgs(f);
  assert.equal((await f.observer.inspectClaim(args)).state, "verified");
  const oldLib = f.head.last_irreversible_block; f.pay(args.account); f.advance(1); f.head.last_irreversible_block = oldLib;
  assert.equal((await f.ledger.advance(f.ids[0])).reason, "reward_changed");
  assert.equal((await f.ledger.advance(f.ids[0])).reason, "reward_reversible");
  assert.equal(f.ledger.status(f.ids[0]).state, "queued");
  f.head.last_irreversible_block = f.head.head_topology.height;
  assert.equal((await f.ledger.advance(f.ids[0])).state, "paid_elsewhere");
  assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0);
});

test("new finalizations progress through funding churn and retain the unchanged review hold", async t => {
  const f = await opened(t); await f.runner().tick({ openCurrentDay: false }); await f.include(f.sent[1]);
  for (let i = 0; i < 3; i++) if ((await f.cycle.advance("1")).action === "step_complete") break;
  depositOnVerification(f);
  assert.equal((await f.cycle.advance("1")).reason, "root_under_review");
  assert.equal(f.signed.length, 2); f.advance(DAY);
  await f.runner().tick({ openCurrentDay: false });
  assert.equal(f.sent.length, 3); assert.equal(f.signed.length, 3);
  await f.include(f.sent[2]); assert.equal((await f.cycle.advance("1")).action, "step_complete");
  assert.equal(f.sent.length, 3); assert.equal(f.signed.length, 3);
});

test("intent and live-custody validators reject wrong domains, intents, hashes, heights, timestamps and numeric values", async t => {
  const f = await claimFixture(t), args = await claimArgs(f), proof = await f.observer.inspectClaim(args);
  const request = { target: f.target, now: f.clock(), scope: "reward_claim", method: "claim", ...args, claimAmount: "18" };
  assertRewardIntentEvidence(proof, request);
  for (const edit of [
    p => { p.scope = "funded_cycle"; }, p => { p.intent.operationHash = P.hash("different-operation"); },
    p => { p.intent.epoch = "2"; }, p => { p.intentHash = P.hash("wrong"); },
    p => { p.account = f.ledger.status(f.ids[1]).account; }, p => { p.checkedAt--; },
    p => { p.checkedAt += 1; p.liveCustody.checkedAt = p.checkedAt; },
    p => { p.height = String(BigInt(p.revalidatedHead.lib) + 1n); },
    p => { p.revalidatedHead.id = "0x1220" + P.hash("another-head"); },
    p => { p.liveCustody.generation++; }, p => { p.liveCustody.chainTime = "1"; },
    p => { p.liveCustody.liquid = "01"; }, p => { p.liveCustody.liabilities = -1; },
    p => { delete p.liveCustody.epochPaid; }, p => { p.liveCustody.epochPaid = "999"; },
    p => { p.projectionHash = P.hash("bad-state"); }, p => { p.liveCustody.projectionHash = P.hash("old-state"); },
    p => { p.epoch.root.hash = utils.encodeBase64url(Buffer.from(P.hash("wrong-root"), "hex")); },
    p => { p.epoch.paid = "0"; }, p => { p.balances = { liquid: "1000", liabilities: "36" }; },
    p => { p.observedChainTime = String(f.clock() + 1); },
  ]) { const altered = structuredClone(proof); edit(altered); assert.throws(() => assertRewardIntentEvidence(altered, request)); }
  for (const change of [{ now: f.clock() + 5001 }, { operationHash: P.hash("wrong-operation") },
    { target: { ...f.target, rewardsHash: "0x1220" + P.hash("new-deployment") } }])
    assert.throws(() => assertRewardIntentEvidence(proof, { ...request, ...change }));
  await assert.rejects(f.observer.inspectFundedCycle({ epoch: "1", method: "open_epoch", operationHash: args.operationHash }));
});

test("work, claim and funded evidence scopes cannot authorize one another or a new opening", async t => {
  for (const invalidScope of ["closed_epoch_work", "reward_claim", "unknown"]) {
    const f = await opened(t), o = observer(f), inspect = o.inspectFundedCycle.bind(o);
    o.inspectFundedCycle = async args => ({ ...await inspect(args), scope: invalidScope });
    await assert.rejects(f.open({ observer: o }).advance("1"), /scope/);
  }
  const f = await cycleFixture(t), o = observer(f), inspect = o.inspectCycle.bind(o);
  o.inspectCycle = async args => ({ ...await inspect(args), scope: "funded_cycle" });
  await assert.rejects(f.open({ observer: o }).advance("1"), /intent/);
  for (const invalidScope of ["closed_epoch_work", "funded_cycle", undefined]) {
    const g = await claimFixture(t), claim = g.observer.inspectClaim.bind(g.observer);
    g.observer.inspectClaim = async args => ({ ...await claim(args), scope: invalidScope });
    await assert.rejects(g.ledger.advance(g.ids[0]), /exact claim intent/);
    assert.equal(g.sent.length, 0); assert.equal(g.signed.length, 0);
  }
});

test("minimum own-finality height, moving windows, endpoint generation and fork checks remain required for scoped proofs", async t => {
  for (const scope of ["funded_cycle", "reward_claim", "closed_epoch_work"]) for (const change of ["height", "head", "generation", "fork"]) {
    const f = scope === "reward_claim" ? await claimFixture(t) : await opened(t), o = observer(f);
    const args = scope === "reward_claim" ? await claimArgs(f) : scope === "funded_cycle" ? await cycleArgs(f) : { epoch: "1", minimumTime: String(2 * DAY) };
    const inspect = extra => scope === "reward_claim" ? o.inspectClaim({ ...args, ...extra }) : scope === "funded_cycle" ? o.inspectFundedCycle({ ...args, ...extra }) : o.inspectClosedEpochWork(args);
    assert.equal((await inspect()).state, "verified");
    if (change === "height") {
      if (scope === "closed_epoch_work") continue;
      const minimumHeight = String(BigInt(f.head.head_topology.height) + 1n);
      assert.equal((await inspect({ minimumHeight })).state, "before_finality");
      f.advance(1); f.head.last_irreversible_block = String(BigInt(minimumHeight) - 1n);
      assert.equal((await inspect({ minimumHeight })).state, "reversible");
      f.head.last_irreversible_block = minimumHeight;
      assert.equal((await inspect({ minimumHeight })).height, minimumHeight); continue;
    }
    const read = f.rpc.readContract, get = f.rpc.getBlocks;
    if (change === "head") f.rpc.readContract = async op => { const value = await read(op); f.advance(1); return value; };
    if (change === "generation") { f.rpc.readGeneration = 0; f.rpc.getBlocks = async (...a) => { const value = await get(...a); f.rpc.readGeneration++; return value; }; }
    if (change === "fork") f.rpc.getBlocks = async (...a) => (await get(...a)).map(b => ({ ...b, block_id: "0x1220" + P.hash("fork") }));
    assert.equal((await inspect()).state, change === "fork" ? "forked" : "changed", scope + ":" + change);
  }
});

test("saved claim and proposal retries survive restart with exact bytes, one signature and the existing nonce fences", async t => {
  const f = await opened(t); await f.runner().tick({ openCurrentDay: false }); const proposal = structuredClone(f.sent[1]);
  f.reopen(); depositOnVerification(f); f.advance(1001);
  await f.runner().tick({ openCurrentDay: false });
  assert.deepEqual(f.sent[2], proposal); assert.equal(f.signed.length, 2);
  const g = await claimFixture(t); await g.runner().tick(); const claim = structuredClone(g.sent[0]);
  g.reopen(); depositOnVerification(g); g.advance(1001); await g.runner().tick();
  assert.deepEqual(g.sent[1], claim); assert.equal(g.signed.length, 1);
  assert.equal((await g.ledger.advance(g.ids[1])).reason, "sponsor_nonce_busy");
});

test("scoped finalized results cannot substitute a different saved transaction or a proof below own inclusion", async t => {
  for (const change of ["transaction", "height"]) {
    const f = await claimFixture(t); await f.runner().tick(); f.finalized(f.sent[0]);
    if (change === "transaction") {
      const verify = f.observer.verifyClaim.bind(f.observer);
      f.observer.verifyClaim = async (...args) => ({ ...await verify(...args), txId: "0x1220" + P.hash("other-claim") });
      await assert.rejects(f.ledger.advance(f.ids[0]), /Exact saved claim/);
    } else {
      const inspect = f.observer.inspectClaim.bind(f.observer);
      f.observer.inspectClaim = async args => ({ ...await inspect(args), height: String(BigInt(args.minimumHeight) - 1n) });
      assert.equal((await f.ledger.advance(f.ids[0])).reason, "claim_state_finality");
    }
    assert.equal(f.ledger.status(f.ids[0]).state, "unknown"); assert.equal(f.sent.length, 1); assert.equal(f.signed.length, 1);
  }
});

test("snapshot priority covers nested reads and ends before any signing or submission", async t => {
  const { requestOwner } = require("../lib/koin-network/rpc-scheduler");
  for (const scope of ["current", "historical", "funded", "claim", "work"]) {
    const f = scope === "claim" ? await claimFixture(t) : scope === "current" ? await cycleFixture(t) : await opened(t);
    const o = observer(f), owners = [], read = f.rpc.readContract, metadata = f.rpc.invokeGetContractMetadata;
    f.rpc.readContract = async op => { owners.push(requestOwner(true)); return read(op); };
    f.rpc.invokeGetContractMetadata = async id => { owners.push(requestOwner(true)); return metadata(id); };
    const proof = scope === "claim" ? await o.inspectClaim(await claimArgs(f))
      : scope === "funded" ? await o.inspectFundedCycle(await cycleArgs(f))
        : scope === "work" ? await o.inspectClosedEpochWork({ epoch: "1", minimumTime: String(2 * DAY) })
          : await o.inspectCycle({ epoch: "1" });
    assert.equal(proof.state, "verified");
    assert.deepEqual([...new Set(owners.map(v => v.trafficClass))], [scope === "current" ? "availability" : "background"]);
    assert.equal(new Set(owners.map(v => v.id)).size, 2, "all nested pin and contract reads share their capture's owner");
    assert.doesNotThrow(() => requestOwner(false), "read-only context cannot leak into a later write");
  }
});
