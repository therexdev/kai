"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite"), { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), { Transaction, Signer } = require("koilib");
const { fixture, verifier, payer } = require("./helpers/koin-outbox-fixture");
const { encodeNonce, nonce } = require("../lib/koin-network/settlement-outbox");
const P = require("../lib/koin-network/job-protocol"), { DAY } = require("../lib/koin-network/policy");
const dbPath = f => path.join(f.config.dataDir, "koin-funded-sessions/funded-reservations.sqlite");
if (process.argv[2] === "--crash") {
  (async () => {
    const f = await fixture({ after() {} }), id = await f.accepted("crash"), tx = await f.stage(id);
    if (process.argv[3] === "attempt") await f.ledger.nextSettlementAttempt({ id, observationId: await f.observe() });
    fs.writeSync(1, JSON.stringify({ dir: f.dir, file: dbPath(f), id, txId: tx.id }));
    process.kill(process.pid, "SIGKILL");
  })().catch(e => { fs.writeSync(2, e.stack); process.exit(1); });
} else {

test("the outbox saves the exact signed transaction and hold atomically before exposing an attempt", async t => {
  const f = await fixture(t), id = await f.accepted("one"), tx = await f.stage(id);
  const status = f.ledger.settlementStatus(id); assert.equal(status.state, "staged"); assert.equal(status.attempts, 0);
  assert.equal(f.ledger.job(id).txId, tx.id); assert.equal(f.ledger.job(id).state, "submitted");
  assert.equal(status.paymentsEnabled, false); assert.equal(status.transaction, undefined);
  const attempt = await f.recovery().step({ id, observationId: await f.observe() });
  assert.equal(attempt.action, "submit_exact_transaction"); assert.equal(attempt.attempts, 1);
  const reopened = f.reopen(); assert.equal(reopened.settlementStatus(id).attempts, 1);
  assert.equal(reopened.settlementStatus(id).state, "unknown");
  assert.equal(attempt.transaction.id, tx.id); assert.deepEqual(attempt.transaction.signatures, tx.signatures);
  assert.ok(!JSON.stringify(attempt).includes(f.token));
  await assert.rejects(f.ledger.stageSettlement({ id, transaction: await f.signed(id, "2"), observationId: await f.observe() }), /Cannot replace/);
});

test("process death after staging or after checkpointing an attempt leaves complete recoverable bytes", () => {
  for (const point of ["stage", "attempt"]) {
    let info;
    try { execFileSync(process.execPath, [__filename, "--crash", point], { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }); assert.fail("Expected process death"); }
    catch (e) { assert.equal(e.signal, "SIGKILL", String(e.stderr)); info = JSON.parse(e.stdout); }
    try {
      const db = new DatabaseSync(info.file);
      try {
        const out = JSON.parse(db.prepare("SELECT data FROM settlement_outbox WHERE id=?").get(info.id).data);
        const hold = JSON.parse(db.prepare("SELECT data FROM holds WHERE id=?").get(info.id).data);
        assert.equal(out.txId, info.txId); assert.equal(hold.txId, info.txId);
        assert.equal(out.transactionHash, P.hash(JSON.stringify(out.transaction)));
        assert.equal(out.attempts, point === "attempt" ? 1 : 0); assert.equal(out.transaction.signatures.length, 2);
        assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
      } finally { db.close(); }
    } finally { fs.rmSync(info.dir, { recursive: true, force: true }); }
  }
});

test("wrong operations, roles, signatures, chain pins and resource ceilings never enter the outbox", async t => {
  const f = await fixture(t), id = await f.accepted("one"), good = await f.signed(id), observationId = await f.observe();
  for (const alter of [
    x => { x.header.chain_id = "EiA"; }, x => { x.header.payer = f.owner; }, x => { x.header.payee = f.owner; },
    x => { x.header.rc_limit = "10001"; }, x => { x.header.rc_limit = "0"; }, x => { x.header.nonce = "KAEA"; },
    x => { x.operations.push(structuredClone(x.operations[0])); }, x => { x.operations[0].call_contract.args = "AA=="; },
    x => { x.operations[0].call_contract.contract_id = f.owner; }, x => { x.signatures.pop(); },
    x => { x.signatures[1] = x.signatures[0]; }, x => { x.header.extra = "unreviewed"; },
    x => { x.id = "0x1220" + P.hash("wrong"); }, x => { x.header.operation_merkle_root = "changed"; },
  ]) { const tx = structuredClone(good); alter(tx); await assert.rejects(f.ledger.stageSettlement({ id, transaction: tx, observationId })); }
  const wrong = structuredClone(good); wrong.signatures = [];
  await Signer.fromSeed("wrong-verifier").signTransaction(wrong); await payer.signTransaction(wrong);
  await assert.rejects(f.ledger.stageSettlement({ id, transaction: wrong, observationId }), /Wrong settlement signers/);
  assert.throws(() => f.ledger.settlementStatus(id), /No saved/);
  assert.throws(() => f.ledger.recordTransaction({ id, txId: good.id }), /full signed transaction/);
  assert.equal(f.ledger.job(id).state, "prepared");
  assert.throws(() => f.reopen({ settlementPolicy: { ...f.settlementPolicy, verifier: f.owner } }), /verifier differs/);
  for (const n of ["1", "127", "128", "18446744073709551615"]) assert.equal(nonce(encodeNonce(n)), n);
  for (const n of ["0", "18446744073709551616"]) assert.throws(() => encodeNonce(n));
});

test("concurrent handles cannot duplicate an attempt or reset sponsorship policy on reopen", async t => {
  const f = await fixture(t), id = await f.accepted("one"), tx = await f.signed(id), observationId = await f.observe(), second = f.reopen();
  const staged = await Promise.all([f.ledger.stageSettlement({ id, transaction: tx, observationId }), second.stageSettlement({ id, transaction: tx, observationId })]);
  assert.equal(staged[0].txId, staged[1].txId);
  const attempts = await Promise.all([f.ledger.nextSettlementAttempt({ id, observationId }), second.nextSettlementAttempt({ id, observationId })]);
  assert.equal(attempts.filter(v => v.action === "submit_exact_transaction").length, 1); assert.equal(second.settlementStatus(id).attempts, 1);
  assert.throws(() => f.reopen({ settlementPolicy: { ...f.settlementPolicy, maxRcPerDay: "999999" } }), /policy changed/);
  assert.throws(() => f.reopen({ settlementPolicy: null }), /policy required/);
});

test("lost acknowledgments retry the identical envelope after restart without signing or replacing the nonce", async t => {
  const f = await fixture(t), id = await f.accepted("one"); await f.stage(id);
  const first = await f.recovery().step({ id, observationId: await f.observe() });
  await f.restart(); assert.equal(f.ledger.settlementStatus(id).attempts, 1);
  assert.equal((await f.recovery().step({ id, observationId: await f.observe() })).action, "wait");
  f.advance(1001);
  const retry = await f.recovery().step({ id, observationId: await f.observe() });
  assert.equal(retry.action, "submit_exact_transaction"); assert.deepEqual(retry.transaction, first.transaction);
  assert.equal(retry.attempts, 2); assert.equal(f.ledger.job(id).amount, f.ledger.job(id).receipt.usage.amount);
});

test("pending and reversible transactions retain the hold; only exact finality and accounting advance the session", async t => {
  const f = await fixture(t), id = await f.accepted("one"), next = await f.accepted("two"), tx = await f.stage(id);
  await f.recovery().step({ id, observationId: await f.observe() });
  f.lookup.transactions = [{ transaction: tx, containing_blocks: [] }];
  assert.equal((await f.recovery().step({ id, observationId: await f.observe() })).state, "pending");
  const height = f.finalized(id, tx); f.head.last_irreversible_block = String(height - 1);
  const observationId = await f.observe();
  assert.equal((await f.recovery().step({ id, observationId })).state, "reversible");
  assert.equal(f.ledger.job(id).state, "submitted");
  f.head.last_irreversible_block = String(height);
  const done = await f.recovery().step({ id, observationId });
  assert.equal(done.state, "settled"); assert.equal(done.next.id, next); assert.equal(done.next.intent.nonce, "2");
  assert.equal(f.ledger.job(id).amount, "0"); assert.equal(f.ledger.delegationStatus({ id: f.approval.delegationId, accountId: f.account.id }).spent, f.ledger.job(id).receipt.usage.amount);
  assert.equal((await f.recovery().step({ id, observationId })).state, "settled");
  assert.equal(f.ledger.job(next).intent.nonce, "2");
  await assert.rejects(f.ledger.stageSettlement({ id: next, transaction: await f.signed(next, "1"), observationId }), /nonce cannot be reused/);
});

test("daily Mana ceilings count each transaction once, including retries, and survive restart", async t => {
  const f = await fixture(t), id = await f.accepted("one"), next = await f.accepted("two"), tx = await f.stage(id);
  await f.recovery().step({ id, observationId: await f.observe() }); f.advance(1001);
  assert.equal((await f.recovery().step({ id, observationId: await f.observe() })).action, "submit_exact_transaction");
  f.finalized(id, tx); await f.recovery().step({ id, observationId: await f.observe() });
  f.lookup.transactions = []; await f.stage(next, "2"); await f.restart();
  const blocked = await f.recovery().step({ id: next, observationId: await f.observe() });
  assert.equal(blocked.action, "wait"); assert.equal(blocked.reason, "sponsorship_budget"); assert.equal(blocked.attempts, 0);
  f.advance(DAY - 1001);
  const allowed = await f.recovery().step({ id: next, observationId: await f.observe() });
  assert.equal(allowed.action, "submit_exact_transaction"); assert.equal(allowed.attempts, 1);
});

test("reverted transactions and retry exhaustion require review without releasing or replacing the charge", async t => {
  for (const reason of ["revert", "limit"]) {
    const f = await fixture(t, { maxAttempts: 1 }), id = await f.accepted("one"), tx = await f.stage(id);
    await f.recovery().step({ id, observationId: await f.observe() });
    if (reason === "revert") f.finalized(id, tx, { reverted: true }); else f.advance(1001);
    const state = await f.recovery().step({ id, observationId: await f.observe() });
    assert.equal(state.action, "review"); assert.equal(state.state, "needs_review");
    assert.equal(state.reason, reason === "revert" ? "finalized_revert" : "attempt_limit");
    assert.equal(f.ledger.job(id).state, "submitted"); assert.notEqual(f.ledger.job(id).amount, "0");
    await assert.rejects(f.ledger.stageSettlement({ id, transaction: await f.signed(id, "2"), observationId: await f.observe() }), /Cannot replace/);
    await f.restart(); assert.equal(f.ledger.settlementStatus(id).state, "needs_review");
    if (reason === "limit") { f.finalized(id, tx); assert.equal((await f.recovery().step({ id, observationId: await f.observe() })).state, "settled"); }
  }
});

test("unexpected charge deltas freeze the session and do not clear a finalized transaction hold", async t => {
  const f = await fixture(t), id = await f.accepted("one"), tx = await f.stage(id); f.finalized(id, tx, { extraSpend: 1 });
  await assert.rejects(f.recovery().step({ id, observationId: await f.observe() }), /exact charge/);
  await f.restart(); assert.equal(f.ledger.status(f.id).blocked, true); assert.equal(f.ledger.job(id).state, "submitted");
  assert.notEqual(f.ledger.job(id).amount, "0");
});

test("unknown transactions cannot retry after the settlement window or a bytecode change", async t => {
  const f = await fixture(t), id = await f.accepted("one"); await f.stage(id);
  const before = f.ledger.settlementStatus(id);
  f.metadata.value.hash = "0x1220" + P.hash("upgrade");
  await assert.rejects(f.recovery().step({ id }), /bytecode/); assert.equal(f.ledger.settlementStatus(id).attempts, before.attempts);
  f.metadata.value.hash = f.target.creditsHash; f.advance(DAY + 60001);
  await assert.rejects(f.recovery().step({ id, observationId: await f.observe() }), /no longer eligible/);
  assert.equal(f.ledger.job(id).state, "submitted"); assert.equal(f.ledger.settlementStatus(id).attempts, 0);
});

test("corrupt saved bytes or a missing Mana journal fail closed", async t => {
  for (const corrupt of ["envelope", "mana"]) {
    const f = await fixture(t), id = await f.accepted("one"); await f.stage(id);
    await f.recovery().step({ id, observationId: await f.observe() }); f.advance(1001);
    const db = new DatabaseSync(dbPath(f));
    try {
      if (corrupt === "mana") db.prepare("DELETE FROM settlement_mana WHERE id=?").run(id);
      else { const row = JSON.parse(db.prepare("SELECT data FROM settlement_outbox WHERE id=?").get(id).data); row.transaction.signatures = []; db.prepare("UPDATE settlement_outbox SET data=? WHERE id=?").run(JSON.stringify(row), id); }
    } finally { db.close(); }
    await assert.rejects(f.recovery().step({ id, observationId: await f.observe() }), corrupt === "mana" ? /journal/ : /Damaged/);
    assert.notEqual(f.ledger.job(id).amount, "0");
  }
});

test("a transaction on an abandoned fork can only retry its original bytes, never release the hold", async t => {
  const f = await fixture(t), id = await f.accepted("one"), tx = await f.stage(id);
  const first = await f.recovery().step({ id, observationId: await f.observe() });
  const block = f.advance(1001), forkId = "0x1220" + P.hash("fork");
  f.lookup.transactions = [{ transaction: tx, containing_blocks: [forkId] }];
  f.rpc.getBlocksById = async () => ({ block_items: [{ block_id: forkId, block_height: block.block_height }] });
  const retry = await f.recovery().step({ id, observationId: await f.observe() });
  assert.equal(retry.action, "submit_exact_transaction"); assert.deepEqual(retry.transaction, first.transaction);
  assert.equal(f.ledger.job(id).state, "submitted"); assert.notEqual(f.ledger.job(id).amount, "0");
});

test("work dispatched before revocation remains eligible, but stopped or changed funding cannot be staged", async t => {
  const f = await fixture(t), id = await f.accepted("one"), tx = await f.signed(id);
  f.advance(100); f.session.session.revoked_at = String(f.config.koinFundedSessions.clock());
  f.session.session.settle_until = String(f.config.koinFundedSessions.clock() + DAY);
  await f.ledger.stageSettlement({ id, transaction: tx, observationId: await f.observe() });
  assert.equal((await f.recovery().step({ id, observationId: await f.observe() })).action, "submit_exact_transaction");
  f.session.session.remaining = String(BigInt(f.session.session.remaining) - 1n); f.advance(1001);
  await assert.rejects(f.recovery().step({ id, observationId: await f.observe() }), /Session changed/);
  assert.equal(f.ledger.status(f.id).blocked, true); assert.equal(f.ledger.settlementStatus(id).attempts, 1);
});

test("successful reconciliation stays successful when the next accepted job's settlement window has closed", async t => {
  const f = await fixture(t), id = await f.accepted("one"), next = await f.accepted("two"), tx = await f.stage(id);
  f.finalized(id, tx); f.advance(DAY + 60001);
  const done = await f.recovery().step({ id, observationId: await f.observe() });
  assert.equal(done.action, "done"); assert.equal(done.state, "settled");
  assert.equal(done.next.id, next); assert.equal(done.next.state, "needs_review");
  assert.equal(f.ledger.job(next).state, "verified"); assert.notEqual(f.ledger.job(next).amount, "0");
});

}
