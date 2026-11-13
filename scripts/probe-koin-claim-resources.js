"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite"), { Transaction } = require("koilib");
const { fixture, sponsor } = require("./helpers/koin-claims-fixture");
const { TestSigning } = require("../lib/koin-network/test-signing"), { KoinChain } = require("../lib/koin-network/chain");
const { encodeNonce } = require("../lib/koin-network/settlement-outbox"), P = require("../lib/koin-network/job-protocol");
const R = require("../lib/koin-network/claim-resources");
const errorRC = () => Object.assign(Error("KOIN RPC rejected the transaction: insufficient rc."), { code: "koin_rpc_insufficient_rc" });
const read = f => {
  const db = new DatabaseSync(path.join(f.dir, "reward-claims.sqlite"), { readOnly: true });
  try { return { rows: db.prepare("SELECT data FROM claims").all().map(r => JSON.parse(r.data)).sort((a,b) => f.ids.indexOf(a.id)-f.ids.indexOf(b.id)),
    mana: db.prepare("SELECT * FROM mana ORDER BY day,id").all(), identity: db.prepare("SELECT data FROM identity").get().data }; }
  finally { db.close(); }
};
async function environment(t) {
  const f = await fixture(t, { maxRcPerDay: "1000000" });
  const controls = { cost: "16000", nonce: 0, rc: "1000000", fail: null, receipt: null }, simulations = [];
  f.rpc.getNonce = async () => controls.nonce;
  f.rpc.getNextNonce = async () => encodeNonce(String(controls.nonce + 1));
  f.rpc.getAccountRc = async () => controls.rc;
  f.rpc.call = async (method, params) => {
    assert.equal(method, "chain.submit_transaction"); assert.equal(params.broadcast, false, "estimation may never broadcast");
    const tx = params.transaction; simulations.push(structuredClone(tx));
    if (controls.fail) throw controls.fail;
    if (BigInt(tx.header.rc_limit) < BigInt(controls.cost)) throw errorRC();
    return controls.receipt ? controls.receipt(tx) : { receipt: { id: tx.id, payer: tx.header.payer, rc_used: controls.cost } };
  };
  f.rpc.getBlocksById = async ids => ({ block_items: [...f.blocks.values()].filter(b => ids.includes(b.block_id)).map(b => structuredClone(b)) });
  const client = Object.assign(Object.create(KoinChain.prototype), { d: { ...f.target, network: "isolated" }, provider: f.rpc, verify: async () => ({}) });
  let signing;
  const open = () => {
    signing?.close(); signing = new TestSigning(path.join(f.dir, "signing"), { client, mode: "isolated-rehearsal", signers: { [sponsor.getAddress()]: sponsor } });
  };
  open(); t.after(() => { try { signing.close(); } catch {} });
  const prepare = async d => signing.prepare(P.hash("claim:" + d.id), { operation: d.operation, owner: d.payer, maxRc: d.maxRc });
  const estimated = async d => {
    const id = P.hash("claim:" + d.id), transaction = await signing.prepareEstimatedClaim(id,
      { operation: d.operation, owner: d.payer, maxRc: d.maxRc, floorRc: f.policy.maxRcPerTransaction });
    return { transaction, alternatives: signing.claimAlternatives(id) };
  };
  const recovery = async d => {
    const id = P.hash("claim:" + d.id), transaction = await signing.recoverClaimResources(id,
      { operation: d.operation, originalTxId: d.originalTxId, maxRc: d.maxRc });
    return { transaction, alternatives: signing.claimAlternatives(id) };
  };
  const runner = (extra = {}) => f.runner({ prepareClaim: estimated, recoverClaim: recovery, ...extra });
  const exhaust = async () => {
    const legacy = f.runner({ prepareClaim: prepare, submit: async tx => { await f.submit(tx); throw errorRC(); } });
    for (let i = 0; i < 3; i++) { await legacy.tick(); f.advance(1001); }
    assert.equal((await legacy.tick()).results[0].reason, "attempt_limit");
    const old = structuredClone(f.sent[0]); f.reopen({ resourceCeiling: "100000" }); return old;
  };
  const finalize = tx => {
    const b = f.finalized(tx, { recordClaim: false }); f.pay(f.ledger.status(f.ids[0]).account);
    Object.assign(b.receipt.transaction_receipts[0], { payer: sponsor.getAddress(), rc_used: "16000" });
    controls.nonce = Number(require("../lib/koin-network/settlement-outbox").nonce(tx.header.nonce));
  };
  return { f, controls, simulations, client, prepare, estimated, recovery, runner, exhaust, finalize, reopenSigning: open, get signing() { return signing; } };
}
test("a three-failure legacy claim recovers with the same nonce/recipient and retains old attempts and reservations", async t => {
  const e = await environment(t), { f } = e, old = await e.exhaust(), before = read(f);
  const result = (await e.runner().tick()).results[0], tx = f.sent.at(-1);
  assert.equal(result.action, "await_finality"); assert.equal(tx.header.rc_limit, "20000"); assert.notEqual(tx.id, old.id);
  R.sameIntent(old, tx); assert.equal(tx.header.nonce, old.header.nonce);
  const after = read(f); assert.equal(after.identity, before.identity);
  assert.deepEqual(after.rows[0].resourceHistory[0], before.rows[0].outbox);
  assert.equal(after.rows[0].resourceHistory[0].attempts, 3); assert.equal(after.rows[0].outbox.attempts, 1);
  assert.ok(after.mana.some(r => r.id === f.ids[0] && r.amount === "10000"));
  assert.ok(after.mana.some(r => r.id === f.ids[0] + ":" + tx.id && r.amount === "20000"));
  assert.equal(f.ledger.status(f.ids[1]).state, "queued");
  e.finalize(tx); await e.signing.reconcile();
  await e.runner().tick();
  assert.equal(f.ledger.status(f.ids[0]).state, "paid"); assert.equal(f.ledger.status(f.ids[0]).txId, tx.id);
  assert.equal(e.signing.statusFor(P.hash("claim:" + f.ids[0])).state, "finalized");
  await e.runner().tick();
  assert.notEqual(f.ledger.status(f.ids[1]).state, "queued", "next recipient is no longer blocked");
});
test("new claims estimate resources, add 25 percent headroom, and broadcast only the final staged envelope", async t => {
  const e = await environment(t), { f } = e; f.reopen({ resourceCeiling: "100000" });
  await e.runner().tick(); const tx = f.sent[0];
  assert.equal(tx.header.rc_limit, "20000"); assert.equal(e.simulations[0].header.rc_limit, "100000");
  assert.equal(f.sent.length, 1); assert.ok(read(f).rows[0].simulationTransactions.length);
  e.reopenSigning(); f.reopen({ resourceCeiling: "100000" }); f.advance(1001);
  await e.runner().tick(); assert.deepEqual(f.sent[1], tx);
});
test("crash after signing a recovery but before staging resumes the saved envelope", async t => {
  const e = await environment(t), { f } = e; await e.exhaust();
  const d = await f.ledger.advance(f.ids[0]), prepared = await e.recovery(d);
  const simulations = e.simulations.length;
  e.reopenSigning(); f.reopen({ resourceCeiling: "100000" });
  await e.runner().tick(); assert.deepEqual(f.sent.at(-1), prepared.transaction);
  assert.equal(read(f).rows[0].resourceHistory.length, 1); assert.ok(e.simulations.length > simulations);
});
test("a lost resource signature resumes the saved draft, preserving the original", async t => {
  const e = await environment(t), { f } = e, old = await e.exhaust(), sign = sponsor.signTransaction.bind(sponsor);
  const d = await f.ledger.advance(f.ids[0]);
  sponsor.signTransaction = async () => { throw Error("interrupted signing"); };
  try { await assert.rejects(e.recovery(d), /interrupted/); } finally { sponsor.signTransaction = sign; }
  assert.deepEqual(e.signing.envelope(P.hash("claim:" + f.ids[0])), old);
  e.reopenSigning(); f.reopen({ resourceCeiling: "100000" });
  await e.runner().tick(); R.sameIntent(old, f.sent.at(-1)); assert.equal(f.sent.at(-1).header.rc_limit, "20000");
});
for (const which of ["original", "simulation"]) test("late finality of the " + which + " envelope resolves both journals without duplicate payout", async t => {
  const e = await environment(t), { f } = e, old = await e.exhaust();
  await e.runner().tick(); const winner = which === "original" ? old : e.simulations.find(tx => tx.header.rc_limit === "100000");
  e.finalize(winner);
  // A valid old receipt must stay within its old resource limit.
  if (which === "original") [...f.blocks.values()].at(-1).receipt.transaction_receipts[0].rc_used = "9000";
  await e.signing.reconcile();
  await e.runner().tick();
  assert.equal(f.ledger.status(f.ids[0]).state, "paid"); assert.equal(f.ledger.status(f.ids[0]).txId, winner.id);
  assert.equal(e.signing.statusFor(P.hash("claim:" + f.ids[0])).state, "finalized");
  assert.equal(f.epoch.paid, "18");
});
for (const kind of ["nonce", "mana", "rpc", "pending", "successful_original"]) test("recovery refuses " + kind + " without sending or replacing the old envelope", async t => {
  const e = await environment(t), { f } = e, old = await e.exhaust();
  if (kind === "nonce") e.controls.nonce = 1;
  if (kind === "mana") e.controls.rc = "50000";
  if (kind === "rpc") e.controls.fail = Error("RPC unavailable");
  if (kind === "pending") f.lookups.set(old.id, { transaction: old, containing_blocks: [] });
  if (kind === "successful_original") e.controls.cost = "5000";
  const n = f.sent.length;
  if (kind === "pending") assert.notEqual((await e.runner().tick()).results[0].action, "prepare_resource_claim");
  else await assert.rejects(e.runner().tick());
  assert.equal(f.sent.length, n); assert.deepEqual(e.signing.envelope(P.hash("claim:" + f.ids[0])), old);
});
test("one bounded recovery cannot reset the original attempts or bypass the unchanged daily allowance", async t => {
  const e = await environment(t), { f } = e; await e.exhaust();
  // Exercise the actual persisted reservation budget, not a synthetic counter.
  const db = new DatabaseSync(path.join(f.dir, "reward-claims.sqlite"));
  db.prepare("INSERT INTO mana VALUES(?,?,?)").run(String(Math.floor(f.clock()/86400000)), "another-reservation", "985000"); db.close();
  assert.equal((await e.runner().tick()).results[0].reason, "sponsorship_budget");
  assert.equal(f.sent.length, 3); assert.equal(f.ledger.status(f.ids[0]).attempts, 0);
  assert.equal(read(f).rows[0].resourceHistory[0].attempts, 3);
});
test("unknown transport failures never authorize a resource replacement", async t => {
  const e = await environment(t), { f } = e;
  const driver = f.runner({ prepareClaim: e.prepare, submit: async () => { throw Error("lost response"); } });
  for (let i=0;i<3;i++) { await driver.tick(); f.advance(1001); }
  await driver.tick(); f.reopen({ resourceCeiling: "100000" });
  assert.equal((await e.runner().tick()).results[0].action, "review");
  assert.equal(read(f).rows[0].resourceRecovery, undefined);
});
test("resource staging rejects changes to nonce, recipient, operation and unauthorized ceilings", async t => {
  const e = await environment(t), { f } = e; const old = await e.exhaust();
  const d = await f.ledger.advance(f.ids[0]), good = (await e.recovery(d)).transaction;
  for (const change of [tx=>{tx.header.nonce=encodeNonce("2");},tx=>{tx.operations[0].call_contract.args="AA==";},
    tx=>{tx.header.rc_limit="100001";},tx=>{tx.header.payer=f.ledger.status(f.ids[0]).account;}]) {
    const draft=structuredClone(good); change(draft); draft.signatures=[]; delete draft.id;
    const altered=await Transaction.prepareTransaction(draft); await sponsor.signTransaction(altered);
    await assert.rejects(f.ledger.stageResourceRecovery(f.ids[0],altered));
  }
  assert.deepEqual(read(f).rows[0].outbox.transaction,old);
});
for (const kind of ["id", "payer", "revert", "missing", "numeric", "over_cap"]) test("simulation rejects " + kind + " receipts without broadcasting", async t => {
  const e=await environment(t),{f}=e;f.reopen({resourceCeiling:"100000"});
  e.controls.receipt=tx=>{
    const r={id:tx.id,payer:tx.header.payer,rc_used:"16000"};
    if(kind==="id")r.id="wrong"; if(kind==="payer")r.payer="wrong"; if(kind==="revert")r.reverted=true;
    if(kind==="numeric")r.rc_used=16000; if(kind==="over_cap")r.rc_used="100001";
    return kind==="missing"?{}:{receipt:r};
  };
  await assert.rejects(e.runner().tick());assert.equal(f.sent.length,0);
});
test("resource estimates and queue diagnostics do not expose signed envelopes", async t => {
  assert.equal(R.estimatedLimit("101","1","200"),"127");
  assert.throws(()=>R.estimatedLimit("180","1","200"),/ceiling/);
  const e=await environment(t);await e.exhaust();
  const status=e.f.ledger.queueStatus();assert.equal(status.blockingClaim.reason,"attempt_limit");
  assert.equal(status.pendingClaims,2);assert.equal(status.blockingClaim.attempts,3);
  assert.ok(!JSON.stringify(status).includes("signatures"));
});
test("a legacy signed claim interrupted before staging keeps its original scope on upgrade", async t => {
  const e = await environment(t), { f } = e;
  const d = await f.ledger.advance(f.ids[0]), old = await e.prepare(d);
  e.reopenSigning(); f.reopen({ resourceCeiling: "100000" });
  const prepared = await e.estimated({ ...d, maxRc: "100000" });
  assert.deepEqual(prepared.transaction, old); assert.equal(e.simulations.length, 0);
  await f.ledger.stage(f.ids[0], prepared.transaction, prepared.alternatives);
  assert.equal(f.ledger.status(f.ids[0]).state, "staged");
});
test("a new simulation envelope finalized before staging is recovered without another signature", async t => {
  const e = await environment(t), { f } = e; f.reopen({ resourceCeiling: "100000" });
  const d = await f.ledger.advance(f.ids[0]);
  const tx = await e.signing.prepare(P.hash("claim:" + d.id), { operation: d.operation, owner: d.payer, maxRc: d.maxRc });
  e.finalize(tx); await e.signing.reconcile();
  const prepared = await e.estimated(d); assert.deepEqual(prepared.transaction, tx);
  await f.ledger.stage(f.ids[0], prepared.transaction, prepared.alternatives);
  await e.runner().tick(); assert.equal(f.ledger.status(f.ids[0]).state, "paid"); assert.equal(f.sent.length, 0);
});
test("a failed replacement is never granted a second resource recovery", async t => {
  const e = await environment(t), { f } = e; await e.exhaust();
  const driver = e.runner({ submit: async tx => { await f.submit(tx); throw errorRC(); } });
  for (let i = 0; i < 3; i++) { await driver.tick(); f.advance(1001); }
  await driver.tick();
  assert.equal((await driver.tick()).results[0].action, "review");
  const row = read(f).rows[0]; assert.equal(row.resourceHistory[0].attempts, 3); assert.equal(row.outbox.attempts, 3);
  assert.equal(f.sent.length, 6);
});
test("resource ceiling never enlarges the original daily budget or invalidates an existing higher limit", () => {
  assert.equal(R.ceiling("100000000", "12500000000"), "1000000000");
  assert.equal(R.ceiling("100000000", "500000000"), "500000000");
  assert.equal(R.ceiling("2000000000", "4000000000"), "2000000000");
});
test("claim preparation resource waits preserve independent daily progress while validation failures retain their gate", async () => {
  const { TestRuntime } = require("../lib/koin-network/test-runtime");
  for (const phase of ["prepared_reward_recovery", "payout_confirmation"]) {
    for (const kind of ["mana", "rc", "rpc", "receipt", "nonce"]) {
      const calls = [], record = name => async () => { calls.push(name); };
      const error = kind === "rc" ? errorRC() : kind === "rpc" ? Object.assign(Error("RPC unavailable"), { code: "koin_rpc_unavailable", retryable: true }) :
        ["mana", "nonce"].includes(kind) ? R.wait("Claim resource unavailable") : Error("Invalid simulation receipt");
      const r = Object.assign(Object.create(TestRuntime.prototype), {
        clock: () => 100000, errors: [], prepaid: true, lastSuccess: 90000, config: { maxRcPerTransaction: "10000" },
        scheduler: { koinPrepaid: { purchases: { tick: record("purchases") } } }, prepaidSettlement: { tick: record("usage") },
        client: { verify: record("verify"), read: async () => ({ liquid: "10", liabilities: "0" }) },
        signing: { reconcile: record("signatures"), prepareEstimatedClaim: async () => { throw error; } },
        recoverPreparedRewards: record("recover"), ledger: { pendingJobs: () => [] }, submitter: { tick: record("payout") },
        cycleRunner: { tick: record("cycles") }, collectRewards: record("collect"),
      });
      const fail = () => r.prepareClaim({ id: "claim", operation: {}, payer: "payer", maxRc: "100000" });
      if (phase === "prepared_reward_recovery") r.recoverPreparedRewards = fail; else r.submitter.tick = fail;
      await r.tick();
      assert.equal(calls.includes("cycles"), kind !== "receipt"); assert.equal(r.lastSuccess, 90000);
      assert.equal(r.lastRewardSuccess, kind === "receipt" ? undefined : 100000);
      assert.equal(r.errors[0].stage, phase);
    }
  }
});
test("a claim estimated by this release can recover once and reconcile a repeated simulation candidate", async t => {
  const e = await environment(t), { f } = e; f.reopen({ resourceCeiling: "100000" });
  const driver = e.runner({ submit: async tx => { await f.submit(tx); throw errorRC(); } });
  for (let i = 0; i < 3; i++) { await driver.tick(); f.advance(1001); }
  await driver.tick(); e.controls.cost = "24000";
  await e.runner().tick(); assert.equal(f.sent.at(-1).header.rc_limit, "30000");
  const cap = e.simulations.find(tx => tx.header.rc_limit === "100000");
  e.finalize(cap); await e.signing.reconcile(); await e.runner().tick();
  assert.equal(f.ledger.status(f.ids[0]).state, "paid"); assert.equal(f.ledger.status(f.ids[0]).txId, cap.id);
});
