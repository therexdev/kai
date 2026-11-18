"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { service } = require("./helpers/credit-gateway-fixture");
const P = require("../lib/koin-network/job-protocol"), { Signer, Transaction } = require("koilib");
const bearer = secret => ({ authorization: "Bearer " + secret });
const chat = { model: "fixture", messages: [{ role: "user", content: "Hi" }], max_tokens: 16 };

test("verified signup, walletless grants, key secrecy, account isolation, expiry and revocation", async t => {
  const s = await service(t), alice = await s.signup("alice@example.test"), bob = await s.signup("bob@example.test");
  assert.equal(alice.data.token, undefined); assert.equal((await s.raw("/platform")).status, 302);
  assert.equal((await s.raw("/account", undefined, { cookie: alice.cookie })).status, 200);
  const created = await s.createKey(alice); assert.equal(created.status, 201, JSON.stringify(created.value));
  const { secret, key } = created.value; assert.match(secret, /^kai_api_/);
  assert.ok(!JSON.stringify(s.auth.service.db.prepare("SELECT * FROM credit_api_keys").all()).includes(secret));
  assert.equal((await s.call("/v1/credits", undefined, bearer(secret))).value.credits.free.available, "1000");
  assert.equal((await s.call("/platform/api/keys", undefined, bearer(secret))).status, 401);
  assert.equal((await s.call("/auth/session", undefined, bearer(secret))).status, 401);
  assert.equal((await s.call("/platform/api/keys", undefined, { cookie: bob.cookie })).value.keys.length, 0);
  assert.equal((await s.call("/platform/api/keys/" + key.id, undefined, { cookie: bob.cookie }, "DELETE")).status, 404);
  assert.equal((await s.call("/platform/api/keys", { name: "evil", dailyLimitAtoms: "1" }, { cookie: alice.cookie, origin: "https://other.invalid" })).status, 403);
  assert.equal((await s.call("/v1/credits", undefined, { cookie: alice.cookie })).status, 401);
  const readOnly = await s.createKey(alice, { scopes: ["billing:read"] });
  assert.equal((await s.call("/v1/models", undefined, bearer(readOnly.value.secret))).status, 403);
  assert.equal((await s.call("/platform/api/keys/" + key.id, undefined, { cookie: alice.cookie }, "DELETE")).status, 200);
  assert.equal((await s.call("/v1/credits", undefined, bearer(secret))).status, 401);
  s.f.time(91 * 86400000);
  assert.equal((await s.call("/v1/credits", undefined, bearer(readOnly.value.secret))).status, 401);
});

test("real signed provider response, OpenAI envelope, retry billing and shared daily allowance", async t => {
  const s = await service(t), user = await s.signup("chat@example.test"), one = (await s.createKey(user)).value, two = (await s.createKey(user)).value;
  const models = await s.call("/v1/models", undefined, bearer(one.secret)); assert.equal(models.value.data[0].id, "fixture");
  const headers = { ...bearer(one.secret), "idempotency-key": "same-request-123" };
  const pending = s.call("/v1/chat/completions", chat, headers), job = await s.dispatch();
  await s.result(job); const answer = await pending;
  assert.equal(answer.status, 200, JSON.stringify(answer.value)); assert.equal(answer.value.choices[0].message.content, "Hello");
  assert.equal(answer.value.object, "chat.completion"); assert.equal(answer.value.model, "fixture"); assert.equal(answer.value.completion, undefined);
  assert.ok(answer.value.usage.total_tokens > 0); assert.equal(answer.value.koin, undefined);
  const before = (await s.call("/v1/credits", undefined, bearer(one.secret))).value;
  assert.ok(BigInt(before.credits.free.available) < 1000n); assert.equal(before.credits.purchased.spent, "0");
  assert.equal((await s.call("/v1/credits", undefined, bearer(two.secret))).value.credits.free.available, before.credits.free.available);
  assert.equal((await s.call("/platform/api/overview?wallet=", undefined, { cookie: user.cookie })).value.credits.free.available, before.credits.free.available);
  assert.equal((await s.call("/v1/chat/completions", chat, headers)).value.choices[0].message.content, "Hello");
  assert.equal((await s.call("/v1/credits", undefined, bearer(one.secret))).value.credits.free.available, before.credits.free.available);
  assert.equal((await s.call("/v1/chat/completions", { ...chat, messages: [{ role: "user", content: "different" }] }, headers)).status, 400);
  for (const input of [{ ...chat, tools: [] }, { ...chat, temperature: .7 }, { ...chat, max_tokens: 100 }, { ...chat, creditWallet: s.f.owner }, { ...chat, sessionToken: "injected" }]) assert.equal((await s.call("/v1/chat/completions", input, bearer(one.secret))).status, 400);
  const raw = await fetch(s.base + "/v1/chat/completions", { method: "POST", headers: { ...bearer(one.secret), "content-type": "application/json" }, body: "{" });
  assert.equal(raw.status, 400); assert.equal((await raw.json()).error.message, "Invalid JSON request");
});

test("streaming uses incremental deltas, terminal usage and DONE; revocation stops active work", async t => {
  const s = await service(t), user = await s.signup("stream@example.test"), { secret, key } = (await s.createKey(user)).value;
  const response = await s.raw("/v1/chat/completions", { ...chat, stream: true, stream_options: { include_usage: true } }, bearer(secret));
  assert.match(response.headers.get("content-type"), /event-stream/);
  const job = await s.dispatch(); await s.result(job, "Hi", 1); await s.result(job, "Hi there", 2); await s.result(job, "Hi there");
  const stream = await response.text(), data = stream.split("\n\n").filter(x => x.startsWith("data: ") && x !== "data: [DONE]").map(x => JSON.parse(x.slice(6)));
  assert.equal(data.map(v => v.choices[0]?.delta?.content || "").join(""), "Hi there");
  assert.equal(data.filter(v => v.choices[0]?.finish_reason === "stop").length, 1);
  assert.ok(data.at(-1).usage.total_tokens > 0); assert.match(stream, /data: \[DONE\]/);
  const next = await s.raw("/v1/chat/completions", { ...chat, stream: true }, bearer(secret)); await s.dispatch();
  await s.call("/platform/api/keys/" + key.id, undefined, { cookie: user.cookie }, "DELETE");
  assert.match(await next.text(), /revoked/); assert.equal(s.prepaid.ledger.activeJobs().length, 0);
});

test("key budget includes concurrent holds and survives restart; deleting key cannot reset account rate", async t => {
  const s = await service(t), user = await s.signup("limit@example.test");
  const maximum = s.f.meter.quote(s.f.target.domain, "fixture", 1, chat.messages, 16, s.f.options.clock()).maxCharge;
  const { secret } = (await s.createKey(user, { dailyLimitAtoms: maximum })).value;
  const pending = s.call("/v1/chat/completions", chat, bearer(secret)), job = await s.dispatch();
  const blocked = await s.call("/v1/chat/completions", chat, bearer(secret)); assert.equal(blocked.status, 429, JSON.stringify(blocked));
  await s.result(job); await pending;
  // Reopen the auth key store while the durable debit remains in the ledger.
  const { CreditApiKeys } = require("../lib/credit-api-keys");
  const reopened = new CreditApiKeys(s.auth.service, s.f.options.clock); assert.equal(reopened.resolve(secret, "inference").key.dailyLimitAtoms, maximum);
  assert.equal((await s.call("/v1/chat/completions", chat, bearer(secret))).status, 429);
  for (let i = 0; i < 61; i++) { try { reopened.rate(user.account.id); } catch {} }
  const rate = await s.raw("/v1/credits", undefined, bearer(secret)); assert.equal(rate.status, 429); assert.equal(rate.headers.get("retry-after"), "60");
  s.f.time(60000); assert.equal((await s.call("/v1/credits", undefined, bearer(secret))).status, 200);
});

test("wallet proof, unsigned purchase quotes, confirmation isolation and purchased credit use", async t => {
  const s = await service(t), user = await s.signup("buyer@example.test"), other = await s.signup("other@example.test");
  assert.equal((await s.link(user)).status, 200);
  const otherWallet = Signer.fromSeed("other-web-payer"); await s.link(other, otherWallet);
  const key = (await s.createKey(user, { wallet: s.f.owner, freeOnly: false, scopes: ["inference", "billing:read", "billing:purchase"] })).value;
  const otherKey = (await s.createKey(other, { wallet: otherWallet.getAddress(), freeOnly: true, scopes: ["billing:read", "billing:purchase"] })).value;
  assert.equal((await s.call("/v1/credits/purchase-quote", { dollars: "1" }, bearer(otherKey.secret))).status, 200, "free-only inference does not block an explicitly permitted wallet purchase");
  const quote = await s.call("/v1/credits/purchase-quote", { dollars: "1", intent_id: P.hash("web-purchase") }, bearer(key.secret));
  assert.equal(quote.status, 200, JSON.stringify(quote));
  assert.equal(quote.value.transaction.header.payer, s.f.owner); assert.equal(quote.value.transaction.header.chain_id, s.f.target.chainId);
  assert.equal(quote.value.transaction.operations.length, 2); assert.ok(!quote.value.transaction.signatures?.length);
  assert.equal(Transaction.computeTransactionId(quote.value.transaction.header), quote.value.transaction.id);
  await require("../lib/koin-network/purchase-quote").verify(s.runtime.client.d, quote.value.args, { now: s.f.options.clock(), version: 1 });
  const id = "0x1220" + P.hash("confirmed-web-purchase");
  assert.equal((await s.call("/v1/credits/purchases", { tx_id: id }, bearer(key.secret))).value.purchase.state, "pending");
  assert.equal((await s.call("/v1/credits", undefined, bearer(key.secret))).value.credits.purchased.purchased, "0");
  s.confirmed.set(id, { state: "finalized", txId: id, owner: s.f.owner, amount: "100000000", height: "100", blockId: "0x1220" + P.hash("finality") });
  await s.call("/v1/credits/purchases", { tx_id: id }, bearer(otherKey.secret));
  assert.equal((await s.call("/v1/credits", undefined, bearer(otherKey.secret))).value.credits.purchased.purchased, "0");
  for (let i = 0; i < 2; i++) assert.equal((await s.call("/v1/credits/purchases", { tx_id: id }, bearer(key.secret))).value.purchase.state, "confirmed");
  assert.equal((await s.call("/v1/credits", undefined, bearer(key.secret))).value.credits.purchased.purchased, "100000000");
  s.prepaid.ledger.free.isAvailable = () => false;
  const pending = s.call("/v1/chat/completions", chat, bearer(key.secret)); const job = await s.dispatch(); await s.result(job); assert.equal((await pending).status, 200);
  const spent = (await s.call("/v1/credits", undefined, bearer(key.secret))).value.credits.purchased.spent; assert.ok(BigInt(spent) > 0n);
  assert.equal((await s.call("/platform/api/overview?wallet=" + s.f.owner, undefined, { cookie: user.cookie })).value.credits.purchased.spent, spent);
  await s.call("/account/wallets/" + s.f.owner, undefined, { cookie: user.cookie }, "DELETE");
  assert.equal((await s.call("/v1/credits", undefined, bearer(key.secret))).status, 401);
});

test("API credit ceiling persists through ledger restart and reserves atomically across the UTC boundary", async t => {
  const { fixture } = require("./helpers/koin-prepaid-fixture");
  const f = fixture(t, { product: "prepaid-usd-v1", freePolicy: { version: 1, accountDaily: "1000", networkDaily: "2000", originDaily: "1500", accountConcurrent: 4, eligibleModels: ["fixture"] } });
  const identity = { accountId: P.hash("persistent-key-user"), origin: P.hash("test-origin") };
  const request = { ...f.request("key-day-one"), identity, freeOnly: true };
  const max = f.meter.quote(f.target.domain, request.model, request.version, request.messages, request.maxOutput, f.options.clock()).maxCharge;
  request.apiPolicy = { id: "a".repeat(32), dailyLimit: max };
  const job = f.ledger.reserve(request), ready = await f.complete(job.id); f.ledger.acknowledge(job.id, job.owner, ready.receiptHash);
  f.restart(); assert.throws(() => f.ledger.reserve({ ...request, id: P.hash("another-on-day-one") }), /daily credit limit/);
  f.time(86400000);
  const next = f.ledger.reserve({ ...request, id: P.hash("next-day") });
  f.time(86400000);
  // Hold expiry is extended only by this fixture to exercise midnight carry.
  f.ledger.write(() => f.ledger.put({ ...next, expires: f.options.clock() + 3000 }));
  assert.throws(() => f.ledger.reserve({ ...request, id: P.hash("active-prior-day") }), /daily credit limit/);
});
