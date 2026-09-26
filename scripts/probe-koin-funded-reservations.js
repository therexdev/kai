"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Signer, Transaction } = require("koilib");
const { FundedReservations, reservationHash, fundedResultHash } = require("../lib/koin-network/funded-reservations");
const { Meter, hash } = require("../lib/koin-network/metering");
const P = require("../lib/koin-network/job-protocol");
const { fixture, addr, nextId } = require("./helpers/koin-funding-fixture");
const { DAY } = require("../lib/koin-network/policy");
const owner = Signer.fromSeed("funded-probe-owner");
const sign = async (value, signer = owner) => Buffer.from(await signer.signHash(value)).toString("base64");
async function setup(t, { maxJobs = "10" } = {}) {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "funded-reservations-"));
  const tariff = { model: "fixture", version: 1, modelHash: hash("m"), tokenizerHash: hash("t"), templateHash: hash("p"),
    inputAtomsPerMillion: "10000000", outputAtomsPerMillion: "10000000", maxOutputTokens: 50, contextTokens: 4096, maxLatencyMs: 1000 };
  const adapter = { ...tariff, input: () => 20, output: () => 1, render: JSON.stringify, encode: (s) => [...Buffer.from(s)] };
  const meter = new Meter([{ tariff, adapter }]);
  // Bind the actual observer to this tariff policy before constructing it again.
  f.target.policyHash = meter.policyHash;
  const { utils } = require("koilib");
  f.session.session.policy_hash = utils.encodeBase64url(Buffer.from(meter.policyHash, "hex"));
  f.session.session.per_job = "1000";
  f.session.session.max_jobs = maxJobs;
  const { FundedSessionObserver } = require("../lib/koin-network/funded-session");
  const observer = new FundedSessionObserver(f.rpc, f.target);
  const observed = await observer.observe(f.request); f.finalize();
  const target = { chainId: f.target.chainId, credits: f.target.credits, creditsHash: f.target.creditsHash,
    policyHash: meter.policyHash, domain: "shadow:funded-reservation-test" };
  const handles = [], reopen = (override = {}) => {
    const ledger = new FundedReservations(dir, { observer, target, meter, accept: ({ output }) => output === "4", clock: f.target.clock, ...override }); handles.push(ledger); return ledger;
  };
  t.after(() => { for (const h of handles) { try { h.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  const ledger = reopen();
  const quote = ledger.quote("fixture", 1, [{ role: "user", content: "private prompt" }], 50);
  const request = async (n = 0) => ({ id: hash("job" + n), observationId: observed.observationId, quote,
    signature: await sign(reservationHash(target, "reserve", f.id, hash("job" + n), quote.hash)) });
  return { ...f, observer, dir, target, ledger, reopen, request, quote, observed };
}
async function accepted(f, n = 0) {
  const r = await f.request(n); await f.ledger.reserve(r);
  const job = await f.ledger.markDispatched({ id: r.id, observationId: r.observationId, provider: addr("worker") });
  const signature = await sign(fundedResultHash(f.target, job, "4"), Signer.fromSeed("funded-probe-worker"));
  const receipt = f.ledger.complete({ id: r.id, output: "4", signature });
  return { ...r, job, receipt, resultSignature: signature };
}
async function finalizedCharge(f, id, { extraSpend = 0, revoked = false, expired = false, badOperation = false } = {}) {
  const intent = f.ledger.prepare(id), op = await f.ledger.settlementOperation(id);
  const tx = await Transaction.prepareTransaction({ header: { chain_id: f.target.chainId, payer: f.owner,
    nonce: "KAE=", rc_limit: "1000000" }, operations: [{ call_contract: badOperation ? { ...op, args: "AA==" } : op }], signatures: [] });
  f.ledger.recordTransaction({ id, txId: tx.id });
  const charged = BigInt(intent.amount) + BigInt(extraSpend);
  f.session.session.remaining = String(1000n - charged); f.session.session.jobs = "1"; f.session.session.nonce = "1";
  f.balances.balance.reserved = String(1000n - charged); f.balances.liabilities = String(1020n - charged); f.balances.liquid = String(1020n - charged);
  const now = 2 * DAY + (expired ? 60001 : 100); f.time(now); f.head.head_block_time = String(now);
  if (revoked) { f.session.session.revoked_at = String(now); f.session.session.settle_until = String(now + DAY); }
  f.block.block_id = nextId; f.block.block_height = "101"; f.block.block.id = nextId;
  f.block.block.header = { height: "101", timestamp: String(now) }; f.block.block.transactions = [tx];
  f.block.receipt = { id: nextId, height: "101", transaction_receipts: [{ id: tx.id, reverted: false }] };
  const lookup = { transactions: [{ transaction: tx, containing_blocks: [nextId] }] };
  f.rpc.getTransactionsById = async () => structuredClone(lookup);
  f.rpc.getBlocksById = async () => ({ block_items: [{ block_id: nextId, block_height: "101" }] });
  const observation = await f.observer.observe({ id: f.id, owner: f.owner, purpose: "reconciliation" });
  f.head.last_irreversible_block = "101";
  return { observationId: observation.observationId, intent, tx, lookup };
}
if (process.argv[2] === "--crash") {
  (async () => {
    const f = await setup({ after() {} }), r = await f.request();
    await f.ledger.reserve(r);
    fs.writeSync(1, JSON.stringify({ dir: f.dir, id: r.id }));
    process.exit(0);
  })().catch((e) => { process.stderr.write(e.message); process.exit(1); });
} else {
test("funded reservation requires bound owner approval and retries once", async (t) => {
  const f = await setup(t), r = await f.request();
  const legacySignature = await sign(P.authorizeHash(f.target.domain, f.id, r.id, f.quote.hash));
  await assert.rejects(() => f.ledger.reserve({ ...r, signature: legacySignature }), /Signature/);
  const first = await f.ledger.reserve(r); assert.equal(first.amount, "700");
  assert.deepEqual(await f.ledger.reserve(r), first);
  assert.equal(f.ledger.status(f.id).held, "700"); assert.equal(f.ledger.status(f.id).available, "300");
  assert.equal(first.paymentsEnabled, false);
  await assert.rejects(() => f.ledger.reserve({ ...r, id: hash("different") }), /Signature/);
});
test("concurrent shared-database writers cannot reserve the same remaining funds", async (t) => {
  const f = await setup(t), other = f.reopen(), requests = await Promise.all([f.request(1), f.request(2)]);
  const results = await Promise.allSettled([f.ledger.reserve(requests[0]), other.reserve(requests[1])]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.reopen().status(f.id).held, "700");
});
test("signed cancellation releases only undispatched holds", async (t) => {
  const f = await setup(t), r = await f.request(); await f.ledger.reserve(r);
  const cancel = { id: r.id, signature: await sign(reservationHash(f.target, "cancel", f.id, r.id, f.quote.hash)) };
  assert.throws(() => f.ledger.cancel({ id: r.id, signature: r.signature }), /Signature/);
  f.ledger.cancel(cancel); f.ledger.cancel(cancel);
  assert.equal(f.ledger.status(f.id).held, "0");
  assert.equal((await f.ledger.reserve(r)).state, "cancelled", "a replay cannot resurrect a cancelled job");
});
test("dispatch rechecks funding and unresolved holds survive restart and expiry", async (t) => {
  const f = await setup(t), r = await f.request(); await f.ledger.reserve(r);
  await assert.rejects(() => f.ledger.markDispatched({ id: r.id, observationId: r.observationId, provider: f.owner }), /Invalid/);
  await f.ledger.markDispatched({ id: r.id, observationId: r.observationId, provider: addr("worker") });
  const reopened = f.reopen(); f.time(3 * DAY);
  assert.equal(reopened.status(f.id).held, "700");
  const signature = await sign(reservationHash(f.target, "cancel", f.id, r.id, f.quote.hash));
  assert.throws(() => reopened.cancel({ id: r.id, signature }), /stays held/);
});
test("revocation and RPC failures refuse dispatch without releasing reservations", async (t) => {
  const f = await setup(t), r = await f.request(); await f.ledger.reserve(r);
  f.session.session.revoked_at = String(2 * DAY);
  await assert.rejects(() => f.ledger.markDispatched({ id: r.id, observationId: r.observationId, provider: addr("worker") }), /revoked/);
  assert.equal(f.ledger.status(f.id).held, "700");
  f.rpc.getChainId = async () => { throw Error("offline"); };
  await assert.rejects(() => f.ledger.reserve(r), /offline/);
  assert.equal(f.ledger.status(f.id).held, "700");
});
test("changed on-chain spending persistently freezes the session for reconciliation", async (t) => {
  const f = await setup(t), r = await f.request(); await f.ledger.reserve(r);
  f.session.session.remaining = "990"; f.session.session.jobs = "1"; f.session.session.nonce = "1";
  f.balances.balance.reserved = "990"; f.balances.liabilities = "1010"; f.balances.liquid = "1010";
  const changed = await f.observer.observe({ id: f.id, owner: f.owner });
  f.head.last_irreversible_block = "101";
  f.block.block_id = nextId; f.block.block_height = "101"; f.block.block.id = nextId; f.block.block.header.height = "101";
  await assert.rejects(() => f.ledger.markDispatched({ id: r.id, observationId: changed.observationId, provider: addr("worker") }), /reconciliation/);
  const reopened = f.reopen(); assert.equal(reopened.status(f.id).blocked, true);
  assert.equal(reopened.status(f.id).held, "700");
});
test("deployment replacement, fake observers and missing identity fail closed", async (t) => {
  const f = await setup(t), r = await f.request(); await f.ledger.reserve(r);
  assert.throws(() => f.reopen({ target: { ...f.target, credits: addr("replacement") } }), /deployment mismatch/);
  assert.throws(() => f.reopen({ observer: { verify: async () => ({ state: "verified" }) } }), /Trusted/);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(f.dir, "funded-reservations.sqlite")); db.exec("DELETE FROM identity"); db.close();
  assert.throws(() => f.reopen(), /Missing funded ledger identity/);
});
test("a caller cannot replace the ledger-issued price even with a valid owner signature", async (t) => {
  const f = await setup(t), r = await f.request();
  const quote = structuredClone(f.quote);
  quote.tariff.inputAtomsPerMillion = "1000000"; quote.tariff.outputAtomsPerMillion = "1000000"; quote.maxCharge = "70";
  const { hash: oldHash, ...body } = quote; quote.hash = hash(JSON.stringify(body));
  P.validateQuote(quote);
  const signature = await sign(reservationHash(f.target, "reserve", f.id, r.id, quote.hash));
  await assert.rejects(() => f.ledger.reserve({ ...r, quote, signature }), /not issued/);
  await f.ledger.reserve(r); assert.equal(f.ledger.status(f.id).held, "700");
});
test("committed funded holds survive abrupt process exit without close", (t) => {
  const { spawnSync } = require("child_process"), { DatabaseSync } = require("node:sqlite");
  const child = spawnSync(process.execPath, [__filename, "--crash"], { encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const { dir, id } = JSON.parse(child.stdout);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "funded-reservations.sqlite"));
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    const h = JSON.parse(db.prepare("SELECT data FROM holds WHERE id=?").get(id).data);
    assert.equal(h.amount, "700"); assert.equal(h.state, "reserved");
  } finally { db.close(); }
});
test("funded result signatures, metering and acceptance bind the stored charge", async (t) => {
  const f = await setup(t), r = await accepted(f);
  assert.equal(r.receipt.usage.amount, "210"); assert.equal(f.ledger.status(f.id).held, "210");
  assert.deepEqual(f.ledger.complete({ id: r.id, output: "4", signature: r.resultSignature }), r.receipt);
  assert.throws(() => f.ledger.complete({ id: r.id, output: "wrong", signature: r.resultSignature }), /Signature/);
  const intent = f.ledger.prepare(r.id); assert.equal(intent.amount, "210"); assert.equal(intent.nonce, "1");
  assert.deepEqual(f.reopen().prepare(r.id), intent);
  const second = await accepted(f, 1);
  assert.throws(() => f.ledger.prepare(second.id), /unresolved/);
});
test("exact finalized charge and session delta reconcile once across restart", async (t) => {
  const f = await setup(t), r = await accepted(f), chain = await finalizedCharge(f, r.id);
  const reopened = f.reopen();
  assert.equal((await reopened.reconcile({ id: r.id, observationId: chain.observationId })).state, "settled");
  assert.equal(reopened.status(f.id).held, "0"); assert.equal(reopened.status(f.id).available, "790");
  assert.equal(reopened.status(f.id).remainingJobs, "9");
  assert.equal((await reopened.reconcile({ id: r.id, observationId: chain.observationId })).state, "settled");
  assert.equal(reopened.status(f.id).available, "790");
});
test("unknown, reversible, reverted or replaced transactions keep holds", async (t) => {
  const f = await setup(t), r = await accepted(f), c = await finalizedCharge(f, r.id);
  assert.throws(() => f.ledger.recordTransaction({ id: r.id, txId: "0x1220" + hash("replacement") }), /replace/);
  f.head.last_irreversible_block = "100";
  assert.equal((await f.ledger.reconcile({ id: r.id, observationId: c.observationId })).state, "reversible");
  f.head.last_irreversible_block = "101"; f.block.receipt.transaction_receipts[0].reverted = true;
  assert.equal((await f.ledger.reconcile({ id: r.id, observationId: c.observationId })).state, "reverted");
  c.lookup.transactions = [];
  assert.equal((await f.ledger.reconcile({ id: r.id, observationId: c.observationId })).state, "unknown");
  assert.equal(f.ledger.status(f.id).held, "210");
});
test("wrong operation or unexplained chain spending cannot clear a hold", async (t) => {
  const f = await setup(t), r = await accepted(f), c = await finalizedCharge(f, r.id, { badOperation: true });
  await assert.rejects(() => f.ledger.reconcile({ id: r.id, observationId: c.observationId }), /operation mismatch/);
  assert.equal(f.ledger.status(f.id).held, "210");
  const g = await setup(t), s = await accepted(g), d = await finalizedCharge(g, s.id, { extraSpend: 1 });
  await assert.rejects(() => g.ledger.reconcile({ id: s.id, observationId: d.observationId }), /does not match/);
  assert.equal(g.reopen().status(g.id).blocked, true); assert.equal(g.ledger.status(g.id).held, "210");
});
test("earlier accepted charges reconcile after revocation, expiry and exhausted job count", async (t) => {
  for (const options of [{ revoked: true }, { expired: true }, {}]) {
    const f = await setup(t, { maxJobs: "1" }), r = await accepted(f), c = await finalizedCharge(f, r.id, options);
    await assert.rejects(() => f.observer.observe({ id: f.id, owner: f.owner }), /revoked|expired|exhausted/);
    assert.equal((await f.ledger.reconcile({ id: r.id, observationId: c.observationId })).state, "settled");
    assert.equal(f.ledger.status(f.id).remainingJobs, "0");
    const request = await f.request(1);
    await assert.rejects(() => f.ledger.reserve({ ...request, observationId: c.observationId }), /funding evidence/);
  }
});
test("failed database update rolls reconciliation back without losing the hold", async (t) => {
  const f = await setup(t), r = await accepted(f), c = await finalizedCharge(f, r.id);
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(f.dir, "funded-reservations.sqlite"));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_reconcile BEFORE INSERT ON sessions WHEN json_extract(NEW.data, '$.nonce')='1' BEGIN SELECT RAISE(ABORT, 'disk simulation'); END;");
  await assert.rejects(() => f.ledger.reconcile({ id: r.id, observationId: c.observationId }), /disk simulation/);
  assert.equal(f.reopen().status(f.id).held, "210"); assert.equal(f.ledger.status(f.id).available, "790");
  db.exec("DROP TRIGGER fail_reconcile");
  assert.equal((await f.ledger.reconcile({ id: r.id, observationId: c.observationId })).state, "settled");
});
test("a provider signature alone cannot authorize rejected or late work", async (t) => {
  const f = await setup(t), r = await f.request(); await f.ledger.reserve(r);
  const job = await f.ledger.markDispatched({ id: r.id, observationId: r.observationId, provider: addr("worker") });
  const worker = Signer.fromSeed("funded-probe-worker");
  const bad = await sign(fundedResultHash(f.target, job, "wrong"), worker);
  assert.throws(() => f.ledger.complete({ id: r.id, output: "wrong", signature: bad }), /Unaccepted/);
  const valid = await sign(fundedResultHash(f.target, job, "4"), worker);
  assert.throws(() => f.reopen({ accept: null }).complete({ id: r.id, output: "4", signature: valid }), /not configured/);
  f.time(job.deadline + 1);
  assert.throws(() => f.ledger.complete({ id: r.id, output: "4", signature: valid }), /expired/);
  assert.equal(f.ledger.status(f.id).held, "700");
});

}
