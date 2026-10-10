"use strict";
const { test: run } = require("node:test"), assert = require("node:assert/strict"), path = require("path");
const { DatabaseSync } = require("node:sqlite"), { Transaction, utils } = require("koilib");
const { fixture: setup, payer, verifier, addr } = require("./helpers/koin-cycle-fixture");
const { RewardCycle } = require("../lib/koin-network/reward-cycle"), { RewardCycleRunner } = require("../lib/koin-network/reward-cycle-runner");
const M = require("../lib/koin-network/reward-manifest"), P = require("../lib/koin-network/job-protocol"), { DAY } = require("../lib/koin-network/policy");
const test = (name, fn) => { for (const mainnet of [false, true]) run((mainnet ? "mainnet: " : "rehearsal: ") + name, t => fn(t, mainnet)); };
const fixture = (t, overrides = {}) => setup(t, overrides, t.name.startsWith("mainnet: "));
const tick = async (f, extra = {}) => (await f.runner(extra).tick({ openCurrentDay: false })).results[0];
async function decision(f) {
  let d;
  for (let i = 0; i < 3; i++) { d = await f.cycle.advance("1"); if (d.reason !== "cycle_changed") return d; }
  return d;
}
async function confirm(f, tx = f.sent.at(-1), options) {
  await f.include(tx, options); return decision(f);
}
async function opened(f) {
  assert.equal((await tick(f)).action, "await_finality");
  assert.equal((await confirm(f)).action, "step_complete");
}
async function proposed(f) {
  await opened(f); f.cycle.importManifest(f.envelope); f.advance(DAY);
  assert.equal((await tick(f)).action, "await_finality");
  assert.equal((await confirm(f)).action, "step_complete");
}

test("daily cycle opens, seals a signed root, observes the full review and durably hands off automatic claims", async t => {
  const f = await fixture(t), claims = f.claims();
  await opened(f);
  assert.equal((await decision(f)).reason, "await_signed_manifest");
  f.cycle.importManifest(f.envelope);
  assert.equal((await tick(f)).reason, "reward_day_open"); assert.equal(f.signed.length, 1);
  f.advance(DAY); assert.equal((await tick(f)).action, "await_finality");
  const proposal = f.sent.at(-1);
  assert.equal(proposal.signatures.length, 2); assert.equal(proposal.header.payer, payer.getAddress()); assert.equal(proposal.header.payee, undefined);
  assert.equal((await confirm(f)).action, "step_complete");
  assert.equal((await tick(f)).reason, "root_under_review"); assert.equal(f.signed.length, 2);
  assert.throws(() => f.cycle.readyManifest("1"), /irreversibly finalized/);
  f.advance(DAY); assert.equal((await tick(f)).action, "await_finality");
  assert.equal((await confirm(f)).action, "step_complete");
  // Simulate a crash after completing the cycle but before importing the claims.
  f.reopen(); assert.deepEqual(f.cycle.readyDays(), ["1"]);
  // And a crash after import but before recording the handoff.
  const ids = claims.importManifest(f.cycle.readyManifest("1"));
  const handed = await f.runner({ claims }).tick({ openCurrentDay: false });
  assert.deepEqual(handed.handedOff, [{ epoch: "1", claims: 2 }]); assert.deepEqual(f.cycle.readyDays(), []);
  assert.equal(claims.next(), ids[0]); assert.equal(f.signed.length, 3); assert.equal(f.sent.length, 3);
  assert.deepEqual((await f.runner({ claims }).tick({ openCurrentDay: false })).handedOff, []);
});

test("a lost inclusion response and restart recover the original lifecycle transaction without another signature", async t => {
  const f = await fixture(t);
  const first = await tick(f, { submit: async tx => { await f.submit(tx); await f.include(tx); throw Error("lost after inclusion"); } });
  assert.equal(first.submission, "unknown"); f.reopen();
  assert.equal((await decision(f)).action, "step_complete");
  assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 1);
  assert.equal((await tick(f)).reason, "await_signed_manifest");
});
test("an empty reward day releases its budget after review without creating payout claims", async t => {
  const f = await fixture(t), claims = f.claims(); await opened(f);
  const tree = M.build(f.target, "1", []), manifest = { ...f.envelope.manifest, root: tree.root, allocations: [] };
  const envelope = { manifest, signature: Buffer.from(await verifier.signHash(M.signingHash(manifest))).toString("base64") };
  f.cycle.importManifest(envelope); f.advance(DAY);
  assert.equal((await tick(f)).action, "await_finality"); await confirm(f);
  assert.equal((await tick(f)).reason, "root_under_review"); f.advance(DAY);
  assert.equal((await tick(f)).action, "await_finality"); await confirm(f);
  const result = await f.runner({ claims }).tick({ openCurrentDay: false });
  assert.deepEqual(result.handedOff, [{ epoch: "1", claims: 0 }]); assert.equal(claims.next(), null);
  assert.equal(f.balances.liabilities, "0"); assert.deepEqual(f.cycle.days(), []);
  assert.throws(() => M.canonical({ ...manifest, root: { ...tree.root, work: "1" } }), /root or sums/);
});
test("a missed unsigned day cannot block finalizing an already proposed reward root", async t => {
  const f = await fixture(t); await proposed(f);
  f.cycle.queueDay("2"); f.advance(DAY);
  assert.equal((await f.cycle.advance("2")).reason, "missed_reward_day");
  assert.equal(f.cycle.days().includes("2"), false);
  assert.equal((await tick(f)).action, "await_finality"); await confirm(f);
  assert.equal(f.cycle.status("1").complete, true);
});

test("a missing signing response survives restart and concurrent handles elect only one signer", async t => {
  const f = await fixture(t), second = f.open();
  const outcomes = await Promise.all([f.cycle.advance("1"), second.advance("1")]);
  assert.equal(outcomes.filter(x => x.action === "prepare_cycle").length, 1);
  f.reopen(); assert.equal((await tick(f)).reason, "recover_signing_envelope"); assert.equal(f.signed.length, 0);
  const d = outcomes.find(x => x.action === "prepare_cycle"), tx = await f.prepare(d);
  await f.cycle.stage("1", d.method, tx);
  assert.equal((await tick(f)).action, "await_finality"); assert.equal(f.signed.length, 1);
  const g = await fixture(t);
  await assert.rejects(tick(g, { timeoutMs: 50, prepare: () => new Promise(() => {}) }), /response lost/);
  g.reopen(); assert.equal((await tick(g)).reason, "recover_signing_envelope");
});

test("exact retries preserve bytes, count Mana once per day and never replace exhausted or reverted envelopes", async t => {
  const f = await fixture(t, { maxAttempts: 2 });
  await tick(f); f.reopen(); assert.equal((await tick(f)).reason, "retry_delay");
  f.advance(1000); await tick(f); assert.deepEqual(f.sent[1], f.sent[0]); assert.equal(f.signed.length, 1);
  const db = new DatabaseSync(path.join(f.dir, "reward-cycle.sqlite"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mana").get().n, 1); db.close();
  f.advance(1000); assert.equal((await tick(f)).reason, "attempt_limit");
  assert.equal((await confirm(f)).action, "step_complete", "later proven success can resolve an exhausted envelope");
  const g = await fixture(t); await tick(g);
  assert.equal((await confirm(g, g.sent[0], { reverted: true })).reason, "finalized_revert");
  g.reopen(); assert.equal((await tick(g)).action, "review"); assert.equal(g.signed.length, 1);
});

test("reversible state, forks and acknowledgments cannot advance a cycle or hand off rewards", async t => {
  const f = await fixture(t); await tick(f);
  const block = await f.include(f.sent[0], { irreversible: false });
  assert.equal((await decision(f)).action, "wait"); assert.equal(f.cycle.status("1").steps[0].state, "unknown");
  f.head.last_irreversible_block = block.block_height;
  assert.equal((await decision(f)).action, "step_complete");
  const g = await fixture(t); g.head.last_irreversible_block = "99";
  assert.equal((await tick(g)).reason, "cycle_reversible"); g.head.last_irreversible_block = "100";
  g.blocks.get(100).block_id = "0x1220" + P.hash("fork");
  assert.equal((await tick(g)).reason, "cycle_forked"); assert.equal(g.signed.length, 0);
});

test("past and future day boundaries cannot silently open another day's budget", async t => {
  const f = await fixture(t); f.advance(DAY);
  assert.equal((await tick(f)).reason, "missed_reward_day"); assert.equal(f.signed.length, 0);
  const g = await fixture(t); g.cycle.queueDay("2");
  assert.equal((await g.cycle.advance("2")).reason, "future_reward_day");
  await tick(g); const original = g.sent[0]; g.advance(DAY); g.reopen();
  assert.equal((await tick(g)).reason, "missed_reward_day"); assert.equal(g.sent.length, 1);
  assert.equal(g.cycle.status("1").steps[0].txId, original.id, "day rollover retains the unresolved nonce");
});

test("pauses, changed roots, cancellations, policy changes and unbacked allocations prevent signatures", async t => {
  const f = await fixture(t); f.config.paused = true;
  assert.equal((await tick(f)).reason, "paused"); assert.equal(f.signed.length, 0);
  const g = await fixture(t); await proposed(g); g.epochs.get("1").root.hash = utils.encodeBase64url(Buffer.from(P.hash("other-root"), "hex"));
  assert.equal((await decision(g)).reason, "root_changed"); assert.equal(g.signed.length, 2);
  const h = await fixture(t); await proposed(h); delete h.epochs.get("1").root; h.epochs.get("1").review_until = "0";
  assert.equal((await decision(h)).reason, "root_cancelled"); assert.equal(h.signed.length, 2);
  const k = await fixture(t); k.config.config.daily_bps = 600;
  await assert.rejects(tick(k), /budget policy changed/); assert.equal(k.signed.length, 0);
  const p = await fixture(t); await opened(p); p.cycle.importManifest(p.envelope); p.advance(DAY);
  p.epochs.get("1").availability_budget = "1"; p.epochs.get("1").work_budget = "49";
  await assert.rejects(decision(p), /exceeds funded reward caps/); assert.equal(p.signed.length, 1);
});

test("lifecycle manifests, deployment identity and canonical operations cannot be replaced", async t => {
  const f = await fixture(t); f.cycle.importManifest(f.envelope);
  const other = structuredClone(f.envelope); other.manifest.evidenceHash = P.hash("changed-evidence");
  other.signature = Buffer.from(await verifier.signHash(M.signingHash(other.manifest))).toString("base64");
  assert.throws(() => f.cycle.importManifest(other), /Cannot replace/);
  const d = await f.cycle.advance("1"), good = await f.prepare(d);
  for (const mutate of [
    tx => { tx.operations.push(tx.operations[0]); },
    tx => { tx.operations[0].call_contract.args = ""; },
    tx => { tx.operations[0].call_contract.contract_id = f.target.credits; },
    tx => { tx.header.payee = f.target.verifier; },
    tx => { tx.header.rc_limit = "10001"; },
  ]) {
    const tx = structuredClone(good); mutate(tx); tx.signatures = [];
    const prepared = await Transaction.prepareTransaction(tx); await payer.signTransaction(prepared);
    await assert.rejects(f.cycle.stage("1", "open_epoch", prepared));
  }
  await f.cycle.stage("1", "open_epoch", good);
  const wrong = await f.prepare(d); await assert.rejects(f.cycle.stage("1", "open_epoch", wrong), /Cannot replace/);
  assert.throws(() => f.open({ budgetPolicy: { dailyBps: 600, availabilityBps: 7000 } }), /policy changed/);
  assert.throws(() => new RewardCycle(f.dir, { ...f.options, mode: "production" }), /Isolated/);
});

test("root proposal requires exactly both verifier and lifecycle payer signatures without a verifier nonce", async t => {
  const f = await fixture(t); await opened(f); f.cycle.importManifest(f.envelope); f.advance(DAY);
  const d = await decision(f), tx = await f.prepare(d);
  assert.equal(d.method, "propose_root"); assert.equal(tx.header.payee, undefined);
  await assert.rejects(f.cycle.stage("1", d.method, { ...tx, signatures: tx.signatures.slice(0, 1) }), /signatures/);
  await assert.rejects(f.cycle.stage("1", d.method, { ...tx, signatures: [tx.signatures[0], tx.signatures[0]] }), /signer/);
  await f.cycle.stage("1", d.method, tx); assert.equal((await tick(f)).action, "await_finality");
});

test("daily sponsorship ceilings hold across days and multiple queued budgets", async t => {
  const f = await fixture(t, { maxRcPerDay: "10000" }); await opened(f);
  f.cycle.importManifest(f.envelope); f.advance(DAY); await tick(f); await confirm(f);
  f.cycle.queueDay("2");
  const d = await f.cycle.advance("2"); assert.equal(d.action, "prepare_cycle");
  await f.cycle.stage("2", d.method, await f.prepare(d));
  assert.equal((await f.cycle.advance("2")).reason, "sponsorship_budget");
  f.reopen(); assert.equal((await f.cycle.advance("2")).reason, "sponsorship_budget");
  const g = await fixture(t); await opened(g); g.cycle.importManifest(g.envelope); g.advance(DAY); await tick(g);
  g.advance(DAY); await tick(g); assert.deepEqual(g.sent[2], g.sent[1]);
  const db = new DatabaseSync(path.join(g.dir, "reward-cycle.sqlite"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mana").get().n, 3); db.close();
});

test("damaged journals, backwards time and unbounded day admission fail closed", async t => {
  const f = await fixture(t); await tick(f); f.advance(-1); await assert.rejects(tick(f), /backwards/);
  const g = await fixture(t); await tick(g);
  const db = new DatabaseSync(path.join(g.dir, "reward-cycle.sqlite")); db.exec("DELETE FROM mana"); db.close();
  await assert.rejects(tick(g), /Mana journal/);
  const h = await fixture(t); for (let i = 2; i <= 32; i++) h.cycle.queueDay(String(i));
  assert.throws(() => h.cycle.queueDay("33"), /queue full/);
  assert.throws(() => new RewardCycleRunner({ mode: "production", cycle: h.cycle, prepare: h.prepare, submit: h.submit }), /isolated/);
});

run("mainnet reward certificates cannot reuse a rehearsal signature tag", async t => {
  const f = await setup(t, {}, true);
  const oldHash = Buffer.from(P.hash(JSON.stringify(["KAI-KOIN-REWARD-MANIFEST-REHEARSAL-V1", M.canonical(f.envelope.manifest)])), "hex");
  const signature = Buffer.from(await verifier.signHash(oldHash)).toString("base64");
  assert.throws(() => M.verify({ ...f.envelope, signature }, f.target), /signature/i);
  assert.equal(M.verify(f.envelope, f.target).claims.length, 2);
});
