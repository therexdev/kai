"use strict";

const assert = require("node:assert/strict"), { test } = require("node:test");
const fs = require("fs"), os = require("os"), path = require("path"), { fork } = require("child_process");
const { Signer, Transaction } = require("koilib");
const { Meter, hash, authorizeHash, resultHash } = require("../lib/koin-network/metering");
const { ShadowJobs } = require("../lib/koin-network/job-ledger");
const { inspectFinality } = require("../lib/koin-network/finality");
const { ShadowSettlementMonitor } = require("../lib/koin-network/settlement-monitor");
const { DAY, MAX } = require("../lib/koin-network/policy");
const owner = Signer.fromSeed("koin-paid-probe-owner"), provider = Signer.fromSeed("koin-paid-probe-provider");
const ownerAddress = owner.getAddress(), providerAddress = provider.getAddress(), domain = "shadow:paid-probe";
const sid = hash("session"), jid = (i) => hash(`job-${i}`);
const sign = async (signer, bytes) => Buffer.from(await signer.signHash(bytes)).toString("base64");

// TEST ONLY. Byte tokens are deliberately NOT installed as a production model
// tokenizer. Exact fixture counts let the tests detect worker count forgery.
function fixtureMeter(overrides = {}) {
  const tariff = { model: "fixture", version: 1, modelHash: hash("fixture-model"),
    tokenizerHash: hash("fixture-byte-tokenizer"), templateHash: hash("fixture-template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "2000000",
    contextTokens: 1000, maxOutputTokens: 100, maxLatencyMs: 60000, ...overrides };
  return new Meter([{ tariff, adapter: { ...tariff,
    input: (m) => Buffer.byteLength(JSON.stringify(m)), output: (s) => Buffer.byteLength(s) } }]);
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koin-paid-probe-"));
  let now = DAY;
  const meter = fixtureMeter(), instances = [];
  const reopen = () => { const l = new ShadowJobs(dir, { domain, meter, clock: () => now }); instances.push(l); return l; };
  const ledger = reopen();
  t.after(() => { for (const l of instances) { try { l.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  ledger.importSimulationGrant({ id: sid, owner: ownerAddress, amount: "10000", perJob: "1000",
    policyHash: meter.policyHash, maxJobs: 10, expires: DAY + 3600000, ...options });
  const quote = ledger.quote("fixture", 1, [{ role: "user", content: "hello" }], 100);
  const request = async (i, q = quote) => ({ id: jid(i), session: sid, quoteHash: q.hash,
    signature: await sign(owner, authorizeHash(domain, sid, jid(i), q.hash)) });
  const start = async (i = 1, l = ledger) => {
    l.reserve(await request(i)); return l.dispatch(jid(i), providerAddress);
  };
  const result = async (j, output = "你好 🌍", signer = provider) => ({ output,
    signature: await sign(signer, resultHash(domain, j.id, j.attempt, j.quote.hash, output)) });
  const finish = async (i = 1) => { const j = await start(i); return ledger.complete(j.id, await result(j), { accepted: true }); };
  return { dir, meter, ledger, quote, request, start, result, finish, reopen, setTime: (t) => { now = t; } };
}

if (process.argv[2] === "--reserve-child") {
  const { dir, request, at, crash } = JSON.parse(process.argv[3]);
  const l = new ShadowJobs(dir, { domain, meter: fixtureMeter(), clock: () => at });
  try { l.reserve(request); if (crash) process.exit(0); process.send({ ok: true }); }
  catch (e) { process.send({ ok: false, message: e.message }); }
  finally { l.close(); process.disconnect(); }
} else {
  test("no defaults, pin mismatch, monetary overflow and uncalibrated model fail closed", () => {
    assert.throws(() => new Meter().quote(domain, "unknown", 1, [], 10, DAY), /No calibrated/);
    assert.throws(() => new ShadowJobs("unused", { domain: "mainnet", meter: fixtureMeter() }), /shadow/);
    assert.throws(() => fixtureMeter({ inputAtomsPerMillion: "0" }), /Unconfigured/);
    assert.throws(() => fixtureMeter({ outputAtomsPerMillion: "1.5" }), /unsigned/);
    const tariff = fixtureMeter().entry("fixture", 1).tariff;
    assert.throws(() => new Meter([{ tariff, adapter: { ...tariff, modelHash: hash("wrong model") } }]), /pin mismatch/);
    assert.throws(() => fixtureMeter({ outputAtomsPerMillion: MAX.toString(), contextTokens: 2000000,
      maxOutputTokens: 1500000 }).quote(domain, "fixture", 1,
      [{ role: "user", content: "a" }], 1500000, DAY), /uint64/);
    const m = fixtureMeter();
    assert.throws(() => m.quote(domain, "fixture", 1, [{ role: "tool", content: "x" }], 1, DAY), /literal/);
    assert.throws(() => m.quote(domain, "fixture", 1, [{ role: "user", content: "x".repeat(980) }], 100, DAY));
  });

  test("quotes are exact, request signatures bind intent, and retries reserve only once", async (t) => {
    const f = fixture(t), { ledger: l, quote: q } = f;
    assert.equal(q.maxCharge, String(q.inputTokens + 200));
    const r = await f.request(1);
    assert.throws(() => l.reserve({ ...r, id: jid(2) }), /Signature/);
    l.reserve(r); l.reserve(r);
    assert.equal(l.status(sid).held, q.maxCharge);
    const q2 = l.quote("fixture", 1, [{ role: "user", content: "other" }], 1);
    assert.throws(() => l.reserve({ ...r, quoteHash: q2.hash }), /Signature/);
    assert.throws(() => l.reserve({ ...r, signature: r.signature.replace(/.$/, "A") }), /signature/i);
    const changed = await f.request(1, q2);
    assert.throws(() => l.reserve(changed), /different intent/);
    assert.equal(l.status(sid).paymentsEnabled, false);
  });

  test("holds survive restart and two simultaneous database writers cannot overspend", async (t) => {
    const f = fixture(t, { amount: "300", perJob: "300" });
    const requests = await Promise.all([f.request(1), f.request(2)]);
    const run = (request) => new Promise((resolve, reject) => {
      const p = fork(__filename, ["--reserve-child", JSON.stringify({ dir: f.dir, request, at: DAY })],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let message, errors = "";
      p.stderr.on("data", (s) => { errors += s; });
      p.on("message", (v) => { message = v; }); p.on("error", reject);
      p.on("exit", (code) => code === 0 && message ? resolve(message) : reject(Error(errors)));
    });
    const results = await Promise.all(requests.map(run));
    assert.equal(results.filter((v) => v.ok).length, 1);
    assert.match(results.find((v) => !v.ok).message, /Spending limit/);
    assert.equal(f.reopen().status(sid).held, f.quote.maxCharge);
  });

  test("committed WAL reservations survive abrupt process exit without close", async (t) => {
    const f = fixture(t), request = await f.request(1);
    await new Promise((resolve, reject) => {
      const p = fork(__filename, ["--reserve-child", JSON.stringify({ dir: f.dir, request, at: DAY, crash: true })],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      p.on("error", reject); p.on("exit", (code) => code === 0 ? resolve() : reject(Error("child failed")));
    });
    assert.equal(f.reopen().status(sid).held, f.quote.maxCharge);
    assert.equal(f.ledger.reserve(request).state, "reserved");
  });

  test("unreadable ledger identity is refused rather than silently recreated", (t) => {
    const f = fixture(t);
    f.ledger.db.exec("DELETE FROM meta");
    assert.throws(() => f.reopen(), /Missing ledger identity/);
  });

  test("limits, cancellation, expiry, grant policy and domain separation are enforced", async (t) => {
    const f = fixture(t, { maxJobs: 1 });
    f.ledger.reserve(await f.request(1));
    const two = await f.request(2);
    assert.throws(() => f.ledger.reserve(two), /Spending limit/);
    f.ledger.cancel(jid(1)); f.ledger.reserve(two);
    assert.throws(() => f.ledger.dispatch(jid(2), ownerAddress), /Self-served/);
    f.setTime(DAY + 300000);
    assert.throws(() => f.ledger.dispatch(jid(2), providerAddress), /Expired/);
    assert.equal(f.ledger.recover().length, 0);
    assert.equal(f.ledger.status(sid).held, "0");
    assert.throws(() => new ShadowJobs(f.dir, { domain: "shadow:other", meter: f.meter }), /domain/);
    assert.throws(() => f.ledger.importSimulationGrant({ id: jid(3), policyHash: hash("wrong"), owner: ownerAddress,
      amount: "10", perJob: "10", maxJobs: 1, expires: DAY + 3600000 }), /policy/);
  });

  test("worker usage is ignored; the master counts multilingual output and stores only hashes", async (t) => {
    const f = fixture(t), j = await f.start(), r = await f.result(j);
    r.usage = { prompt_tokens: 900000000, completion_tokens: 900000000 };
    const done = f.ledger.complete(j.id, r, { accepted: true });
    assert.equal(done.receipt.usage.outputTokens, Buffer.byteLength(r.output));
    assert.equal(done.hold, String(f.quote.inputTokens + Buffer.byteLength(r.output) * 2));
    assert.equal(done.receipt.outputHash, hash(r.output));
    const stored = JSON.stringify(f.ledger.get("jobs", j.id));
    assert.ok(!stored.includes(r.output)); assert.ok(!stored.includes('"hello"'));
    assert.throws(() => f.ledger.complete(j.id, r, { accepted: true }), /awaiting/);
    assert.throws(() => f.ledger.cancel(j.id), /stays reserved/);
  });

  test("result signatures bind provider, dispatch, quote, domain and output", async (t) => {
    const f = fixture(t), j = await f.start(), r = await f.result(j);
    assert.throws(() => f.ledger.complete(j.id, { ...r, output: "tampered" }, { accepted: true }), /Signature/);
    assert.throws(() => f.ledger.complete(j.id, r, { accepted: false }), /Unaccepted/);
    const other = await f.result(j, r.output, owner);
    assert.throws(() => f.ledger.complete(j.id, other, { accepted: true }), /Signature/);
    for (const changed of [{ ...j, attempt: jid(99) }, { ...j, quote: { hash: jid(99) } }]) {
      const invalid = await f.result(changed);
      assert.throws(() => f.ledger.complete(j.id, invalid, { accepted: true }), /Signature/);
    }
    const wrongDomain = { output: r.output, signature: await sign(provider,
      resultHash("shadow:elsewhere", j.id, j.attempt, j.quote.hash, r.output)) };
    assert.throws(() => f.ledger.complete(j.id, wrongDomain, { accepted: true }), /Signature/);
    const tooLarge = await f.result(j, "a".repeat(101));
    assert.throws(() => f.ledger.complete(j.id, tooLarge, { accepted: true }), /integer/);
    const empty = await f.result(j, "");
    assert.throws(() => f.ledger.complete(j.id, empty, { accepted: true }), /output/);
    assert.equal(f.ledger.get("jobs", j.id).state, "dispatched");
  });

  test("cancelled and timed out dispatches cannot submit late results", async (t) => {
    const f = fixture(t), j = await f.start();
    f.ledger.cancel(j.id);
    assert.throws(() => f.ledger.complete(j.id, {}, { accepted: true }), /awaiting/);
    const two = await f.start(2), r = await f.result(two);
    f.setTime(two.deadline + 1);
    assert.throws(() => f.ledger.complete(two.id, r, { accepted: true }), /expired/);
    assert.equal(f.reopen().recover().length, 0);
    assert.equal(f.ledger.status(sid).held, "0");
  });

  test("revocation stops new dispatch but preserves earlier work and never extends deadline", async (t) => {
    const f = fixture(t), j = await f.start();
    const request = await f.request(2); f.ledger.reserve(request);
    f.setTime(DAY + 1000);
    const first = f.ledger.revoke(sid);
    assert.throws(() => f.ledger.dispatch(jid(2), providerAddress), /revoked/);
    f.setTime(DAY + 2000);
    assert.equal(f.ledger.revoke(sid).settleUntil, first.settleUntil);
    f.ledger.complete(j.id, await f.result(j), { accepted: true });
    assert.equal(f.ledger.prepare(j.id).charge.nonce, "1");
    f.ledger.recover();
    assert.equal(f.ledger.get("jobs", jid(2)).state, "cancelled");
  });

  test("outbox serializes session nonces and never releases an unknown broadcast on restart", async (t) => {
    const f = fixture(t), a = await f.finish(1), b = await f.finish(2);
    const intent = f.ledger.prepare(a.id);
    assert.equal(intent.charge.amount, a.receipt.usage.amount);
    assert.equal(intent.charge.receipt_hash, a.receiptHash);
    assert.throws(() => f.ledger.prepare(b.id), /uncertain/);
    const reopened = f.reopen();
    assert.deepEqual(reopened.prepare(a.id), intent);
    const txId = "0x1220" + hash("transaction");
    reopened.markSubmitted(a.id, txId); reopened.markSubmitted(a.id, txId);
    assert.throws(() => reopened.markSubmitted(a.id, "0x1220" + hash("different")), /uncertain/);
    assert.throws(() => reopened.cancel(a.id), /reserved/);
    f.setTime(4 * DAY);
    assert.equal(reopened.recover().length, 2, "unknown broadcast and verified work retain holds after expiry");
    assert.throws(() => reopened.confirmSimulation(a.id, hash("different intent")), /mismatch/);
    const committed = reopened.get("jobs", a.id);
    reopened.confirmSimulation(a.id, committed.intentHash);
    reopened.confirmSimulation(a.id, committed.intentHash);
    assert.equal(reopened.status(sid).spent, a.receipt.usage.amount);
    assert.equal(reopened.status(sid).held, b.receipt.usage.amount);
    assert.equal(reopened.status(sid).nonce, "1");
    assert.throws(() => reopened.prepare(b.id), /eligible/);
  });

  test("settlement releases only the unused hold and advances the next nonce once", async (t) => {
    const f = fixture(t), a = await f.finish(1), b = await f.finish(2);
    f.ledger.prepare(a.id);
    f.ledger.markSubmitted(a.id, "0x1220" + hash("tx-a"));
    f.ledger.confirmSimulation(a.id, f.ledger.get("jobs", a.id).intentHash);
    assert.equal(f.ledger.prepare(b.id).charge.nonce, "2");
    const s = f.ledger.status(sid);
    assert.equal(BigInt(s.spent) + BigInt(s.available) + BigInt(s.held), 10000n);
    assert.equal(f.reopen().prepare(b.id).charge.nonce, "2");
  });

  test("SQL rollback leaves grants and holds intact on a failed state write", async (t) => {
    const f = fixture(t), r = await f.request(1);
    f.ledger.db.exec("CREATE TRIGGER fail_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'disk simulation'); END;");
    assert.throws(() => f.ledger.reserve(r), /disk simulation/);
    assert.equal(f.ledger.status(sid).held, "0");
    f.ledger.db.exec("DROP TRIGGER fail_job");
    f.ledger.reserve(r);
    assert.equal(f.ledger.status(sid).held, f.quote.maxCharge);
  });

  async function chainFixture(op) {
    const chainId = Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.from(hash("chain"), "hex")]).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const expectedOperation = op || { contract_id: providerAddress, entry_point: 123, args: "AA==" };
    const tx = await Transaction.prepareTransaction({ header: { chain_id: chainId, payer: ownerAddress,
      nonce: "KAE=", rc_limit: "1000000" }, operations: [{ call_contract: expectedOperation }], signatures: [] });
    const blockId = "0x1220" + hash("block"), headId = "0x1220" + hash("head");
    const main = { block_id: blockId, block_height: "100", block: { id: blockId, header: { height: "100" }, transactions: [tx] },
      receipt: { id: blockId, height: "100", transaction_receipts: [{ id: tx.id, reverted: false }] } };
    const lookup = { transactions: [{ transaction: tx, containing_blocks: [blockId] }] };
    const head = { head_topology: { id: headId, height: "200" }, last_irreversible_block: "140" };
    const rpc = { getChainId: async () => chainId, getTransactionsById: async () => structuredClone(lookup),
      getHeadInfo: async () => head, getBlocksById: async () => ({ block_items: [{ block_id: blockId, block_height: "100" }] }),
      getBlocks: async (height, count, ref) => { assert.equal(height, 100); assert.equal(count, 1); assert.equal(ref, headId); return [main]; } };
    const intent = { chainId, txId: tx.id, expectedOperation };
    return { rpc, intent, main, lookup, head };
  }
  test("read-only finality requires the exact transaction on the irreversible chain", async () => {
    const f = await chainFixture();
    assert.equal((await inspectFinality(f.rpc, f.intent)).state, "finalized");
    delete f.main.receipt.transaction_receipts[0].reverted;
    assert.equal((await inspectFinality(f.rpc, f.intent)).state, "finalized", "protobuf omitted false is supported");
    f.main.receipt.transaction_receipts[0].reverted = true;
    assert.equal((await inspectFinality(f.rpc, f.intent)).state, "reverted");
    f.head.last_irreversible_block = "99";
    assert.equal((await inspectFinality(f.rpc, f.intent)).state, "reversible");
    f.head.last_irreversible_block = "140";
    f.main.block_id = "0x1220" + hash("other fork");
    assert.equal((await inspectFinality(f.rpc, f.intent)).state, "unknown");
    f.lookup.transactions[0].containing_blocks = [];
    assert.equal((await inspectFinality(f.rpc, f.intent)).state, "pending");
    f.lookup.transactions = [];
    assert.equal((await inspectFinality(f.rpc, f.intent)).state, "unknown");
  });
  test("wrong chain, changed transaction, missing receipt and RPC errors never confirm a charge", async () => {
    let f = await chainFixture();
    await assert.rejects(inspectFinality({ ...f.rpc, getChainId: async () => "wrong" }, f.intent), /chain/);
    await assert.rejects(inspectFinality(f.rpc, { ...f.intent, expectedOperation: { ...f.intent.expectedOperation, args: "AQ==" } }), /operation/);
    f.lookup.transactions[0].transaction.header.rc_limit = "2";
    await assert.rejects(inspectFinality(f.rpc, f.intent), /commitment/);
    f = await chainFixture(); f.main.receipt.transaction_receipts = [];
    await assert.rejects(inspectFinality(f.rpc, f.intent), /Missing finalized/);
    f = await chainFixture(); f.main.receipt.transaction_receipts[0].rpc_error = { message: "not available" };
    await assert.rejects(inspectFinality(f.rpc, f.intent), /receipt/);
    await assert.rejects(inspectFinality({ ...f.rpc, getHeadInfo: async () => { throw Error("offline"); } }, f.intent), /offline/);
  });

  test("monitor binds the generated settlement ABI and exact target, confirming only finalized intent", async (t) => {
    const f = fixture(t), j = await f.finish();
    f.ledger.prepare(j.id);
    const first = await chainFixture();
    const target = { chainId: first.intent.chainId, credits: providerAddress, creditsHash: "0x1220" + hash("credits bytecode") };
    const rpc = { invokeGetContractMetadata: async () => ({ value: { hash: target.creditsHash } }) };
    const monitor = new ShadowSettlementMonitor(f.ledger, rpc, target);
    const op = await monitor.operation(j.id);
    const decoded = await monitor.serializer.deserialize(op.args, "koin.Request");
    assert.equal(decoded.charge.amount, j.receipt.usage.amount);
    assert.equal(Buffer.from(decoded.charge.id, "base64").toString("hex"), j.id);
    assert.equal(decoded.charge.nonce, "1");
    assert.equal(op.entry_point, require("../lib/koin-network/credits-abi.json").methods.settle.entry_point);
    const chain = await chainFixture(op);
    Object.assign(rpc, chain.rpc);
    f.ledger.markSubmitted(j.id, chain.intent.txId);
    chain.head.last_irreversible_block = "99";
    assert.equal((await monitor.reconcile(j.id)).state, "reversible");
    assert.equal(f.ledger.status(sid).spent, "0");
    chain.head.last_irreversible_block = "140";
    rpc.invokeGetContractMetadata = async () => ({ value: { hash: "0x1220" + hash("changed") } });
    await assert.rejects(monitor.reconcile(j.id), /bytecode/);
    rpc.invokeGetContractMetadata = async () => ({ value: { hash: target.creditsHash } });
    assert.equal((await monitor.reconcile(j.id)).state, "finalized");
    assert.equal(f.ledger.status(sid).spent, j.receipt.usage.amount);
    assert.equal((await monitor.reconcile(j.id)).paymentsEnabled, false);
    const reopened = f.reopen();
    assert.equal(reopened.get("jobs", j.id).finality.height, "100");
    assert.throws(() => new ShadowSettlementMonitor(reopened, rpc, { ...target, credits: ownerAddress }), /target changed/);
    assert.equal((await new ShadowSettlementMonitor(reopened, rpc, target).reconcile(j.id)).state, "settled");
  });
}
