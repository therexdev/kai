"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { fixture } = require("./helpers/koin-cycle-fixture"), { DAY } = require("../lib/koin-network/policy");
const P = require("../lib/koin-network/job-protocol");
const { readPending, validateSaved, endpointProbe } = require("../deploy/koin-mainnet/diagnose-reward-opening");
async function setup(t) {
  const f = await fixture(t, { minRetryMs: 10000 });
  const tick = () => f.runner().tick({ openCurrentDay: false });
  const confirm = async () => {
    await f.include(f.sent.at(-1));
    for (let i = 0; i < 3; i++) if ((await f.cycle.advance("1")).action === "step_complete") return;
    throw Error("Fixture could not confirm lifecycle step");
  };
  await tick(); await confirm();
  f.cycle.importManifest(f.envelope); f.advance(DAY);
  await tick(); await confirm(); f.advance(DAY);
  await tick(); await f.include(f.sent.at(-1));
  // Chain is finalized; the saved lifecycle step is still intentionally unknown.
  assert.equal(f.cycle.status("1").steps[2].state, "unknown");
  const config = { mode: f.options.mode, version: "1", maxRcPerTransaction: f.policy.maxRcPerTransaction,
    maxRcPerDay: f.policy.maxRcPerDay, roles: { lifecycle: f.policy.payer },
    deployment: { ...f.target, rpc: ["https://primary.invalid/rpc?key=private", "https://backup.invalid"] } };
  const file = path.join(f.dir, "reward-cycle.sqlite"), raw = readPending(file), saved = await validateSaved(raw, config);
  const logs = [], calls = [], log = text => logs.push(JSON.parse(text));
  function createClient(_deployment, endpoint) {
    const provider = Object.fromEntries(Object.entries(f.rpc).map(([method, fn]) => [method, (...args) => { calls.push(method); return fn(...args); }]));
    provider.withSignal = (_signal, run) => run();
    provider.getNonce = async () => { calls.push("getNonce"); return 3; };
    provider.getAccountRc = async () => { calls.push("getAccountRc"); return "100000"; };
    provider.call = async () => { throw Error("No raw RPC or broadcast allowed in this probe"); };
    if (endpoint.includes("primary")) provider.getTransactionsById = async () => { calls.push("empty-primary-lookup"); return { transactions: [] }; };
    return { provider, verify: async () => ({ paused: false }), read: async (_kind, method, args) => {
      calls.push(method);
      if (method === "get_epoch") return f.epochs.has(args.epoch) ? { epoch: structuredClone(f.epochs.get(args.epoch)) } : {};
      if (method === "balances") return structuredClone(f.balances);
      throw Error("Unexpected read");
    } };
  }
  return { f, config, file, raw, saved, logs, calls, log, createClient };
}
test("per-endpoint diagnostics distinguish an empty primary lookup from exact irreversible backup proof without journal writes", async t => {
  const x = await setup(t), before = [x.file, x.file + "-wal"].map(file => fs.readFileSync(file));
  const originalStep = x.f.cycle.status("1"), signed = x.f.signed.length, sent = x.f.sent.length;
  for (const endpoint of x.config.deployment.rpc) await endpointProbe({ endpoint, config: x.config, saved: x.saved,
    createClient: x.createClient, clock: x.f.clock, samples: 1, log: x.log });
  const proof = x.logs.filter(row => row.phase === "exact_transaction_finality");
  assert.deepEqual(proof.map(row => row.finality.state), ["unknown", "finalized"]);
  assert.equal(proof[1].txId, x.saved.transaction.id);
  assert.ok(proof[1].finality.height);
  const facts = x.logs.filter(row => row.phase === "epoch_and_nonce");
  assert.ok(facts.every(row => row.oldEpoch.finalized && row.oldEpoch.rootMatchesSaved && row.nonceConsumedOrPassed && !row.nonceIsNext));
  assert.ok(facts.every(row => row.today.epoch === "3" && !row.today.found));
  assert.equal(x.f.signed.length, signed); assert.equal(x.f.sent.length, sent);
  assert.deepEqual(x.f.cycle.status("1"), originalStep);
  for (const [i, file] of [x.file, x.file + "-wal"].entries()) assert.deepEqual(fs.readFileSync(file), before[i]);
  const output = JSON.stringify(x.logs);
  assert.doesNotMatch(output, /private|signatures|operations|transaction.*header|\?key/);
  for (const signature of x.saved.transaction.signatures) assert.ok(!output.includes(signature));
});
test("saved diagnostics require exact row, manifest, operation, signature, nonce and configured identity bindings", async t => {
  const x = await setup(t);
  const rewrite = (raw, fn) => { const row = JSON.parse(raw.row.data); fn(row); raw.row.data = JSON.stringify(row); raw.row.hash = P.hash(raw.row.data); };
  for (const mutate of [
    raw => { raw.row.hash = "0".repeat(64); },
    raw => { raw.row.tx_id = "0x1220" + "0".repeat(64); },
    raw => { raw.day.hash = "0".repeat(64); },
    raw => rewrite(raw, row => { row.outbox.nonce = "999"; }),
    raw => rewrite(raw, row => { row.outbox.transaction.operations[0].call_contract.args = ""; row.outbox.hash = P.hash(JSON.stringify(row.outbox.transaction)); }),
    raw => rewrite(raw, row => { row.outbox.transaction.signatures[0] = "invalid"; row.outbox.hash = P.hash(JSON.stringify(row.outbox.transaction)); }),
  ]) {
    const raw = structuredClone(x.raw); mutate(raw);
    await assert.rejects(validateSaved(raw, x.config));
  }
  await assert.rejects(validateSaved(x.raw, { ...x.config, roles: { lifecycle: x.f.target.verifier } }), /configured deployment or policy/);
  assert.deepEqual(readPending(x.file), x.raw);
});
test("upstream error payloads and endpoint query credentials never enter diagnostic output", async t => {
  const x = await setup(t), secret = "sensitive-saved-signature-and-key";
  const createClient = (...args) => {
    const client = x.createClient(...args);
    client.provider.getTransactionsById = async () => { throw Object.assign(Error(secret), { rpcDiagnostics: [{
      endpoint: x.config.deployment.rpc[0], kind: "network", method: "transaction_store.get_transactions_by_id",
      networkCodes: ["ETIMEDOUT", secret], body: secret, signatures: [secret], headers: { authorization: secret },
    }] }); };
    return client;
  };
  await endpointProbe({ endpoint: x.config.deployment.rpc[0], config: x.config, saved: x.saved, createClient, clock: x.f.clock, log: x.log });
  const [result] = x.logs;
  assert.equal(result.ok, false); assert.equal(result.phase, "exact_transaction_finality");
  assert.deepEqual(result.rpc[0].networkCodes, ["ETIMEDOUT"]);
  assert.equal(result.rpc[0].endpoint, "https://primary.invalid");
  assert.doesNotMatch(JSON.stringify(x.logs), /private|sensitive|signature|authorization|\?key/);
});
test("the endpoint deadline cancels a stalled read without retrying or submitting", async t => {
  const x = await setup(t); let active, attempts = 0, cancelled = false;
  const createClient = (...args) => {
    const client = x.createClient(...args);
    client.provider.withSignal = async (signal, run) => { const before = active; active = signal; try { return await run(); } finally { active = before; } };
    client.provider.getTransactionsById = () => new Promise((resolve, reject) => {
      attempts++;
      const abort = () => { cancelled = true; reject(Error("private stalled request")); };
      if (active.aborted) abort(); else active.addEventListener("abort", abort, { once: true });
    });
    return client;
  };
  await endpointProbe({ endpoint: x.config.deployment.rpc[0], config: x.config, saved: x.saved, createClient,
    clock: x.f.clock, timeoutMs: 50, log: x.log });
  assert.equal(cancelled, true); assert.equal(attempts, 1);
  assert.equal(x.logs[0].failure, "probe_deadline");
  assert.equal(x.f.cycle.status("1").steps[2].state, "unknown");
  assert.doesNotMatch(JSON.stringify(x.logs), /private/);
});
