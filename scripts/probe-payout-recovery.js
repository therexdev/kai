"use strict";

// Offline regression tests: no production key, RPC, or transfers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { settlePayouts, budgetedCall, complete, boundedRpc } = require("../lib/payouts");
const { Scheduler, startAutoOps } = require("../lib/scheduler");
const { Provider, Signer } = require("koilib");
const { KaiContract } = require("../lib/chain");
const { openStore } = require("../lib/durable-store");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const packet = { amount: "100000000", index: 0, proof: [] };
const summary = (epoch = 100) => ({ epoch, root: "ab".repeat(32), receipts: 2, persisted: true, claims: { alice: packet, bob: packet } });

function fixture(s = summary()) {
  let clock = 1000000;
  const paid = new Set(); const calls = []; const checkpoints = [];
  const kai = { getRoot: async () => s.root, isClaimed: async (_e, w) => paid.has(w) };
  return {
    kai, summary: s, now: () => clock, sleep: async (ms) => { clock += ms; }, paid, calls, checkpoints,
    checkpoint: async (out) => { s.settlement = structuredClone(out); checkpoints.push(structuredClone(out)); },
    send: async (_kai, method, args, prepared) => {
      calls.push({ method, args });
      await prepared({ tx: `tx-${args.worker || 'root'}`, rcLimit: "123" });
      if (args.worker) paid.add(args.worker);
    },
  };
}

test("partial failures recover and already-paid claims are never broadcast again", async () => {
  const f = fixture(); f.paid.add("alice");
  f.summary.settlement = { rootTx: "old-root", claims: { alice: { tx: "paid" }, bob: { error: "insufficient pending account resources" } } };
  assert.equal(complete(f.summary), false);
  const out = await settlePayouts(f);
  assert.equal(out.status, "complete"); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args.worker, "bob"); assert.equal(out.claims.alice.tx, "paid");
  assert.ok(f.checkpoints.some((x) => x.claims.bob?.status === "submitted"));
  assert.equal(complete(f.summary), true);
  await settlePayouts(f); assert.equal(f.calls.length, 1);
});

test("resource exhaustion stops the burst, persists partial progress, and schedules backoff", async () => {
  const f = fixture();
  f.send = async (_k, _m, a) => { f.calls.push(a); throw new Error('insufficient pending account resources'); };
  const out = await settlePayouts(f);
  assert.equal(out.status, "pending"); assert.equal(f.calls.length, 1);
  assert.equal(out.claims.alice.status, "failed");
  assert.ok(Date.parse(out.nextRetryAt) > f.now()); assert.equal(out.claims.bob, undefined);
});

test("unknown submission stays pending across restart and reconciles before retry", async () => {
  const f = fixture();
  f.send = async (_k, _m, a, prepared) => { f.calls.push(a); await prepared({ tx: 'uncertain' }); throw new Error('network timeout'); };
  let out = await settlePayouts(f);
  assert.equal(out.claims.alice.status, 'submitted');
  // A restarted process only has durable state, and the tx was actually mined.
  f.paid.add('alice'); f.paid.add('bob');
  out = await settlePayouts(f);
  assert.equal(out.status, 'complete'); assert.equal(f.calls.length, 1);
});

test("unconfirmed transactions are never marked paid or immediately re-signed", async () => {
  const f = fixture();
  f.summary.claims = { alice: packet };
  f.send = async (_k, _m, a, prepared) => { f.calls.push(a); await prepared({ tx: 'not-yet-mined' }); };
  let out = await settlePayouts(f);
  assert.equal(out.status, 'pending'); assert.equal(out.claims.alice.status, 'submitted');
  await settlePayouts(f); assert.equal(f.calls.length, 1);
  await f.sleep(11 * 60000);
  f.send = async (_k, _m, a, prepared) => { f.calls.push(a); await prepared({ tx: 'replacement' }); f.paid.add(a.worker); };
  out = await settlePayouts(f); assert.equal(out.status, 'complete'); assert.equal(f.calls.length, 2);
});

test("root conflicts are blocked, while new roots must confirm before claims", async () => {
  const f = fixture(); f.kai.getRoot = async () => 'cd'.repeat(32);
  let out = await settlePayouts(f); assert.equal(out.status, 'blocked'); assert.equal(f.calls.length, 0);
  const g = fixture(); g.kai.getRoot = async () => null;
  g.send = async (_k, method, _a, prepared) => { g.calls.push(method); await prepared({ tx: 'root-tx' }); };
  out = await settlePayouts(g);
  assert.equal(out.status, 'pending'); assert.deepEqual(g.calls, ['submit_root']);
});

test("durability failure prevents broadcast; old count-based packets still work", async () => {
  const f = fixture(); f.checkpoint = async () => { throw new Error('disk full'); };
  await assert.rejects(settlePayouts(f), /disk full/); assert.equal(f.calls.length, 0);
  const g = fixture(); g.summary.claims = { alice: { count: '2', index: 0, proof: [] } };
  const out = await settlePayouts(g); assert.equal(out.status, 'complete');
  assert.equal(g.calls[0].method, 'claim'); assert.equal(g.calls[0].args.count, '2');
});

test("bounded passes preserve unprocessed claims for later recovery", async () => {
  const f = fixture(); f.summary.claims = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`w${i}`, packet]));
  let out = await settlePayouts(f); assert.equal(f.calls.length, 12); assert.equal(out.status, 'pending');
  out = await settlePayouts(f); assert.equal(f.calls.length, 20); assert.equal(out.status, 'complete');
});

function budgetFixture({ rcUsed = '2000000', available = '10000000000', reverted = false } = {}) {
  const provider = new Provider('https://offline.invalid');
  const signer = Signer.fromSeed('offline-payout-regression-key'); signer.provider = provider;
  provider.getAccountRc = async () => available;
  provider.getNextNonce = async () => 'KAE=';
  provider.getChainId = async () => 'EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==';
  const submissions = [];
  provider.call = async (method, params) => {
    assert.equal(method, 'chain.submit_transaction');
    submissions.push(structuredClone(params));
    return { receipt: { id: params.transaction.id, rc_used: rcUsed, reverted } };
  };
  const chain = { provider, signer, address: signer.getAddress() };
  const kai = new KaiContract({ chain, contractId: chain.address, abiPath: path.join(__dirname, '../lib/kai-abi.json') });
  return { kai, submissions };
}

test("real koilib encoding simulates, shrinks RC with margin, re-signs, then broadcasts", async () => {
  const f = budgetFixture(); let checkpointed;
  await budgetedCall(f.kai, 'submit_root', { epoch: '100', root: Buffer.alloc(32).toString('base64url') }, async (tx) => {
    assert.equal(f.submissions.length, 1); checkpointed = tx;
  });
  assert.equal(f.submissions.length, 2);
  assert.equal(f.submissions[0].broadcast, false); assert.equal(f.submissions[1].broadcast, true);
  assert.equal(f.submissions[0].transaction.header.rc_limit, '600000000');
  assert.equal(f.submissions[1].transaction.header.rc_limit, '2510000');
  assert.notEqual(f.submissions[0].transaction.id, f.submissions[1].transaction.id);
  assert.notDeepEqual(f.submissions[0].transaction.signatures, f.submissions[1].transaction.signatures);
  assert.equal(checkpointed.tx, f.submissions[1].transaction.id);
});

test("invalid estimates, reverts, inadequate MANA, and failed checkpoint never broadcast", async () => {
  for (const opts of [{ rcUsed: '0' }, { rcUsed: '' }, { reverted: true }, { rcUsed: '590000000' }, { available: '0' }]) {
    const f = budgetFixture(opts);
    await assert.rejects(budgetedCall(f.kai, 'submit_root', { epoch: '1', root: '' }, async () => {}));
    assert.ok(f.submissions.every((x) => !x.broadcast));
  }
  const f = budgetFixture();
  await assert.rejects(budgetedCall(f.kai, 'submit_root', { epoch: '1', root: '' }, async () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(f.submissions.length, 1);
});

test("RPC errors and malformed responses cannot become false claim confirmations", async () => {
  const original = global.fetch;
  try {
    const rpc = boundedRpc('https://offline.invalid');
    for (const value of [{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 2, error: { message: 'RPC failed' } }, { jsonrpc: '2.0', id: 99, result: {} }]) {
      global.fetch = async () => new Response(JSON.stringify(value));
      await assert.rejects(rpc('chain.read_contract', {}));
    }
  } finally { global.fetch = original; }
});

for (const mode of ['json', 'sqlite']) {
  test(`${mode}: cursor reaches failed epochs beyond newest 200 and preserves rewards`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-page-'));
    const s = new Scheduler({ dataDir: dir, storeMode: mode });
    try {
      for (let epoch = 1; epoch <= 305; epoch++) {
        const item = summary(epoch);
        item.settlement = { rootTx: 'root', claims: { alice: { tx: 'a' }, bob: { tx: 'b' } } };
        if (epoch === 1 || epoch === 302) item.settlement.claims.bob = { error: 'insufficient pending account resources' };
        s.store.saveEpoch(epoch, { epoch, summary: item, receipts: [{ retained: true }] });
      }
      const seen = [];
      s.settlement = { settleEpoch: async (item, save) => {
        seen.push(item.epoch);
        const out = { status: 'complete', rootTx: 'root', claims: { alice: { status: 'confirmed' }, bob: { status: 'confirmed' } } };
        await save(out); return out;
      } };
      for (let i = 0; i < 8; i++) await s.recoverPendingSettlements();
      assert.deepEqual(seen, [302, 1]);
      assert.deepEqual(s.store.readEpoch(1).receipts, [{ retained: true }]);
      assert.equal(s.store.readEpoch(1).summary.claims.bob.amount, packet.amount);
    } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("timers run for the website-mounted scheduler; retries serialize and coalesce", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-timer-'));
  const s = new Scheduler({ dataDir: dir });
  let release; let calls = 0; let concurrent = 0; let maxConcurrent = 0;
  const barrier = new Promise((r) => { release = r; });
  s.settlement = { settleEpoch: async () => { calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await barrier; concurrent--; return { status: 'complete', rootTx: 'r', claims: {} }; } };
  for (const epoch of [10, 11]) s.store.saveEpoch(epoch, { epoch, summary: summary(epoch) });
  const a = s.settleClosedEpoch(summary(10)); const b = s.settleClosedEpoch(summary(10)); const c = s.settleClosedEpoch(summary(11));
  assert.equal(a, b);
  await new Promise((r) => setImmediate(r)); assert.equal(calls, 1);
  release(); await Promise.all([a, b, c]); assert.equal(calls, 2); assert.equal(maxConcurrent, 1);
  const timers = startAutoOps(s, { seedMs: 100000, epochMs: 100000 });
  assert.equal(s.payoutStatus().automaticRecovery, true);
  clearInterval(timers.seed); clearInterval(timers.close);
  await s.close(); fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  for (const { name, run } of tests) { await run(); console.log(`PASS ${name}`); }
  console.log(`All ${tests.length} payout recovery checks passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
