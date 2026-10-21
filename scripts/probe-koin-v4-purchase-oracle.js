"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { Signer } = require("koilib");
const { V4PurchaseOracle, parityHash, verifyParity, configuration } = require("../lib/koin-network/v4-purchase-oracle"), { MARKET, purchasePrice } = require("../lib/koin-network/purchase-price");
const hash = n => "0x" + n.toString(16).padStart(64, "0");
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-parity-fixture-")), signer = Signer.fromSeed("isolated-parity-only"), token = Signer.fromSeed("isolated-native-token-only").getAddress();
  const now = 1800000000000, feed = "0x" + "3".repeat(40), clock = { now };
  const config = { schema: 1, rpcUrls: ["https://archive-a.invalid", "https://archive-b.invalid"], usdtFeed: feed, paritySigner: signer.getAddress(), parityFile: path.join(dir, "parity.json"),
    policy: { version: 1, windowSeconds: 60, maxBlockGapSeconds: 12, maxPriceAgeMs: 30000, maxQuoteMs: 20000,
      maxDeviationBps: 100, maxSlippageBps: 100, maxUsdtAgeMs: 20000, maxUsdtDeviationBps: 100, maxParityAgeMs: 20000, maxParityDeviationBps: 100,
      minLiquidity: "1000000000", minProbeUsdtAtoms: "1000000", usdtSource: "ethereum:chainlink:" + feed, paritySource: "isolated:reviewed-parity" } };
  const statement = { schema: 1, nativeChainId: "isolated-native-chain", nativeToken: token, wrappedChainId: 1, wrappedToken: MARKET.wrappedToken,
    wrappedPerNativeAtoms: "100000000", observedAt: now - 1000, validUntil: now + 10000, source: config.policy.paritySource, state: "verified", redemption: "available", evidenceHash: hash(100) };
  const envelope = { statement, signature: Buffer.from(await signer.signHash(parityHash(statement))).toString("base64") };
  fs.writeFileSync(config.parityFile, JSON.stringify(envelope));
  const deployment = { product: "prepaid-usd-v1", chainId: statement.nativeChainId, token };
  const oracle = new V4PurchaseOracle({ config, deployment, clock: () => clock.now, fetchImpl: async () => { throw Error("No live network in this test"); } });
  const blocks = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, hash: hash(i + 1), parentHash: hash(i), timestamp: now / 1000 - 60 + i * 10,
    canonical: true, stateBlockHash: hash(i + 1), depthBlockHash: hash(i + 1), sqrtPriceX96: String(1n << 96n), liquidity: "1000000000000",
    probeUsdtAtoms: "1000000", buyVkoinAtoms: "990000", sellVkoinAtoms: "1000000", sellUsdtAtoms: "990000" }));
  const history = { chainId: 1, protocol: "uniswap-v4", poolId: MARKET.poolId, currency0: MARKET.wrappedToken, currency1: MARKET.quoteToken,
    decimals0: 8, decimals1: 6, fee: 10000, tickSpacing: 200, hooks: "0x" + "0".repeat(40), canonical: true, anchorHash: hash(7), blocks };
  const abi = values => "0x" + values.map(n => BigInt(n).toString(16).padStart(64, "0")).join("");
  const usdt = require("../lib/koin-network/v4-history-reader").usdtObservation({ feed, anchorHash: hash(7), decimals: abi([8]), round: abi([1, 100000000, now / 1000 - 1, now / 1000 - 1, 1]) },
    { feed, source: config.policy.usdtSource, policy: config.policy, anchor: history.blocks.at(-1) });
  let reads = 0;
  oracle.readers = [0, 1].map(() => ({ window: async () => { reads++; return structuredClone(history); }, usdt: async () => structuredClone(usdt), canonical: async () => {} }));
  t.after(async () => { oracle.close(); await oracle.pending?.catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  return { config, deployment, oracle, clock, envelope, history, reads: () => reads };
}
test("fresh signed parity and matching independent archives enable an exact, bounded quote", async t => {
  const f = await fixture(t); await assert.rejects(f.oracle.read(), /warming/); await f.oracle.refresh();
  const q = await f.oracle.read(); assert.equal(q.usdPerKoin, "10000000000"); assert.equal(q.expiresAt, f.clock.now + 10000);
  const snapshot = await f.oracle.readEvidence();
  assert.deepEqual(snapshot.evidence.parityEnvelope, f.envelope);
  assert.equal(snapshot.summary.referenceKind, "signed-parity");
  assert.equal(snapshot.summary.referenceHash, "" + parityHash(f.envelope.statement).toString("hex"));
  assert.equal(f.reads(), 2); await f.oracle.read(); assert.equal(f.reads(), 2, "cached window is rechecked canonically without reloading every block");
  f.oracle.close(); await assert.rejects(f.oracle.read(), /stopped/);
});
test("parity is bound to signer, native chain/token, wrapped token, evidence and expiry", async t => {
  const f = await fixture(t), options = { signer: f.config.paritySigner, source: f.config.policy.paritySource, nativeChainId: f.deployment.chainId, nativeToken: f.deployment.token, now: f.clock.now, maxAgeMs: 20000 };
  assert.equal(verifyParity(f.envelope, options).wrappedPerNativeAtoms, "100000000");
  for (const change of [s => s.wrappedPerNativeAtoms = "100000001", s => s.evidenceHash = hash(102), s => s.nativeChainId = "other", s => s.redemption = "paused", s => s.validUntil = f.clock.now]) {
    const e = structuredClone(f.envelope); change(e.statement); assert.throws(() => verifyParity(e, options));
  }
  assert.throws(() => verifyParity(f.envelope, { ...options, signer: Signer.fromSeed("another-isolated-attestor").getAddress() }), /Signature/);
  assert.throws(() => verifyParity(f.envelope, { ...options, now: f.clock.now + 10001 }), /Fresh/);
});
test("a reorg or failed parity refresh clears cached purchase pricing without a spot fallback", async t => {
  const f = await fixture(t); await f.oracle.refresh();
  f.oracle.readers[0].canonical = async () => { throw Error("reorganized"); };
  await assert.rejects(f.oracle.read(), /reorganized/); await f.oracle.pending?.catch(() => {}); assert.equal(f.oracle.cache, null);
  f.oracle.readers[0].canonical = async () => {}; await f.oracle.refresh();
  fs.writeFileSync(f.config.parityFile, JSON.stringify({ ...f.envelope, statement: { ...f.envelope.statement, wrappedPerNativeAtoms: "99999999" } }));
  await assert.rejects(f.oracle.read(), /Signature/); await f.oracle.pending?.catch(() => {}); assert.equal(f.oracle.cache, null);
});
test("disagreeing archive evidence, duplicate hosts and missing configuration never enable pricing", async t => {
  const f = await fixture(t);
  f.oracle.readers[1].window = async () => ({ ...f.history, anchorHash: hash(999) });
  await assert.rejects(f.oracle.refresh(), /disagree/); assert.equal(f.oracle.cache, null);
  assert.throws(() => configuration({ ...f.config, rpcUrls: ["https://same.invalid/a", "https://same.invalid/b"] }), /independently/);
  const unavailable = purchasePrice({ mode: "mainnet-pilot", reviewed: {}, deployment: f.deployment });
  await assert.rejects(unavailable.read(), e => e.code === "PURCHASE_PRICE_UNAVAILABLE");
});
