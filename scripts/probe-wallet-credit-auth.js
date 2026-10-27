"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const express = require("express"), { Signer } = require("koilib");
const { AccountService, createAccounts } = require("../lib/accounts");
const { challengeHash, CHALLENGE_TTL_MS, SESSION_TTL_MS } = require("../lib/wallet-credit-auth");
const P = require("../lib/koin-network/job-protocol");
const alice = Signer.fromSeed("wallet-credit-alice"), bob = Signer.fromSeed("wallet-credit-bob");
const address = alice.getAddress(), deviceId = P.hash("desktop-one"), schedulerUrl = "https://credits.example.test/scheduler";
const target = { chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: Signer.fromSeed("credit-contract").getAddress(),
  creditsHash: "0x1220" + P.hash("wasm"), domain: "shadow:wallet-credit-probe", policyHash: P.hash("policy") };
function fixture(t, routes = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-wallet-credit-"));
  let now = 1793000000000, service;
  const opts = { stateDir: dir, siteOrigin: "https://credits.example.test" };
  const open = () => { service = new AccountService(opts); service.configureWalletCredits({ target, schedulerUrl, clock: () => now }); return service; };
  if (routes) {
    const accounts = createAccounts(opts); service = accounts.service; service.configureWalletCredits({ target, schedulerUrl, clock: () => now });
    return { ...base(), accounts };
  }
  open(); return base();
  function base() {
    t.after(() => { service.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { get service() { return service; }, dir, advance(ms) { now += ms; }, restart() { service.db.close(); return open(); },
      async connect(wallet = alice, device = deviceId, freeOnly = false) {
        const challenge = service.walletCredits.challenge({ address: wallet.getAddress(), deviceId: device, freeOnly });
        const signature = Buffer.from(await wallet.signHash(challengeHash(challenge))).toString("base64");
        return { ...service.walletCredits.verify({ challengeId: challenge.nonce, signature }), challenge, signature };
      } };
  }
}
test("wallet-only connection creates one stable credit identity across devices and restarts without a general account session", async t => {
  const f = fixture(t), first = await f.connect(), svc = f.service;
  assert.match(first.token, /^wc_[A-Za-z0-9_-]{43}$/);
  assert.equal(svc.sessionAccount(first.token), null);
  assert.equal(first.account.scope, "wallet-credits"); assert.deepEqual(first.account.wallets.map(w => w.address), [address]);
  assert.equal(svc.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  assert.equal(svc.db.prepare("SELECT COUNT(*) AS n FROM spend_grants").get().n, 0);
  assert.equal(svc.getAccount(first.account.id).email, null);
  assert.throws(() => svc.walletCredits.verify({ challengeId: first.challenge.nonce, signature: first.signature }), /already used/);
  f.restart();
  assert.equal(f.service.creditSessionAccount(first.token).id, first.account.id);
  assert.throws(() => f.service.walletCredits.verify({ challengeId: first.challenge.nonce, signature: first.signature }), /already used/);
  const second = await f.connect(alice, P.hash("desktop-two"));
  assert.equal(second.account.id, first.account.id);
  assert.equal(f.service.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1);
  f.service.walletCredits.revoke(first.token);
  assert.equal(f.service.creditSessionAccount(first.token), null);
  assert.equal(f.service.creditSessionAccount(second.token).id, first.account.id);
});
test("wallet credit sessions reuse the linked account while hiding other wallets and account management data", async t => {
  const f = fixture(t), svc = f.service, account = svc._newAccount({ email: "original@example.test" });
  for (const w of [alice, bob]) svc.db.prepare("INSERT INTO wallets(address,account_id,label,linked_at) VALUES(?,?,NULL,?)").run(w.getAddress(), account.id, Date.now());
  const general = svc._issueSession(account.id, "existing desktop"), first = await f.connect();
  assert.equal(first.account.id, account.id);
  assert.deepEqual(Object.keys(first.account).sort(), ["expiresAt", "freeOnly", "id", "scope", "wallets"]);
  assert.deepEqual(first.account.wallets.map(w => w.address), [address]);
  assert.equal(svc.sessionAccount(general).id, account.id);
  assert.equal(svc.creditAccountView(svc.creditSessionAccount(first.token)).wallets.length, 1);
  assert.equal(svc.accountView(svc.sessionAccount(general)).wallets.length, 2);
  svc.unlinkWallet(account, address);
  assert.equal(svc.creditSessionAccount(first.token), null);
  await assert.rejects(f.connect(), /account link changed/);
  assert.equal(svc.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1);
});
test("challenge proof binds wallet, device, deployment, origin, purpose and exact lifetime, with durable expiry", async t => {
  const f = fixture(t), auth = f.service.walletCredits, c = auth.challenge({ address, deviceId, freeOnly: false });
  const sig = x => alice.signHash(challengeHash(x)).then(b => Buffer.from(b).toString("base64"));
  const wrong = Buffer.from(await bob.signHash(challengeHash(c))).toString("base64");
  assert.throws(() => auth.verify({ challengeId: c.nonce, signature: wrong }), /does not match/);
  // Signatures over each alternate valid domain must fail against the saved challenge.
  for (const modified of [{ ...c, deviceId: P.hash("other") }, { ...c, target: { ...c.target, policyHash: P.hash("other-policy") } },
    { ...c, serviceOrigin: "https://other.example.test", schedulerUrl: "https://other.example.test/scheduler" }]) {
    const signature = await sig(modified); assert.throws(() => auth.verify({ challengeId: c.nonce, signature }), /does not match/);
  }
  assert.throws(() => challengeHash({ ...c, purpose: "spend-grant" }), /Invalid/);
  assert.throws(() => challengeHash({ ...c, sessionExpiresAt: c.sessionExpiresAt + 1 }), /Invalid/);
  const signature = await sig(c); f.advance(CHALLENGE_TTL_MS); f.restart();
  assert.throws(() => f.service.walletCredits.verify({ challengeId: c.nonce, signature }), /expired/);
  const active = await f.connect(); f.advance(SESSION_TTL_MS); f.restart();
  assert.equal(f.service.creditSessionAccount(active.token), null);
});
test("wallet connection preserves purchased balance and the existing daily free allowance rather than creating another grant", async t => {
  const f = fixture(t), credits = require("./helpers/koin-prepaid-fixture").fixture(t, { product: "prepaid-usd-v1", freePolicy: {
    version: 1, accountDaily: "10000", networkDaily: "20000", originDaily: "20000", accountConcurrent: 2, eligibleModels: ["fixture"] } });
  const account = f.service._newAccount({ email: "already-has-credits@example.test" });
  f.service.db.prepare("INSERT INTO wallets(address,account_id,label,linked_at) VALUES(?,?,NULL,?)").run(credits.owner, account.id, Date.now());
  const identity = { accountId: P.hash("verified-account:" + account.id), origin: P.hash("origin") };
  credits.purchase("existing-paid-credits", "1000");
  const input = { ...credits.request("used-free-credits"), identity, ownership: { accountId: account.id, wallets: [credits.owner] } };
  credits.ledger.reserve(input); const completed = await credits.complete(input.id); credits.ledger.acknowledge(input.id, credits.owner, completed.receiptHash);
  const before = credits.ledger.creditView(credits.owner, identity);
  assert.ok(BigInt(before.free.available) < 10000n); assert.equal(before.purchased.available, "1000");
  const walletSession = await f.connect(credits.buyer), reconnect = await f.connect(credits.buyer, P.hash("second-install"));
  assert.equal(walletSession.account.id, account.id); assert.equal(reconnect.account.id, account.id);
  const after = credits.ledger.creditView(credits.owner, { ...identity, accountId: P.hash("verified-account:" + reconnect.account.id) });
  assert.deepEqual(after.purchased, before.purchased); assert.deepEqual(after.free, before.free);
  assert.equal(credits.ledger.db.prepare("SELECT COUNT(*) AS n FROM free_grants").get().n, 1);
});
test("free-only authority is wallet-signed, survives restart and cannot be widened by changing a request", async t => {
  const f = fixture(t), auth = f.service.walletCredits;
  assert.equal(auth.capabilities().freeOnlySessions, 1);
  assert.throws(() => auth.challenge({ address, deviceId }), /required/);
  const c = auth.challenge({ address, deviceId, freeOnly: true });
  const broader = Buffer.from(await alice.signHash(challengeHash({ ...c, freeOnly: false }))).toString("base64");
  assert.throws(() => auth.verify({ challengeId: c.nonce, signature: broader }), /does not match/);
  const signature = Buffer.from(await alice.signHash(challengeHash(c))).toString("base64");
  assert.throws(() => auth.verify({ challengeId: c.nonce, signature, freeOnly: false }), /Invalid/);
  const connected = auth.verify({ challengeId: c.nonce, signature });
  assert.equal(connected.freeOnly, true); assert.equal(connected.account.freeOnly, true);
  assert.equal(f.service.creditSessionAccount(connected.token).creditFreeOnly, true);
  f.restart(); assert.equal(f.service.creditSessionAccount(connected.token).creditFreeOnly, true);
  assert.equal(f.service.creditAccountView(f.service.creditSessionAccount(connected.token)).freeOnly, true);
  assert.equal(f.service.sessionAccount(connected.token), null);
});
test("real HTTP wallet proof grants credit session only; account routes and browser device approval remain denied", async t => {
  const f = fixture(t, true), app = express(); app.use(express.json()); app.use(f.accounts.router);
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(route, body, token) {
    const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const caps = await request("/auth/wallet-credit/capabilities"); assert.equal(caps.body.capabilities.walletCredits, 1);
  const challenge = (await request("/auth/wallet-credit/challenge", { address, deviceId, freeOnly: false })).body.challenge;
  const signature = Buffer.from(await alice.signHash(challengeHash(challenge))).toString("base64");
  const connected = await request("/auth/wallet-credit/verify", { challengeId: challenge.nonce, signature });
  assert.equal(connected.status, 200); assert.equal(connected.headers.get("set-cookie"), null);
  const token = connected.body.token, session = await request("/auth/session", undefined, token);
  assert.equal(session.status, 200); assert.equal(session.body.account.scope, "wallet-credits");
  assert.equal((await request("/account/api", undefined, token)).status, 401);
  assert.equal((await request("/account/wallets", { address: bob.getAddress() }, token)).status, 401);
  assert.equal((await request("/auth/device/approve", { userCode: "ABCDE" }, token)).status, 401);
  assert.equal((await request("/auth/passkey/register/options", {}, token)).status, 401);
  assert.equal((await request("/auth/wallet-credit/logout", {}, token)).status, 200);
  assert.equal((await request("/auth/session", undefined, token)).status, 401);
});
