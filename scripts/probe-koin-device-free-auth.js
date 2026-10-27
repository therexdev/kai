"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { AccountService } = require("../lib/accounts"), { Signer } = require("koilib");
const { challengeHash, publicKey, CHALLENGE_TTL_MS, SESSION_TTL_MS } = require("../lib/device-free-auth");
const P = require("../lib/koin-network/job-protocol");
const origin = "https://credits.fixture.invalid", schedulerUrl = origin + "/scheduler";
const target = { chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: Signer.fromSeed("free-contract").getAddress(),
  creditsHash: "0x1220" + P.hash("free-wasm"), domain: "shadow:mainnet-pilot-" + P.hash("free-service"), policyHash: P.hash("free-policy") };
const keypair = () => { const pair = crypto.generateKeyPairSync("ed25519"); return { ...pair, encoded: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") }; };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-device-free-auth-")); let now = Date.now(), service, pin = target;
  const open = () => { service = new AccountService({ stateDir: directory, siteOrigin: origin }); service.configureWalletCredits({ target: pin, schedulerUrl, clock: () => now }); };
  open(); t.after(() => { service.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get service() { return service; }, advance(ms) { now += ms; }, restart(next = pin) { service.db.close(); pin = next; open(); },
    connect(pair, remote = "127.0.0.1") { const c = service.deviceFreeCredits.challenge({ publicKey: pair.encoded }, remote), signature = crypto.sign(null, challengeHash(c), pair.privateKey).toString("base64");
      return { ...service.deviceFreeCredits.verify({ challengeId: c.nonce, signature }), challenge: c, signature }; } };
}
test("automatic free proof creates one stable scoped identity across restart, no wallet, general account, spend grant or raw server credential", t => {
  const f = fixture(t), pair = keypair(), first = f.connect(pair);
  assert.match(first.token, /^df_[A-Za-z0-9_-]{43}$/); assert.match(first.account.id, /^guest_[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first.account).sort(), ["expiresAt", "freeOnly", "id", "scope", "wallets"]);
  assert.deepEqual(first.account.wallets, []); assert.equal(first.freeOnly, true); assert.equal(first.scope, "device-free");
  for (const table of ["accounts", "wallets", "sessions", "spend_grants"]) assert.equal(f.service.db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n, 0);
  assert.equal(f.service.sessionAccount(first.token), null); assert.equal(f.service.walletCredits.sessionAccount(first.token), null);
  const row = f.service.db.prepare("SELECT * FROM device_free_sessions").get(); assert.equal(row.token_hash, P.hash(first.token)); assert.equal(JSON.stringify(row).includes(first.token), false);
  f.restart(); assert.equal(f.service.creditSessionAccount(first.token).id, first.account.id);
  const again = f.connect(pair); assert.equal(again.account.id, first.account.id); assert.notEqual(again.token, first.token);
  assert.equal(f.service.creditSessionAccount(first.token), null); assert.equal(f.service.db.prepare("SELECT COUNT(*) AS n FROM device_free_sessions").get().n, 1);
  const other = f.connect(keypair()); assert.notEqual(other.account.id, first.account.id);
  f.service.deviceFreeCredits.revoke(again.token); assert.equal(f.service.creditSessionAccount(again.token), null); assert.ok(f.service.creditSessionAccount(other.token));
});
test("free-device proof binds the canonical key, full deployment, origin, nonce and exact lifetime with durable replay rejection", t => {
  const f = fixture(t), pair = keypair(), other = keypair(), c = f.service.deviceFreeCredits.challenge({ publicKey: pair.encoded });
  const sign = value => crypto.sign(null, challengeHash(value), pair.privateKey).toString("base64");
  assert.throws(() => f.service.deviceFreeCredits.verify({ challengeId: c.nonce, signature: crypto.sign(null, challengeHash(c), other.privateKey).toString("base64") }), /signature/);
  for (const altered of [{ ...c, publicKey: other.encoded }, { ...c, nonce: P.hash("other-nonce") }, { ...c, target: { ...c.target, policyHash: P.hash("other") } },
    { ...c, serviceOrigin: "https://other.invalid", schedulerUrl: "https://other.invalid/scheduler" }])
    assert.throws(() => f.service.deviceFreeCredits.verify({ challengeId: c.nonce, signature: sign(altered) }), /signature/);
  for (const altered of [{ ...c, purpose: "wallet-credit-session" }, { ...c, sessionExpiresAt: c.sessionExpiresAt + 1 }, { ...c, freeOnly: false }]) assert.throws(() => challengeHash(altered));
  const signature = sign(c); f.service.deviceFreeCredits.verify({ challengeId: c.nonce, signature }); f.restart();
  assert.throws(() => f.service.deviceFreeCredits.verify({ challengeId: c.nonce, signature }), /already used/);
  const pending = f.service.deviceFreeCredits.challenge({ publicKey: pair.encoded }); f.advance(CHALLENGE_TTL_MS); f.restart();
  assert.throws(() => f.service.deviceFreeCredits.verify({ challengeId: pending.nonce, signature: sign(pending) }), /expired/);
  const fresh = f.connect(pair); f.advance(SESSION_TTL_MS); f.restart(); assert.equal(f.service.creditSessionAccount(fresh.token), null);
  const before = f.connect(pair); f.restart({ ...target, policyHash: P.hash("new-policy") }); assert.equal(f.service.creditSessionAccount(before.token), null);
  assert.notEqual(f.connect(pair).account.id, before.account.id);
});
test("free-device enrollment rejects financial fields, arbitrary key encodings, invalid signatures and bounded connection floods", t => {
  const f = fixture(t), pair = keypair(), auth = f.service.deviceFreeCredits;
  for (const extra of [{ accountId: "another" }, { address: Signer.fromSeed("wallet").getAddress() }, { freeOnly: false }, { deviceId: P.hash("asserted-id") }])
    assert.throws(() => auth.challenge({ publicKey: pair.encoded, ...extra }), /Exact/);
  for (const value of [pair.encoded + "\n", pair.encoded.slice(0, -1), "A".repeat(60), crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64")]) assert.throws(() => publicKey(value));
  const c = auth.challenge({ publicKey: pair.encoded });
  for (const signature of ["", "A".repeat(88), crypto.sign(null, challengeHash(c), pair.privateKey).toString("base64") + "\n"]) assert.throws(() => auth.verify({ challengeId: c.nonce, signature }));
  for (let i = 1; i < 10; i++) auth.challenge({ publicKey: pair.encoded });
  assert.throws(() => auth.challenge({ publicKey: pair.encoded }), /busy/);
  f.advance(CHALLENGE_TTL_MS); assert.ok(auth.challenge({ publicKey: pair.encoded }));
  for (let i = 1; i < 60; i++) auth.challenge({ publicKey: keypair().encoded }, "shared-proxy");
  auth.challenge({ publicKey: keypair().encoded }, "shared-proxy");
  assert.throws(() => auth.challenge({ publicKey: keypair().encoded }, "shared-proxy"), /busy/);
});
test("a reboot or new free session reuses the actual spent daily allowance and never alters existing paid balances", async t => {
  const f = fixture(t), pair = keypair(), session = f.connect(pair), credits = require("./helpers/koin-prepaid-fixture").fixture(t, {
    product: "prepaid-usd-v1", freePolicy: { version: 1, accountDaily: "1000", networkDaily: "2000", originDaily: "1500", accountConcurrent: 2, eligibleModels: ["fixture"] } });
  const identity = { accountId: P.hash("verified-account:" + session.account.id), origin: P.hash("origin:127.0.0.1") }, owner = "account-" + identity.accountId;
  credits.purchase("unrelated-paid", "1000");
  const request = { ...credits.request("free-device-answer"), owner, identity, freeOnly: true, ownership: { accountId: session.account.id, wallets: [] } };
  credits.ledger.reserve(request); const answer = await credits.complete(request.id); credits.ledger.acknowledge(request.id, owner, answer.receiptHash);
  const before = credits.ledger.creditView(owner, identity); assert.ok(BigInt(before.free.available) < 1000n);
  f.restart(); credits.restart(); const again = f.connect(pair); assert.equal(again.account.id, session.account.id);
  assert.deepEqual(credits.ledger.creditView(owner, identity).free, before.free);
  assert.equal(credits.ledger.db.prepare("SELECT COUNT(*) AS n FROM free_grants").get().n, 1);
  assert.equal(credits.ledger.balance(credits.owner).purchased, "1000"); assert.equal(credits.ledger.balance(owner).purchased, "0");
});
