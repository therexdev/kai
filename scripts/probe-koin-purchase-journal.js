"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer } = require("koilib"), { DatabaseSync } = require("node:sqlite");
const { PurchaseQuoteIssuer, budget } = require("../lib/koin-network/purchase-quote-journal");
const { V4PurchaseOracle, pricingIdentity } = require("../lib/koin-network/v4-purchase-oracle");
const Provenance = require("../lib/koin-network/purchase-provenance"), Q = require("../lib/koin-network/purchase-quote");
const { MARKET } = require("../lib/koin-network/purchase-market");
const hex = n => n.toString(16).padStart(64, "0"), hash = n => "0x" + hex(n);
async function fixture(t, limit = "300000000") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-quote-journal-")), directory = path.join(root, "journal");
  const signer = Signer.fromSeed("isolated-journal-price-signer"), address = n => Signer.fromSeed("isolated-journal-" + n).getAddress();
  const deployment = { product: "prepaid-usd-v1", chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN,
    token: address("token"), tokenHash: "0x1220" + hex(10), credits: address("credits"), creditsHash: "0x1220" + hex(11),
    verifier: signer.getAddress(), masterNode: require("../lib/koin-network/product").MASTER_NODE };
  const feed = "0x" + "3".repeat(40), clock = { now: 1800000000000 };
  const config = { schema: 2, rpcUrls: ["https://archive-a.invalid/private-key?key=DO_NOT_ARCHIVE_A", "https://archive-b.invalid/private-key?key=DO_NOT_ARCHIVE_B"], usdtFeed: feed,
    reference: { kind: "merchant-exchange-reference", nativeChainId: deployment.chainId, nativeToken: deployment.token, wrappedChainId: 1, wrappedToken: MARKET.wrappedToken, wrappedPerNativeAtoms: "100000000" },
    policy: { version: 1, windowSeconds: 60, maxBlockGapSeconds: 12, maxPriceAgeMs: 30000, maxQuoteMs: 20000,
      maxDeviationBps: 100, maxSlippageBps: 100, maxUsdtAgeMs: 20000, maxUsdtDeviationBps: 100,
      minLiquidity: "1000000000", minProbeUsdtAtoms: "10000000", usdtSource: "ethereum:chainlink:" + feed } };
  const oracle = new V4PurchaseOracle({ config, deployment, clock: () => clock.now, fetchImpl: async () => { throw Error("No network in isolated probe"); } });
  const history = () => {
    const end = Math.floor(clock.now / 1000), blocks = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, hash: hash(i + 1), parentHash: hash(i), timestamp: end - 60 + i * 10,
      canonical: true, stateBlockHash: hash(i + 1), depthBlockHash: hash(i + 1), sqrtPriceX96: String(1n << 96n), liquidity: "1000000000000",
      probeUsdtAtoms: "10000000", buyVkoinAtoms: "9900000", sellVkoinAtoms: "10000000", sellUsdtAtoms: "9900000" }));
    return { chainId: 1, protocol: "uniswap-v4", poolId: MARKET.poolId, currency0: MARKET.wrappedToken, currency1: MARKET.quoteToken,
      decimals0: 8, decimals1: 6, fee: 10000, tickSpacing: 200, hooks: "0x" + "0".repeat(40), canonical: true, anchorHash: hash(7), blocks };
  };
  const abi = values => "0x" + values.map(n => BigInt(n).toString(16).padStart(64, "0")).join("");
  oracle.readers = [0, 1].map(() => ({ window: async () => history(), canonical: async () => {}, usdt: async () => require("../lib/koin-network/v4-history-reader").usdtObservation(
    { feed, anchorHash: hash(7), decimals: abi([8]), round: abi([1, 100000000, Math.floor(clock.now / 1000) - 1, Math.floor(clock.now / 1000) - 1, 1]) },
    { feed, source: config.policy.usdtSource, policy: config.policy, anchor: history().blocks.at(-1) }) }));
  await oracle.refresh();
  const policy = { schema: 1, dailyQuoteAuthorizationUsdAtoms: limit, accountDailyQuoteAuthorizationUsdAtoms: limit }, scope = { pricingPolicyHash: pricingIdentity(config, deployment), policyVersion: 1 };
  const issuers = [], create = (overrides = {}) => {
    const instance = new PurchaseQuoteIssuer({ directory, deployment, signer, prices: oracle, policy, scope, version: 1, clock: () => clock.now, ...overrides });
    issuers.push(instance); return instance;
  };
  t.after(async () => { for (const issuer of issuers) if (!issuer.closed) issuer.close(); oracle.close(); await oracle.pending?.catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const customer = address("customer"), issue = (issuer, n = 1, amount = "1", who = customer) => issuer.issue(who, amount, "USD", "account:" + who, hex(n));
  return { root, directory, signer, deployment, config, oracle, clock, scope, policy, create, issue, customer, address };
}
test("signed provenance commits the exact sanitized full evidence and rejects changed public details", async t => {
  const f = await fixture(t), issuer = f.create(), result = await f.issue(issuer);
  const q = await Q.verify(f.deployment, result.args, { now: f.clock.now, version: 1 });
  assert.equal(Provenance.verify(q, result.priceDetails, { expectedPricingPolicyHash: f.scope.pricingPolicyHash }).summary.marketObservedAt, f.clock.now);
  for (const mutate of [d => d.evidenceHash = hex(99), d => d.summary.usdPerKoinAtoms = "1", d => d.summary.referenceKind = "signed-parity", d => d.summary.pricingPolicyHash = hex(98)]) {
    const d = structuredClone(result.priceDetails); mutate(d); assert.throws(() => Provenance.verify(q, d));
  }
  const row = issuer.journal.db.prepare("SELECT * FROM evidence").get();
  assert.equal(Provenance.evidence(JSON.parse(row.body)).hash, result.priceDetails.evidenceHash);
  assert.ok(!/DO_NOT_ARCHIVE|https:|private-key/.test(row.body));
  assert.equal(JSON.parse(row.body).history.blocks.length, 7);
  assert.equal(JSON.parse(row.body).archiveProviderHashes.length, 2);
});
test("concurrent requests across issuer instances cannot exceed the explicit daily budget", async t => {
  const f = await fixture(t), a = f.create(), b = f.create();
  const outcomes = await Promise.allSettled(Array.from({ length: 7 }, (_, i) => f.issue(i % 2 ? a : b, i + 1, "1", f.address("concurrent-" + i))));
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 3);
  for (const r of outcomes.filter(r => r.status === "rejected")) assert.equal(r.reason.code, "PURCHASE_QUOTE_BUDGET_EXCEEDED");
  assert.equal(a.journal.db.prepare("SELECT authorized FROM days").get().authorized, "300000000");
});
test("retry and restart preserve exact signed bytes and a single debit; a second intentional same-amount purchase is distinct", async t => {
  const f = await fixture(t), a = f.create();
  const first = await f.issue(a), duplicate = await f.issue(a);
  assert.deepEqual(first, duplicate); a.close();
  const b = f.create({ prices: { readEvidence() { throw Error("price refresh must not replace a valid saved intent"); } } });
  assert.deepEqual(await f.issue(b), first);
  assert.equal(b.journal.db.prepare("SELECT authorized FROM days").get().authorized, "100000000");
  const c = f.create(), second = await f.issue(c, 2);
  assert.notEqual(second.args.purchase_quote.id, first.args.purchase_quote.id);
  assert.equal(c.journal.db.prepare("SELECT authorized FROM days").get().authorized, "200000000");
});
test("a crash after intent admission recovers that intent without another budget debit", async t => {
  const f = await fixture(t, "100000000"), a = f.create({ signer: { getAddress: () => f.signer.getAddress(), signHash: async () => { throw Error("simulated signer crash"); } } });
  await assert.rejects(f.issue(a), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE");
  const intent = JSON.parse(a.journal.db.prepare("SELECT intent FROM quotes").get().intent); a.close();
  const b = f.create(), recovered = await f.issue(b);
  assert.equal(recovered.args.purchase_quote.id, intent.quote.id);
  assert.equal(b.journal.db.prepare("SELECT COUNT(*) AS n FROM quotes").get().n, 1);
  await assert.rejects(f.issue(b, 2), e => e.code === "PURCHASE_ACCOUNT_QUOTE_BUDGET_EXCEEDED");
});
test("account, amount, and pricing policy boundaries cannot reuse another intent", async t => {
  const f = await fixture(t, "1000000000"), a = f.create(), first = await f.issue(a);
  const otherAccount = await f.issue(a, 1, "1", f.address("other")), otherAmount = await f.issue(a, 1, "2");
  assert.notEqual(otherAccount.args.purchase_quote.id, first.args.purchase_quote.id);
  assert.notEqual(otherAmount.args.purchase_quote.id, first.args.purchase_quote.id);
  const changed = f.create({ scope: { ...f.scope, pricingPolicyHash: hex(44) } });
  await assert.rejects(f.issue(changed), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE");
  assert.equal(changed.journal.db.prepare("SELECT COUNT(*) AS n FROM quotes").get().n, 3);
});
test("UTC rollover grants a new authorization day, expired offers stay charged, and clock rollback pauses quotes", async t => {
  const f = await fixture(t, "100000000"), a = f.create(); await f.issue(a);
  f.clock.now += 20000; await f.oracle.refresh();
  await assert.rejects(f.issue(a), e => e.code === "PURCHASE_ACCOUNT_QUOTE_BUDGET_EXCEEDED");
  f.clock.now = (Math.floor(f.clock.now / 86400000) + 1) * 86400000; await f.oracle.refresh();
  await f.issue(a); assert.equal(a.journal.db.prepare("SELECT COUNT(*) AS n FROM days").get().n, 2);
  f.clock.now -= 1; await assert.rejects(f.issue(a), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE");
});
test("missing explicit budget never signs or initializes a journal", async t => {
  const f = await fixture(t), a = f.create({ policy: undefined });
  await assert.rejects(f.issue(a), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE");
  assert.equal(fs.existsSync(f.directory), false);
  for (const value of [undefined, {}, { schema: 1, dailyQuoteAuthorizationUsdAtoms: "0" }, { schema: 1, dailyQuoteAuthorizationUsdAtoms: "01" }]) assert.throws(() => budget(value));
});
test("archive corruption or missing journal prevents new quote signatures without exposing private errors", async t => {
  const f = await fixture(t), a = f.create(); await f.issue(a);
  a.journal.db.prepare("UPDATE evidence SET body='{}'").run();
  await assert.rejects(f.issue(a), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE" && !e.message.includes("evidence"));
  a.close(); fs.unlinkSync(path.join(f.directory, "purchase-quotes.sqlite"));
  const b = f.create(); await assert.rejects(f.issue(b, 2), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE");
});
test("restoring an older SQLite journal cannot rewind the external authorization witness", async t => {
  const f = await fixture(t), a = f.create(); await f.issue(a);
  const backup = path.join(f.root, "older.sqlite"); a.journal.db.prepare("VACUUM INTO ?").run(backup);
  await f.issue(a, 2); a.close();
  const file = path.join(f.directory, "purchase-quotes.sqlite");
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(file + suffix, { force: true }); fs.copyFileSync(backup, file);
  const b = f.create(); await assert.rejects(f.issue(b, 3), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE");
});
test("evidence mismatch and stale evidence cannot produce a signature or spend authorization budget", async t => {
  const f = await fixture(t), snapshot = await f.oracle.readEvidence(); let signs = 0;
  const signer = { getAddress: () => f.signer.getAddress(), signHash: async h => { signs++; return f.signer.signHash(h); } };
  const a = f.create({ signer, prices: { readEvidence: async () => ({ ...snapshot, evidence: { changed: true } }) } });
  await assert.rejects(f.issue(a), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE"); assert.equal(signs, 0);
  assert.equal(a.journal.db.prepare("SELECT COUNT(*) AS n FROM days").get().n, 0);
  f.clock.now = snapshot.price.expiresAt + 1;
  const b = f.create({ signer, prices: { readEvidence: async () => snapshot } });
  await assert.rejects(f.issue(b), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE"); assert.equal(signs, 0);
});
test("per-account authorization spans linked wallets and leaves other accounts their share", async t => {
  const f = await fixture(t, "300000000"); f.policy.accountDailyQuoteAuthorizationUsdAtoms = "100000000";
  const a = f.create(), first = await f.issue(a);
  assert.deepEqual(await f.issue(a), first, "retries do not debit the account twice");
  await assert.rejects(a.issue(f.address("linked-wallet"), "1", "USD", "account:" + f.customer, hex(2)), e => e.code === "PURCHASE_ACCOUNT_QUOTE_BUDGET_EXCEEDED");
  await f.issue(a, 3, "1", f.address("second-account"));
  assert.equal(a.journal.db.prepare("SELECT authorized FROM days").get().authorized, "200000000");
  assert.equal(a.journal.db.prepare("SELECT COUNT(*) AS n FROM account_days").get().n, 2);
});
test("quote journal failure leaves existing purchased credits and finality attribution usable", async t => {
  const f = await fixture(t), credits = require("./helpers/koin-prepaid-fixture").fixture(t, { product: "prepaid-usd-v1" });
  credits.purchase("before-quote-error", "1000");
  const a = f.create(); await f.issue(a); a.close(); fs.unlinkSync(path.join(f.directory, "purchase-quotes.sqlite"));
  const b = f.create(); await assert.rejects(f.issue(b), e => e.code === "PURCHASE_QUOTE_UNAVAILABLE");
  const job = credits.ledger.reserve(credits.request("existing-credit-chat")), ready = await credits.complete(job.id);
  credits.ledger.acknowledge(job.id, credits.owner, ready.receiptHash);
  assert.ok(BigInt(credits.ledger.balance(credits.owner).spent) > 0n);
  const prior = credits.ledger.balance(credits.owner).purchased;
  credits.purchase("finalized-after-quote-error", "1000");
  assert.equal(BigInt(credits.ledger.balance(credits.owner).purchased), BigInt(prior) + 1000n);
});

test("automatic price previews read current evidence without creating quote authorizations or signing", async t => {
  const f = await fixture(t), readPreview = require("../lib/koin-network/purchase-price").preview;
  let signs = 0;
  const issuer = f.create({ signer: { getAddress: () => f.signer.getAddress(), signHash: async value => { signs++; return f.signer.signHash(value); } } });
  for (let i = 0; i < 20; i++) {
    const preview = await readPreview(f.oracle, f.scope.pricingPolicyHash, () => f.clock.now);
    assert.equal(preview.pricingPolicyHash, f.scope.pricingPolicyHash);
    assert.ok(BigInt(Q.nativeForDollars("1.00", preview.usdPerKoinAtoms)) > 0n);
    assert.equal(Object.hasOwn(preview, "price_signature"), false); assert.equal(Object.hasOwn(preview, "id"), false);
  }
  assert.equal(signs, 0); assert.equal(issuer.journal, null); assert.equal(fs.existsSync(f.directory), false);
  await f.issue(issuer); const authorized = issuer.journal.db.prepare("SELECT authorized FROM days").get().authorized;
  for (let i = 0; i < 20; i++) await readPreview(f.oracle, f.scope.pricingPolicyHash, () => f.clock.now);
  assert.equal(signs, 1); assert.equal(issuer.journal.db.prepare("SELECT COUNT(*) AS n FROM quotes").get().n, 1);
  assert.equal(issuer.journal.db.prepare("SELECT authorized FROM days").get().authorized, authorized);
  const snapshot = await f.oracle.readEvidence();
  for (const [reader, expected, now] of [
    [f.oracle, hex(999), f.clock.now],
    [{ readEvidence: async () => snapshot }, f.scope.pricingPolicyHash, snapshot.summary.expiresAt],
    [{ readEvidence: async () => snapshot }, f.scope.pricingPolicyHash, snapshot.summary.marketObservedAt - 1],
    [{ readEvidence: async () => ({ ...snapshot, price: { ...snapshot.price, usdPerKoin: "1" } }) }, f.scope.pricingPolicyHash, f.clock.now],
    [{ readEvidence: async () => ({ ...snapshot, summary: { ...snapshot.summary, privateUrl: "https://private.invalid" } }) }, f.scope.pricingPolicyHash, f.clock.now]
  ]) await assert.rejects(readPreview(reader, expected, () => now), e => e.code === "PURCHASE_PRICE_UNAVAILABLE");
});
