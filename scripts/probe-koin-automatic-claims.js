"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process"), { DatabaseSync } = require("node:sqlite");
const { Signer, Transaction, Serializer, utils } = require("koilib");
const { fixture, sponsor, verifier, addr } = require("./helpers/koin-claims-fixture");
const { fixture: settlementFixture } = require("./helpers/koin-outbox-fixture");
const { RewardClaims } = require("../lib/koin-network/reward-claims"), { RewardObserver } = require("../lib/koin-network/reward-observer");
const { RehearsalSubmitter } = require("../lib/koin-network/rehearsal-submitter");
const M = require("../lib/koin-network/reward-manifest"), P = require("../lib/koin-network/job-protocol");
const { DAY } = require("../lib/koin-network/policy"), ABI = require("../lib/koin-network/rewards-abi.json");
const dbPath = f => path.join(f.dir, "reward-claims.sqlite");
const tick = async f => (await f.runner().tick()).results[0];
const confirm = async f => { const first = await tick(f); return ["done", "review"].includes(first.action) ? first : tick(f); };
if (process.argv[2] === "--crash") {
  (async () => {
    const f = await fixture({ after() {} });
    const decision = await f.ledger.advance(f.ids[0]);
    if (process.argv[3] !== "signing") await f.ledger.stage(f.ids[0], await f.prepare(decision));
    if (process.argv[3] === "attempt") await f.ledger.advance(f.ids[0]);
    fs.writeSync(1, JSON.stringify({ dir: f.dir, id: f.ids[0] })); process.kill(process.pid, "SIGKILL");
  })().catch(e => { fs.writeSync(2, e.stack); process.exit(1); });
} else {

test("automatic claims need only sponsor signatures and keep the proof's exact recipient", async t => {
  const f = await fixture(t), result = await tick(f);
  assert.equal(result.action, "await_finality"); assert.equal(result.state, "unknown"); assert.equal(result.paymentsEnabled, false);
  assert.equal(result.transaction, undefined); assert.equal(f.sent.length, 1); assert.equal(f.signed.length, 1);
  const tx = f.sent[0], args = await new Serializer(ABI.types).deserialize(tx.operations[0].call_contract.args, "koin.Request");
  assert.equal(utils.encodeBase58(utils.decodeBase64url(args.account)), f.ledger.status(f.ids[0]).account);
  assert.equal(args.availability, "10"); assert.equal(args.work, "8");
  assert.deepEqual(await Signer.recoverAddresses(tx), [sponsor.getAddress()]);
  f.finalized(tx); assert.equal((await confirm(f)).state, "paid");
  assert.equal(f.ledger.status(f.ids[0]).attempts, 1); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.ledger.importManifest(f.envelope), f.ids);
  f.reopen(); assert.equal(f.ledger.status(f.ids[0]).state, "paid"); assert.equal(f.ledger.next(), f.ids[1]);
});

test("omitted empty protobuf reads mean unclaimed; malformed responses and missing identity cannot authorize signing", async t => {
  const f = await fixture(t), read = f.rpc.readContract;
  f.rpc.readContract = async op => op.entry_point === ABI.methods.claimed.entry_point ? {} : read(op);
  assert.equal((await tick(f)).action, "await_finality"); assert.equal(f.signed.length, 1);
  for (const invalid of [null, [], { result: null }, { result: 42 }, { rpc_error: "unavailable" }]) {
    const g = await fixture(t), prior = g.rpc.readContract;
    g.rpc.readContract = async op => op.entry_point === ABI.methods.claimed.entry_point ? invalid : prior(op);
    await assert.rejects(tick(g), /Invalid reward contract read/); assert.equal(g.signed.length, 0);
  }
  const g = await fixture(t); g.rpc.readContract = async () => ({});
  await assert.rejects(tick(g), /policy mismatch/); assert.equal(g.signed.length, 0);
});

test("signed manifests reject altered allocations, evidence, domain, signer, ordering and duplicate days", async t => {
  const f = await fixture(t);
  for (const change of [
    m => { m.allocations[0].work = "9"; }, m => { m.allocations.reverse(); },
    m => { m.allocations[1] = m.allocations[0]; }, m => { m.root.hash = P.hash("bad-root"); },
    m => { m.evidenceHash = P.hash("other-data"); }, m => { m.target.rewards = addr("wrong"); },
    m => { m.target.chainId = "EiA"; }, m => { m.mode = "live"; },
    m => { m.rawPrompt = "must never appear in a manifest"; }, m => { m.allocations[0].availability = "01"; },
  ]) {
    const envelope = structuredClone(f.envelope); change(envelope.manifest); assert.throws(() => f.ledger.importManifest(envelope));
  }
  const wrong = structuredClone(f.envelope); wrong.signature = Buffer.from(await sponsor.signHash(M.signingHash(wrong.manifest))).toString("base64");
  assert.throws(() => f.ledger.importManifest(wrong), /Signature mismatch/);
  const replaced = structuredClone(f.envelope); replaced.manifest.evidenceHash = P.hash("reissued");
  replaced.signature = Buffer.from(await verifier.signHash(M.signingHash(replaced.manifest))).toString("base64");
  assert.throws(() => f.ledger.importManifest(replaced), /Cannot replace/);
  assert.equal(f.ledger.status(f.ids[0]).state, "queued");
});

test("zero-valued reward categories and epoch zero use the contract's canonical protobuf bytes", async t => {
  const f = await fixture(t), Tree = require("../lib/koin-network/merkle"), ser = new Serializer(ABI.types);
  const allocations = f.envelope.manifest.allocations.map((r, i) => ({ ...r, availability: i ? "0" : "10", work: i ? "8" : "0" }));
  const tree = Tree.build({ chainId: f.target.chainId, contract: f.target.rewards, epoch: "0", version: "1" }, allocations);
  const manifest = { ...f.envelope.manifest, epoch: "0", allocations, root: tree.root };
  const ids = f.ledger.importManifest({ manifest, signature: Buffer.from(await verifier.signHash(M.signingHash(manifest))).toString("base64") });
  for (const id of ids) {
    const op = await f.ledger.operation(id), type = ser.root.lookupType("koin.Request");
    const args = type.decode(utils.decodeBase64url(op.args));
    assert.equal(Object.hasOwn(args, "epoch"), false);
    assert.equal(Object.hasOwn(args, "availability") && Object.hasOwn(args, "work"), false);
    for (const node of args.proof) assert.equal(Object.hasOwn(node, "availability") && Object.hasOwn(node, "work"), false);
    assert.equal(utils.encodeBase64url(type.encode(args).finish()), op.args);
  }
});

test("the review hold, irreversible root, custody, bytecode, native token and per-provider paid cap gate signing", async t => {
  for (const kind of ["review", "reversible", "custody", "code", "native", "cap", "root", "hold", "policy"]) {
    const f = await fixture(t);
    if (kind === "review") f.epoch.finalized = false;
    if (kind === "reversible") f.head.last_irreversible_block = "99";
    if (kind === "custody") f.balances.liquid = "1";
    if (kind === "code") f.metadata[f.target.rewards].value.hash = "0x1220" + P.hash("upgrade");
    if (kind === "native") f.rpc.invokeGetContractAddress = async () => ({ value: { address: addr("wrong-token") } });
    if (kind === "root") f.epoch.root.hash = utils.encodeBase64url(Buffer.from(P.hash("other-root"), "hex"));
    if (kind === "hold") f.epoch.review_until = String(f.clock() + 1);
    if (kind === "policy") f.config.config.verifier = utils.encodeBase64url(utils.decodeBase58(sponsor.getAddress()));
    if (kind === "cap") {
      const read = f.rpc.readContract;
      f.rpc.readContract = async op => {
        const ser = new Serializer(ABI.types), args = await ser.deserialize(op.args, "koin.Request");
        if (op.contract_id === f.target.credits && args.account) return { result: utils.encodeBase64url(await ser.serialize({ amount: "1" }, "koin.Result")) };
        return read(op);
      };
    }
    if (["review", "reversible"].includes(kind)) assert.equal((await tick(f)).action, "wait");
    else await assert.rejects(tick(f));
    assert.equal(f.signed.length, 0, kind); assert.equal(f.sent.length, 0, kind); assert.equal(f.ledger.status(f.ids[0]).state, "queued");
  }
});

test("lost acknowledgments and restart retry byte-for-byte without another signature", async t => {
  const f = await fixture(t);
  const first = (await f.runner({ submit: async tx => { await f.submit(tx); throw Error("lost ack"); } }).tick()).results[0];
  assert.equal(first.submission, "unknown"); assert.equal(f.ledger.status(f.ids[0]).attempts, 1);
  f.reopen(); assert.equal((await tick(f)).reason, "retry_delay"); assert.equal(f.sent.length, 1);
  f.advance(1001); const retry = await tick(f); assert.equal(retry.attempts, 2);
  assert.deepEqual(f.sent[1], f.sent[0]); assert.equal(f.signed.length, 1);
});

test("submission timeout is uncertain, sanitized, durable and cannot mark a payment final", async t => {
  const f = await fixture(t);
  const state = (await f.runner({ timeoutMs: 50, submit: async () => new Promise(() => {}) }).tick()).results[0];
  assert.equal(state.submission, "unknown"); assert.equal(state.state, "unknown"); assert.equal(f.ledger.status(f.ids[0]).attempts, 1);
  const g = await fixture(t);
  const lie = (await g.runner({ submit: async tx => ({ txId: tx.id, paid: true, finalized: true, receipt: { reverted: false } }) }).tick()).results[0];
  assert.equal(lie.state, "unknown"); assert.equal(g.ledger.status(g.ids[0]).state, "unknown");
});

test("pending and reversible inclusion cannot pay; missing final claimed state fails closed", async t => {
  const f = await fixture(t); await tick(f); const tx = f.sent[0];
  f.lookups.set(tx.id, { transaction: tx, containing_blocks: [] });
  assert.equal((await tick(f)).state, "pending"); assert.equal(f.sent.length, 1);
  const b = f.finalized(tx); f.head.last_irreversible_block = String(Number(b.block_height) - 1);
  assert.equal((await tick(f)).action, "wait");
  assert.equal((await tick(f)).action, "wait"); assert.notEqual(f.ledger.status(f.ids[0]).state, "paid");
  f.head.last_irreversible_block = b.block_height; assert.equal((await tick(f)).state, "paid");
  const g = await fixture(t); await tick(g); g.finalized(g.sent[0], { recordClaim: false });
  await assert.rejects(tick(g), /missing its irreversible claimed state/); assert.equal(g.ledger.status(g.ids[0]).state, "unknown");
});

test("manual claims skip unsigned work, but fence an already issued sponsor nonce until finality", async t => {
  const f = await fixture(t); f.pay(f.ledger.status(f.ids[0]).account);
  assert.equal((await tick(f)).state, "paid_elsewhere"); assert.equal(f.sent.length, 0); assert.equal(f.signed.length, 0);
  const g = await fixture(t); await tick(g); g.pay(g.ledger.status(g.ids[0]).account); g.advance(1001);
  const state = await confirm(g); assert.equal(state.state, "needs_review"); assert.equal(state.reason, "claimed_with_unresolved_sponsor_nonce");
  assert.equal(g.sent.length, 1); g.reopen(); assert.equal((await tick(g)).action, "review");
  g.finalized(g.sent[0], { reverted: true }); assert.equal((await tick(g)).state, "paid_elsewhere");
  assert.equal(g.ledger.next(), g.ids[1]);
});

test("daily Mana budgets survive restart and same-day retries count one envelope", async t => {
  const f = await fixture(t); await tick(f); f.advance(1001); await tick(f);
  f.finalized(f.sent[0]); assert.equal((await confirm(f)).state, "paid");
  assert.equal((await tick(f)).reason, "sponsorship_budget"); assert.equal(f.ledger.status(f.ids[1]).attempts, 0);
  f.reopen(); assert.equal((await tick(f)).reason, "sponsorship_budget");
  f.advance(DAY); const state = await tick(f); assert.equal(state.attempts, 1); assert.equal(f.sent.length, 3);
  assert.equal(f.signed.length, 2); assert.notEqual(f.sent[2].id, f.sent[0].id);
  f.finalized(f.sent[2]); assert.equal((await confirm(f)).state, "paid");
  assert.equal(f.ledger.next(), null); assert.equal(f.epoch.paid, "36"); assert.equal(f.balances.liabilities, "0");
});

test("finalized reverts and retry exhaustion remain under review, but later true finality still resolves", async t => {
  for (const kind of ["revert", "limit"]) {
    const f = await fixture(t, { maxAttempts: 1 }); await tick(f); const tx = f.sent[0];
    if (kind === "revert") f.finalized(tx, { reverted: true }); else f.advance(1001);
    assert.equal((await tick(f)).action, "review"); f.reopen();
    assert.equal((await tick(f)).action, "review"); assert.equal(f.sent.length, 1); assert.equal(f.signed.length, 1);
    assert.equal(f.ledger.status(f.ids[1]).state, "queued");
    if (kind === "limit") { f.finalized(tx); assert.equal((await confirm(f)).state, "paid"); }
  }
});

test("concurrent ledger handles elect one signer and block other claims behind the sponsor nonce", async t => {
  const f = await fixture(t), other = new RewardClaims(f.dir, { target: f.target, policy: f.policy, observer: f.observer, clock: f.clock });
  t.after(() => other.close());
  const decisions = await Promise.all([f.ledger.advance(f.ids[0]), other.advance(f.ids[0])]);
  assert.equal(decisions.filter(d => d.action === "prepare_claim").length, 1);
  assert.equal((await other.advance(f.ids[1])).reason, "sponsor_nonce_busy");
  await f.ledger.stage(f.ids[0], await f.prepare(decisions.find(d => d.action === "prepare_claim")));
  const attempts = await Promise.all([f.ledger.advance(f.ids[0]), other.advance(f.ids[0])]);
  assert.equal(attempts.filter(d => d.action === "submit_exact_transaction").length, 1);
  assert.equal(other.status(f.ids[0]).attempts, 1);
});

test("uncertain signing is durably fenced and recovers only the returned exact envelope", async t => {
  const f = await fixture(t); let envelope;
  await assert.rejects(f.runner({ prepareClaim: async d => { envelope = await f.prepare(d); throw Error("lost signing result"); } }).tick(), /lost signing result/);
  f.reopen(); assert.equal((await tick(f)).reason, "recover_signing_envelope"); assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 0);
  await f.ledger.stage(f.ids[0], envelope); await tick(f); assert.deepEqual(f.sent[0], envelope);
  const replacement = await f.prepare({ chainId: f.target.chainId, payer: sponsor.getAddress(), maxRc: "10000", operation: await f.ledger.operation(f.ids[0]) });
  await assert.rejects(f.ledger.stage(f.ids[0], replacement), /Cannot replace/);
});

test("a hung signer times out behind its durable fence; a backwards clock cannot restore a Mana budget", async t => {
  const f = await fixture(t);
  await assert.rejects(f.runner({ timeoutMs: 50, prepareClaim: async () => new Promise(() => {}) }).tick(), /recover its envelope/);
  f.reopen(); assert.equal((await tick(f)).reason, "recover_signing_envelope"); assert.equal(f.sent.length, 0);
  const g = await fixture(t); await tick(g); g.advance(-1);
  await assert.rejects(tick(g), /clock moved backwards/); assert.equal(g.sent.length, 1);
});

test("the restricted preparation gate rejects recipient changes, extra calls, wrong signers, pins and Mana", async t => {
  const f = await fixture(t), decision = await f.ledger.advance(f.ids[0]), good = await f.prepare(decision);
  for (const change of [
    x => { x.operations[0].call_contract.contract_id = f.target.credits; },
    x => { x.operations[0].call_contract.args = "AA=="; }, x => { x.operations.push(x.operations[0]); },
    x => { x.header.payer = f.ledger.status(f.ids[0]).account; }, x => { x.header.payee = verifier.getAddress(); },
    x => { x.header.rc_limit = "10001"; }, x => { x.header.chain_id = "wrong"; }, x => { x.signatures = []; },
    x => { x.signatures.push(x.signatures[0]); }, x => { x.header.nonce = "KA=="; },
  ]) { const tx = structuredClone(good); change(tx); await assert.rejects(f.ledger.stage(f.ids[0], tx)); }
  const wrong = structuredClone(good); wrong.signatures = []; await verifier.signTransaction(wrong);
  await assert.rejects(f.ledger.stage(f.ids[0], wrong), /Wrong settlement signers/);
  assert.equal(f.ledger.status(f.ids[0]).state, "signing"); assert.equal(f.sent.length, 0);
  await f.ledger.stage(f.ids[0], good); assert.equal(f.ledger.status(f.ids[0]).state, "staged");
});

test("deployment and budget pins cannot change after restart; damaged bytes and missing journal fail closed", async t => {
  const f = await fixture(t);
  assert.throws(() => new RewardClaims(f.dir, { target: f.target, policy: { ...f.policy, maxRcPerDay: "99999" }, observer: f.observer }), /policy changed/);
  for (const kind of ["bytes", "rc", "journal", "identity"]) {
    const g = await fixture(t); await tick(g); g.advance(1001);
    const db = new DatabaseSync(dbPath(g));
    try {
      if (kind === "journal") db.prepare("DELETE FROM mana").run();
      else if (kind === "identity") db.prepare("DELETE FROM identity").run();
      else {
        const r = JSON.parse(db.prepare("SELECT data FROM claims WHERE id=?").get(g.ids[0]).data);
        if (kind === "bytes") r.outbox.transaction.signatures = []; else r.outbox.rcLimit = "1";
        db.prepare("UPDATE claims SET data=? WHERE id=?").run(JSON.stringify(r), g.ids[0]);
      }
    } finally { db.close(); }
    await assert.rejects(tick(g)); assert.equal(g.sent.length, 1);
  }
});

test("an abandoned fork retries only the original claim; changed recipient proofs never replace it", async t => {
  const f = await fixture(t); await tick(f); const tx = f.sent[0], b = f.advance(1001), forkId = "0x1220" + P.hash("reward-fork");
  f.lookups.set(tx.id, { transaction: tx, containing_blocks: [forkId] });
  f.rpc.getBlocksById = async () => ({ block_items: [{ block_id: forkId, block_height: b.block_height }] });
  assert.equal((await tick(f)).attempts, 2); assert.deepEqual(f.sent[0], f.sent[1]);
});

test("SIGKILL preserves the signing fence, staged bytes and pre-submission attempt checkpoint", () => {
  for (const point of ["signing", "staged", "attempt"]) {
    let info;
    try { execFileSync(process.execPath, [__filename, "--crash", point], { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }); assert.fail("Expected process death"); }
    catch (e) { assert.equal(e.signal, "SIGKILL", String(e.stderr)); info = JSON.parse(e.stdout); }
    try {
      const db = new DatabaseSync(path.join(info.dir, "reward-claims.sqlite"));
      try {
        assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
        const r = JSON.parse(db.prepare("SELECT data FROM claims WHERE id=?").get(info.id).data);
        assert.equal(r.state, point === "attempt" ? "unknown" : point);
        if (point !== "signing") {
          assert.equal(r.outbox.hash, P.hash(JSON.stringify(r.outbox.transaction))); assert.equal(r.outbox.transaction.signatures.length, 1);
          assert.equal(r.outbox.attempts, point === "attempt" ? 1 : 0);
        }
      } finally { db.close(); }
    } finally { fs.rmSync(info.dir, { recursive: true, force: true }); }
  }
});

test("the same restricted driver submits only durably staged settlements and recovers lost responses", async t => {
  const f = await settlementFixture(t), id = await f.accepted("submit-service"), tx = await f.stage(id), sent = [];
  const runner = () => new RehearsalSubmitter({ mode: "isolated-rehearsal", settlements: f.ledger, observeSettlement: f.observe,
    submit: async transaction => {
      assert.equal(f.ledger.settlementStatus(id).attempts, sent.length + 1);
      sent.push(structuredClone(transaction)); throw Error("lost response");
    } });
  const result = (await runner().tick({ settlementIds: [id] })).results[0]; assert.equal(result.submission, "unknown");
  await f.restart(); f.advance(1001); await runner().tick({ settlementIds: [id] }); assert.deepEqual(sent[1], sent[0]);
  f.finalized(id, tx); assert.equal((await runner().tick({ settlementIds: [id] })).results[0].state, "settled");
  assert.equal(sent.length, 2);
  assert.throws(() => new RehearsalSubmitter({ mode: "live", settlements: f.ledger, observeSettlement: f.observe, submit() {} }), /isolated rehearsal/);
  const g = await fixture(t, { payer: f.settlementPolicy.payer, verifier: f.settlementPolicy.payer });
  assert.throws(() => new RehearsalSubmitter({ mode: "isolated-rehearsal", settlements: f.ledger, observeSettlement: f.observe,
    claims: g.ledger, prepareClaim: g.prepare, submit() {} }), /separate sponsor/);
});

}
