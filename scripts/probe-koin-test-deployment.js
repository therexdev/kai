"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { Signer } = require("koilib"), P = require("../lib/koin-network/job-protocol");
const { TestAccounts } = require("../lib/koin-network/test-accounts"), { TestSigning } = require("../lib/koin-network/test-signing");
const { KoinChain } = require("../lib/koin-network/chain"), { FOUNDATION_CHAIN, FOUNDATION_TOKEN } = require("../lib/koin-network/payment-mode");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-test-signing-"));
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); for (const s of ["", "-wal", "-shm"]) fs.rmSync(directory + ".recovery-anchor.sqlite" + s, { force: true }); });
  const owner = Signer.fromSeed("public-test-signing-fixture-owner"), sponsor = Signer.fromSeed("public-test-signing-fixture-sponsor");
  const d = { schema: 1, network: "foundation-testnet", chainId: FOUNDATION_CHAIN, token: FOUNDATION_TOKEN, decimals: 8, rpc: ["https://fixture.invalid"] };
  for (const key of ["credits", "rewards", "admin", "verifier", "mining", "operations"]) d[key] = Signer.fromSeed("fixture:" + key).getAddress();
  for (const key of ["creditsHash", "rewardsHash", "tokenHash"]) d[key] = "0x1220" + P.hash(key);
  const client = new KoinChain(d, { getChainId: async () => FOUNDATION_CHAIN, getNextNonce: async () => "KAE=" }); client.verify = async () => ({});
  const signers = { [owner.getAddress()]: owner, [sponsor.getAddress()]: sponsor }, journal = new TestSigning(directory, { client, signers });
  t.after(() => { try { journal.close(); } catch {} });
  const request = { owner: owner.getAddress(), payer: sponsor.getAddress(), signers: Object.keys(signers), maxRc: "10000000",
    operation: { contract_id: d.credits, entry_point: 1, args: "" } };
  return { directory, client, signers, journal, request, owner };
}
test("Test backend signatures are fenced before signing and replay the exact saved envelope", async t => {
  const f = fixture(t); let signed = 0; const original = f.owner.signTransaction.bind(f.owner);
  f.owner.signTransaction = tx => { signed++; assert.equal(f.journal.status()[0].state, "signing"); return original(tx); };
  const id = P.hash("request"), first = await f.journal.prepare(id, f.request);
  assert.equal(first.signatures.length, 2); assert.equal(signed, 1);
  assert.deepEqual(await f.journal.prepare(id, f.request), first); assert.equal(signed, 1);
  await assert.rejects(f.journal.prepare(P.hash("second"), f.request), /Unresolved/);
  await assert.rejects(f.journal.prepare(id, { ...f.request, maxRc: "20000000" }), /replace/);
  f.journal.close(); const reopened = new TestSigning(f.directory, { client: f.client, signers: f.signers });
  try { assert.deepEqual(await reopened.prepare(id, f.request), first); assert.equal(signed, 1); } finally { reopened.close(); }
});
test("lost backend signing response stays blocked across restart without signing twice", async t => {
  const f = fixture(t); let calls = 0; f.owner.signTransaction = () => { calls++; throw Error("signer unavailable"); };
  const id = P.hash("lost"); await assert.rejects(f.journal.prepare(id, f.request), /unavailable/);
  f.journal.close(); const reopened = new TestSigning(f.directory, { client: f.client, signers: f.signers });
  try { await assert.rejects(reopened.prepare(id, f.request), /recover/); assert.equal(calls, 1); } finally { reopened.close(); }
});
test("Test invites expire and revoke without accepting live credentials or storing raw tokens", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-test-invites-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "invitations.json"), token = "test_" + "a".repeat(43); let now = 1000;
  const row = { accountId: "test_owner", grantId: "test_grant", owner: Signer.fromSeed("test-invite-fixture").getAddress(), tokenHash: P.hash(token), expiresAt: 2000, enabled: true };
  fs.writeFileSync(file, JSON.stringify([row])); const accounts = new TestAccounts(file, () => now);
  assert.equal(accounts.sessionAccount(token).id, row.accountId); assert.equal(accounts.spendableGrant(row.accountId, row.grantId).address, row.owner);
  assert.equal(accounts.sessionAccount("sk_live"), null); assert.equal(fs.readFileSync(file, "utf8").includes(token), false);
  now = 2000; assert.equal(accounts.sessionAccount(token), null); assert.throws(() => accounts.spendableGrant(row.accountId, row.grantId), /expired/);
  now = 1000; fs.writeFileSync(file, JSON.stringify([{ ...row, enabled: false }])); assert.equal(accounts.sessionAccount(token), null);
  assert.throws(() => accounts.chargeGrant(), /disabled/);
});
test("one Test wallet cannot acquire signing leases on two hosts, including after restart", t => {
  const { TestHosts } = require("../lib/koin-network/test-hosts"), f = fixture(t), dir = path.join(f.directory, "hosts");
  const first = new TestHosts(dir, FOUNDATION_CHAIN), owner = f.owner.getAddress(), device = P.hash("one-host");
  assert.equal(first.claim(owner, device).granted, true);
  assert.throws(() => first.claim(owner, P.hash("second-host")), /another installation/); first.close();
  const second = new TestHosts(dir, FOUNDATION_CHAIN);
  try { assert.equal(second.claim(owner, device).granted, true); assert.throws(() => second.claim(owner, P.hash("another-os")), /another installation/); }
  finally { second.close(); }
});
for (const mainnet of [false, true]) test((mainnet ? "mainnet" : "testnet") + " contract deployment saves exact signatures before a lost submission and cannot replace its reviewed plan", async t => {
  const { TestDeployer } = require("../lib/koin-network/test-deployer"), f = fixture(t), sent = [], provider = f.client.provider;
  const { MAINNET_CHAIN, MAINNET_TOKEN } = require("../lib/koin-network/payment-mode");
  provider.getChainId = async () => mainnet ? MAINNET_CHAIN : FOUNDATION_CHAIN;
  provider.getAccountRc = async () => "100000000";
  provider.invokeGetContractAddress = async () => ({ value: { address: mainnet ? MAINNET_TOKEN : FOUNDATION_TOKEN } });
  provider.invokeGetContractMetadata = async () => ({ value: { hash: f.client.d.tokenHash } });
  provider.getTransactionsById = async () => ({ transactions: [] });
  provider.call = async (_method, body) => {
    if (body.broadcast === false) return { receipt: { id: body.transaction.id, rc_used: "1000" } };
    sent.push(body.transaction); throw Error("lost response");
  };
  const identity = P.hash("deployment-plan"), dir = path.join(f.directory, "deployment"), options = { provider, identity, tokenHash: f.client.d.tokenHash, mode: mainnet ? "mainnet-pilot" : "test-deployment" };
  const journal = new TestDeployer(dir, options);
  const op = [{ upload_contract: { contract_id: f.owner.getAddress(), bytecode: "AGFzbQEAAAA=" } }];
  let signs = 0; const sign = f.owner.signTransaction.bind(f.owner); f.owner.signTransaction = tx => { signs++; assert.equal(journal.get("upload").state, "signing"); return sign(tx); };
  if (mainnet) {
    provider.getAccountRc = async () => "1";
    await assert.rejects(journal.prepare("upload", op, f.owner, "10000000"), /Insufficient/); assert.equal(signs, 0);
    provider.getAccountRc = async () => "100000000";
  }
  const prepared = await journal.prepare("upload", op, f.owner, "10000000");
  await assert.rejects(journal.submit("upload", P.hash("different")), /exact deployment plan/);
  assert.equal(sent.length, 0); await journal.submit("upload", identity); assert.equal(sent.length, 1); assert.deepEqual(sent[0], prepared.transaction);
  journal.close(); const reopened = new TestDeployer(dir, options);
  try {
    assert.deepEqual((await reopened.prepare("upload", op, f.owner, "10000000")).transaction, prepared.transaction); assert.equal(signs, 1);
    await assert.rejects(reopened.prepare("upload", op, f.owner, "20000000"), /change/);
    provider.getChainId = async () => "wrong"; await assert.rejects(reopened.submit("upload", identity), /identity/);
  } finally { reopened.close(); }
});
function mainnetDeployment(t, initialize = false) {
  const f = fixture(t), { TestDeployer } = require("../lib/koin-network/test-deployer");
  const { MAINNET_CHAIN, MAINNET_TOKEN } = require("../lib/koin-network/payment-mode");
  const provider = f.client.provider, calls = [], identity = P.hash("measured-mainnet-deployment");
  provider.getChainId = async () => MAINNET_CHAIN;
  provider.getAccountRc = async () => "500000000";
  provider.invokeGetContractAddress = async () => ({ value: { address: MAINNET_TOKEN } });
  provider.invokeGetContractMetadata = async () => ({ value: { hash: f.client.d.tokenHash } });
  provider.getTransactionsById = async () => ({ transactions: [] });
  const options = { provider, identity, tokenHash: f.client.d.tokenHash, mode: "mainnet-pilot" };
  const directory = path.join(f.directory, "mainnet-deployment"); let journal;
  const reopen = () => { journal?.close(); journal = new TestDeployer(directory, options); return journal; };
  reopen(); t.after(() => journal.close());
  const operations = initialize
    ? [{ call_contract: { contract_id: f.owner.getAddress(), entry_point: 1, args: "" } }]
    : [{ upload_contract: { contract_id: f.owner.getAddress(), bytecode: "AGFzbQEAAAA=" } }];
  let signs = 0; const original = f.owner.signTransaction.bind(f.owner);
  f.owner.signTransaction = tx => { signs++; return original(tx); };
  provider.call = async (method, body) => {
    assert.equal(method, "chain.submit_transaction"); calls.push(structuredClone(body));
    if (body.broadcast) {
      const saved = journal.get("step");
      assert.ok(saved.attempts > 0); assert.equal(saved.simulation.txId, body.transaction.id);
      assert.deepEqual(saved.transaction, body.transaction);
      throw Error("lost broadcast acknowledgment");
    }
    assert.equal(journal.get("step").attempts, 0);
    return { receipt: { id: body.transaction.id, rc_used: "1000000" } };
  };
  return { provider, calls, identity, reopen, get journal() { return journal; }, get signs() { return signs; },
    prepare: () => journal.prepare("step", operations, f.owner, "100000000") };
}
for (const initialize of [false, true]) test("mainnet " + (initialize ? "initialization" : "upload") + " measures Mana before broadcast and recovers the exact envelope after restart", async t => {
  const f = mainnetDeployment(t, initialize), prepared = await f.prepare();
  await f.journal.submit("step", f.identity);
  assert.deepEqual(f.calls.map(c => c.broadcast), [false, true]);
  for (const call of f.calls) assert.deepEqual(call.transaction, prepared.transaction);
  const measured = f.journal.get("step").simulation;
  assert.equal(measured.rcUsed, "1000000"); assert.equal(measured.requiredRc, "1260000");
  assert.equal(measured.rcLimit, "100000000");
  f.reopen(); assert.deepEqual(f.journal.get("step").simulation, measured);
  assert.deepEqual((await f.prepare()).transaction, prepared.transaction); assert.equal(f.signs, 1);
  // Advance the durable retry clock without sleeping; a submitted nonce must
  // never be simulated again, even if the node lost its acknowledgment.
  f.journal.guard.write(f.journal.db, () => { const r = f.journal.get("step"); r.lastAttempt = Date.now() - 10001; f.journal.save(r); });
  await f.journal.submit("step", f.identity);
  assert.deepEqual(f.calls.map(c => c.broadcast), [false, true, true]);
  assert.deepEqual(f.calls[2].transaction, prepared.transaction); assert.equal(f.signs, 1);
});
const rejectedSimulations = [
  ["RPC failure", () => { throw Error("RPC unavailable"); }],
  ["missing receipt", () => ({})],
  ["RPC error", r => ({ receipt: r, rpc_error: "failure" })],
  ["wrong transaction", r => ({ receipt: { ...r, id: "another-transaction" } })],
  ["reverted execution", r => ({ receipt: { ...r, reverted: true } })],
  ["malformed execution status", r => ({ receipt: { ...r, reverted: "false" } })],
  ["numeric cost", r => ({ receipt: { ...r, rc_used: 1000000 } })],
  ["zero cost", r => ({ receipt: { ...r, rc_used: "0" } })],
  ["overflowing cost", r => ({ receipt: { ...r, rc_used: "18446744073709551616" } })],
  ["cost exceeds ceiling", r => ({ receipt: { ...r, rc_used: "100000001" } })],
  ["insufficient cost headroom", r => ({ receipt: { ...r, rc_used: "80000000" } })]
];
for (const [reason, respond] of rejectedSimulations) test("mainnet simulation blocks " + reason + " without broadcasting or replacing the saved signature", async t => {
  const f = mainnetDeployment(t), prepared = await f.prepare(); let broadcasts = 0;
  f.provider.call = async (_method, body) => {
    if (body.broadcast) { broadcasts++; return {}; }
    assert.deepEqual(body.transaction, prepared.transaction);
    return respond({ id: body.transaction.id, rc_used: "1000000" });
  };
  await assert.rejects(f.journal.submit("step", f.identity), /simulation|headroom/);
  assert.equal(broadcasts, 0); assert.equal(f.journal.get("step").attempts, 0);
  f.reopen(); assert.deepEqual((await f.prepare()).transaction, prepared.transaction); assert.equal(f.signs, 1);
  assert.equal(f.journal.get("step").simulation, undefined);
});
test("mainnet rechecks available Mana after simulation and resumes a failed estimate with the same signature", async t => {
  const f = mainnetDeployment(t), prepared = await f.prepare();
  f.provider.getAccountRc = async () => "99999999";
  await assert.rejects(f.journal.submit("step", f.identity), /Insufficient.*Mana/);
  assert.deepEqual(f.calls.map(c => c.broadcast), [false]); assert.equal(f.journal.get("step").attempts, 0);
  f.reopen(); f.provider.getAccountRc = async () => "500000000";
  await f.prepare(); await f.journal.submit("step", f.identity);
  assert.deepEqual(f.calls.map(c => c.broadcast), [false, false, true]);
  assert.deepEqual(f.calls[2].transaction, prepared.transaction); assert.equal(f.signs, 1);
});
test("participant invitations bind a separate wallet without printing tokens or re-enabling revoked access", t => {
  const f = fixture(t), { invite } = require("../deploy/koin-test/setup"), owner = f.owner.getAddress();
  const schedulerUrl = "https://test.example/scheduler", c = { schema: 1, mode: "test-deployment", deployment: f.client.d,
    roles: Object.fromEntries(["settlement", "lifecycle", "claims"].map(k => [k, Signer.fromSeed("invite-role-" + k).getAddress()])),
    schedulerUrl, version: 1, tokenizer: {}, tariff: {}, policyHash: P.hash("invite-policy"), maxRcPerTransaction: "100", maxRcPerDay: "1000" };
  fs.writeFileSync(path.join(f.directory, "runtime.json"), JSON.stringify(c));
  fs.writeFileSync(path.join(f.directory, "desktop-manifest.json"), JSON.stringify({ deployment: c.deployment, schedulerUrl, owner }));
  const file = path.join(f.directory, "invitations.json");
  fs.writeFileSync(file, JSON.stringify([{ accountId: "test_original", grantId: "grant_original", owner,
    tokenHash: P.hash("original"), expiresAt: Date.now() + 1000000, enabled: true }]));
  const participant = Signer.fromSeed("second-owner-for-test").getAddress(), logs = [], original = console.log; let result;
  try { console.log = value => logs.push(value); result = invite(f.directory, participant); assert.deepEqual(invite(f.directory, participant), result); }
  finally { console.log = original; }
  const privateFile = JSON.parse(fs.readFileSync(result.accessFile)), rows = JSON.parse(fs.readFileSync(file));
  assert.equal(rows.length, 2); assert.equal(rows[1].tokenHash, P.hash(privateFile.token));
  assert.equal(JSON.parse(fs.readFileSync(result.manifestFile)).owner, participant);
  assert.equal(JSON.stringify(logs).includes(privateFile.token), false); assert.equal(fs.readFileSync(file, "utf8").includes(privateFile.token), false);
  rows[1].enabled = false; fs.writeFileSync(file, JSON.stringify(rows));
  assert.throws(() => invite(f.directory, participant), /cannot be replaced/);
});
