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
test("contract deployment saves exact signatures before a lost submission and cannot replace its reviewed plan", async t => {
  const { TestDeployer } = require("../lib/koin-network/test-deployer"), f = fixture(t), sent = [], provider = f.client.provider;
  provider.invokeGetContractAddress = async () => ({ value: { address: FOUNDATION_TOKEN } });
  provider.invokeGetContractMetadata = async () => ({ value: { hash: f.client.d.tokenHash } });
  provider.getTransactionsById = async () => ({ transactions: [] });
  provider.call = async (_method, body) => { sent.push(body.transaction); throw Error("lost response"); };
  const identity = P.hash("deployment-plan"), dir = path.join(f.directory, "deployment"), options = { provider, identity, tokenHash: f.client.d.tokenHash };
  const journal = new TestDeployer(dir, options);
  const op = [{ upload_contract: { contract_id: f.owner.getAddress(), bytecode: "AGFzbQEAAAA=" } }];
  let signs = 0; const sign = f.owner.signTransaction.bind(f.owner); f.owner.signTransaction = tx => { signs++; assert.equal(journal.get("upload").state, "signing"); return sign(tx); };
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
