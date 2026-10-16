"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { recover, attemptStore, simulation, record, savedPair, TX, SINCE, UNTIL } = require("../deploy/koin-mainnet/recover-reviewed-finalization");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-reviewed-retry-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const transaction = { id: TX, header: { nonce: "KA8=", rc_limit: "100000000" }, signatures: ["ORIGINAL_SAVED_SIGNATURE"], operations: [{ call_contract: { args: "ORIGINAL_ROOT" } }] };
  const sent = [], logs = [], calls = [], store = attemptStore(path.join(directory, "attempt"));
  const options = { approval: TX, now: () => SINCE + 60000, store,
    load: async () => { calls.push("load"); return structuredClone(transaction); },
    observe: async () => { calls.push("observe"); return [{ state: "unknown" }, { state: "unknown" }]; },
    preflight: async () => { calls.push("preflight"); }, beforeSend: () => { calls.push("beforeSend"); },
    submit: async tx => {
      assert.equal(store.exists(), true, "durable intent precedes every send");
      const intent = JSON.parse(fs.readFileSync(path.join(directory, "attempt/attempt.json"), "utf8"));
      assert.equal(intent.envelopeHash, crypto.createHash("sha256").update(JSON.stringify(tx)).digest("hex"));
      assert.equal(intent.maxAdditionalAttempts, 1); sent.push(structuredClone(tx)); calls.push("submit");
    },
    waitReady: async tx => { assert.deepEqual(tx, transaction); calls.push("waitReady"); }, log: line => logs.push(line) };
  return { directory, transaction, sent, calls, logs, store, options };
}
test("one approved retry preserves exact bytes and records intent before submitting; rerun only monitors", async t => {
  const f = fixture(t); await recover(f.options); await recover(f.options);
  assert.deepEqual(f.sent, [f.transaction]); assert.equal(f.calls.filter(c => c === "preflight").length, 1);
  assert.equal(f.calls.filter(c => c === "waitReady").length, 2); assert.equal(f.logs.some(l => l.includes("ORIGINAL_SAVED_SIGNATURE")), false);
  const file = path.join(f.directory, "attempt/attempt.json"); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});
test("lost submission response and timed-out confirmation preserve the fence across repeat execution", async t => {
  const f = fixture(t), submit = f.options.submit;
  f.options.submit = async tx => { await submit(tx); throw Error("response lost"); };
  f.options.waitReady = async () => { throw Error("still pending"); };
  await assert.rejects(recover(f.options), /still pending/);
  await assert.rejects(recover(f.options), /still pending/);
  assert.equal(f.sent.length, 1); assert.equal(f.store.exists(), true);
  assert(!f.logs.some(l => l.startsWith("REWARDS RECOVERED")));
});
test("an interrupted partial intent file prevents any additional submission", async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.directory, "attempt/attempt.json"), "{", { mode: 0o600 });
  await recover(f.options); assert.equal(f.sent.length, 0); assert.equal(f.calls.includes("preflight"), false);
});
test("concurrent invocations can commit only one extra submission", async t => {
  const f = fixture(t); await Promise.all([recover(f.options), recover(f.options)]); assert.equal(f.sent.length, 1);
});
for (const state of ["pending", "reversible", "finalized"]) test(state + " transaction is monitored without another send", async t => {
  const f = fixture(t); f.options.observe = async () => [{ state }, { state: "unknown" }];
  await recover(f.options); assert.equal(f.sent.length, 0); assert.equal(f.store.exists(), false);
});
test("revert, invalid finality, approval mismatch, and expired review prevent submission", async t => {
  for (const [key, value] of [
    ["observe", async () => [{ state: "reverted" }, { state: "unknown" }]],
    ["observe", async () => [{ state: "unknown" }]],
    ["observe", async () => [{ state: "accepted" }, { state: "unknown" }]],
    ["approval", "different-transaction"], ["now", () => UNTIL], ["now", () => SINCE - 1],
  ]) {
    const f = fixture(t); f.options[key] = value;
    await assert.rejects(recover(f.options)); assert.equal(f.sent.length, 0); assert.equal(f.store.exists(), false);
  }
});
test("preflight rejection, changed stored bytes, and changed journal fence stop before intent", async t => {
  for (const failure of ["preflight", "bytes", "beforeSend"]) {
    const f = fixture(t);
    if (failure === "bytes") { let n = 0; f.options.load = async () => ({ ...f.transaction, id: ++n === 1 ? TX : "changed" }); }
    else f.options[failure] = () => { throw Error("changed evidence"); };
    await assert.rejects(recover(f.options)); assert.equal(f.sent.length, 0); assert.equal(f.store.exists(), false);
  }
});
test("late network inclusion skips submission after the dry run", async t => {
  const f = fixture(t); let n = 0;
  f.options.observe = async () => [{ state: ++n === 1 ? "unknown" : "pending" }, { state: "unknown" }];
  await recover(f.options); assert.equal(f.sent.length, 0); assert.equal(f.store.exists(), false);
});
test("an expired review with an existing intent still permits read-only recovery", async t => {
  const f = fixture(t); f.store.claim(f.transaction, SINCE + 1); f.options.now = () => UNTIL + 1;
  await recover(f.options); assert.equal(f.sent.length, 0); assert.equal(f.calls.includes("waitReady"), true);
});
test("dry-run receipt must match transaction, payer, success and the unchanged resource ceiling", () => {
  const good = { id: TX, payer: "17f9wpFZgJLkYgZuS3KZCMjuKPLf4nhxjU", rc_used: "52027608" };
  simulation(good);
  for (const bad of [null, {}, { ...good, id: "other" }, { ...good, payer: "other" }, { ...good, reverted: true },
    { ...good, reverted: "false" }, { ...good, rc_used: "0" }, { ...good, rc_used: "100000001" }, { ...good, rc_used: "NaN" }])
    assert.throws(() => simulation(bad), /reviewed Mana/);
});
test("journal rows require an intact digest and matching state/id columns", () => {
  const data = JSON.stringify({ id: "record", state: "signed" });
  const row = { id: "record", state: "signed", data, hash: crypto.createHash("sha256").update(data).digest("hex") };
  assert.deepEqual(record(row), { id: "record", state: "signed" });
  for (const bad of [null, { ...row, hash: "wrong" }, { ...row, data: data + " " }, { ...row, id: "wrong" }, { ...row, state: "finalized" },
    { ...row, owner: "wrong" }, { ...row, tx_id: "wrong" }])
    assert.throws(() => record(bad), /journal/);
});
test("private retry storage rejects permissive directories and symlink locations", t => {
  const f = fixture(t), publicDir = path.join(f.directory, "public"), link = path.join(f.directory, "link");
  fs.mkdirSync(publicDir); fs.chmodSync(publicDir, 0o755); assert.throws(() => attemptStore(publicDir), /Private/);
  fs.symlinkSync(path.join(f.directory, "attempt"), link); assert.throws(() => attemptStore(link), /Private/);
});
test("signing and canonical cycle JSON order may differ, but every signed field and each stored hash must match", () => {
  const tx = { header: { nonce: "KA8=" }, operations: [], signatures: ["saved"], id: TX };
  const cycleTx = { id: TX, header: tx.header, operations: tx.operations, signatures: tx.signatures };
  assert.notEqual(JSON.stringify(tx), JSON.stringify(cycleTx));
  const r = { owner: "17f9wpFZgJLkYgZuS3KZCMjuKPLf4nhxjU", transaction: tx };
  const step = { epoch: "20739", method: "finalize_root", outbox: { transaction: cycleTx,
    hash: crypto.createHash("sha256").update(JSON.stringify(cycleTx)).digest("hex") } };
  savedPair(r, step);
  assert.throws(() => savedPair(r, { ...step, outbox: { ...step.outbox, hash: "changed" } }), /saved lifecycle/);
  assert.throws(() => savedPair({ ...r, transaction: { ...tx, signatures: ["different"] } }, step), /saved lifecycle/);
});
