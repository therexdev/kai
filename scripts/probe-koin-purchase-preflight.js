"use strict";
// All archive traffic is redirected to this process's loopback fixture. The
// only signer is the existing deterministic install-test identity, never a key
// from the operator, application profile, environment or a deployed service.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { Signer } = require("koilib");
const { preflight, serialize, MAX_REPORT_BYTES } = require("./preflight-koin-purchase-pricing");
const { CONTRACTS, SELECTOR } = require("../lib/koin-network/v4-history-reader");
const { parityHash } = require("../lib/koin-network/v4-purchase-oracle");
const { MARKET } = require("../lib/koin-network/purchase-price");
const hex = n => "0x" + BigInt(n).toString(16), digest = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const abi = values => "0x" + values.map(n => BigInt(n).toString(16).padStart(64, "0")).join("");
const write = (file, value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
const PRIVATE_MARKER = "DO_NOT_REPORT_OPERATOR_CREDENTIAL";

async function fixture(t, { parity = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-pricing-preflight-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = 1800000000000, feed = "0x" + "3".repeat(40), calls = [], flags = [{}, {}];
  const input = { deployment: { chainId: "isolated-preflight-chain", token: Signer.fromSeed("isolated-install-native-token").getAddress() }, purchasePricing: {
    schema: 1, rpcUrls: ["a", "b"].map(host => `https://archive-${host}.invalid/${PRIVATE_MARKER}?apiKey=${PRIVATE_MARKER}`), usdtFeed: feed,
    policy: { version: 1, windowSeconds: 60, maxBlockGapSeconds: 12, maxPriceAgeMs: 30000, maxQuoteMs: 20000,
      maxDeviationBps: 100, maxSlippageBps: 100, maxUsdtAgeMs: 20000, maxUsdtDeviationBps: 100, maxParityAgeMs: 20000, maxParityDeviationBps: 100,
      minLiquidity: "1000000000", minProbeUsdtAtoms: "1000000", usdtSource: "ethereum:chainlink:" + feed, paritySource: "isolated:" + PRIVATE_MARKER },
  } };
  const inputFile = path.join(directory, PRIVATE_MARKER + ".json");
  if (parity) {
    const signer = Signer.fromSeed("isolated-install-parity-signer");
    const statement = { schema: 1, nativeChainId: input.deployment.chainId, nativeToken: input.deployment.token, wrappedChainId: 1,
      wrappedToken: MARKET.wrappedToken, wrappedPerNativeAtoms: "100000000", observedAt: now - 1000, validUntil: now + 10000,
      source: input.purchasePricing.policy.paritySource, state: "verified", redemption: "available", evidenceHash: digest(100) };
    input.purchasePricing.paritySigner = signer.getAddress();
    input.purchasePricing.parityFile = path.join(directory, "supplied-parity.json");
    write(input.purchasePricing.parityFile, { statement, signature: Buffer.from(await signer.signHash(parityHash(statement))).toString("base64") });
  }
  write(inputFile, input);
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const provider = Number(req.url.slice(1)), flag = flags[provider], q = JSON.parse(body); calls.push({ provider, ...q });
    if (flag.hang) return;
    if (flag.error) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { message: PRIVATE_MARKER } })); return; }
    if (flag.malformed) { res.writeHead(200, { "content-type": "application/json" }); res.end("malformed " + PRIVATE_MARKER); return; }
    const end = now / 1000 - (flag.ageSeconds || 0); let result;
    if (q.method === "eth_chainId") result = flag.wrongChain ? "0x2" : "0x1";
    else if (/^eth_getBlockBy/.test(q.method)) {
      const n = q.params[0] === "finalized" ? 7 : Number(BigInt(q.params[0]));
      result = { number: hex(n), timestamp: hex(end - 70 + n * 10), hash: digest(n), parentHash: digest(n - 1) };
    } else if (q.method === "eth_call") {
      const [{ to, data }, anchor] = q.params;
      assert.equal(anchor.requireCanonical, true); assert.match(anchor.blockHash, /^0x[0-9a-f]{64}$/);
      const selector = data.slice(0, 10);
      if (selector === SELECTOR.manager) result = abi([CONTRACTS.manager]);
      else if (selector === SELECTOR.decimals) result = abi([to === MARKET.quoteToken ? 6 : 8]);
      else if (selector === SELECTOR.slot) { assert.equal(data.slice(10), MARKET.poolId.slice(2)); result = abi([1n << 96n, 0, 0, 10000]); }
      else if (selector === SELECTOR.liquidity) result = abi([flag.liquidity ?? 10n ** 20n]);
      else if (selector === SELECTOR.quote) {
        const w = Array.from({ length: 10 }, (_, i) => BigInt("0x" + data.slice(10 + i * 64, 74 + i * 64)));
        assert.deepEqual(w.slice(0, 6), [32n, BigInt(MARKET.wrappedToken), BigInt(MARKET.quoteToken), 10000n, 200n, 0n]);
        assert.ok(w[6] === 0n || w[6] === 1n); assert.equal(w[8], 256n); assert.equal(w[9], 0n);
        result = abi([w[7] * (flag.depthBps ?? 9900n) / 10000n, 100000]);
      } else if (selector === SELECTOR.round) result = abi([1, flag.usdtAtoms ?? 100000000, end - 10, end - 10, 1]);
      else throw Error("Unexpected fixture call selector");
    } else throw Error("A non-read RPC method was attempted");
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const fetchImpl = async (url, request) => {
    const provider = input.purchasePricing.rpcUrls.indexOf(url); assert.notEqual(provider, -1, "no unconfigured endpoint may be requested");
    assert.equal(request.method, "POST"); assert.equal(request.redirect, "error");
    return fetch(`http://127.0.0.1:${server.address().port}/${provider}`, request);
  };
  const run = options => preflight(inputFile, { fetchImpl, clock: () => now, timeoutMs: 5000, rpcTimeoutMs: 2000, ...options });
  const snapshot = () => Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), st = fs.lstatSync(file);
    return [name, { bytes: fs.readFileSync(file).toString("hex"), mode: st.mode, mtimeMs: st.mtimeMs, uid: st.uid, gid: st.gid }];
  }));
  const safeReport = report => {
    const text = serialize(report);
    assert.ok(Buffer.byteLength(text) < MAX_REPORT_BYTES);
    for (const forbidden of [PRIVATE_MARKER, directory, "archive-a.invalid", "archive-b.invalid", input.purchasePricing.policy.paritySource]) assert.ok(!text.includes(forbidden), "private source material must not appear in reports");
    assert.equal(report.purchasesEnabled, false); assert.equal(report.configurationChanged, false); assert.equal(report.signed, false);
    assert.ok(calls.every(c => ["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_call"].includes(c.method)));
  };
  return { directory, input, inputFile, now, flags, calls, run, snapshot, safeReport, save: () => write(inputFile, input) };
}

test("matching real archive transport reports measurements but missing parity cannot authorize a purchase", async t => {
  const f = await fixture(t), before = f.snapshot(), report = await f.run();
  assert.equal(report.state, "incomplete"); assert.equal(report.marketEvidence.state, "matching");
  assert.equal(report.parity.state, "missing"); assert.equal(report.quoteValidation.state, "not-run");
  for (const provider of report.providers) {
    assert.equal(provider.state, "observed"); assert.equal(provider.history.blockCount, 7);
    assert.equal(provider.history.windowSeconds, 60); assert.equal(provider.history.maxGapSeconds, 10);
    assert.equal(provider.history.maxBuyDeviationBps, "0"); assert.equal(provider.history.maxSellDeviationBps, "0");
    assert.equal(provider.history.policyState, "within-proposed-bounds"); assert.equal(provider.usdt.usdAtoms, "100000000");
  }
  assert.equal(f.calls.filter(c => c.method === "eth_call" && c.params[0].data.startsWith(SELECTOR.quote)).length, 28);
  f.safeReport(report); assert.deepEqual(f.snapshot(), before);
});

test("a supplied isolated parity envelope permits runtime validation without activation, signing, or config writes", async t => {
  const f = await fixture(t, { parity: true }), before = f.snapshot();
  t.mock.method(Signer.prototype, "signHash", () => { throw Error("Preflight must never sign"); });
  const report = await f.run();
  assert.equal(report.state, "observations-valid"); assert.equal(report.quoteValidation.state, "passed-current-runtime-validation");
  assert.equal(report.quoteValidation.usdPerKoinAtoms, "10000000000"); assert.equal(report.quoteValidation.usableForPurchase, false);
  assert.equal(report.parity.state, "signature-and-freshness-verified");
  assert.equal(report.parity.underlyingEvidenceVerified, false); assert.equal(report.parity.redemptionVerified, false); assert.equal(report.parity.publisherVerified, false);
  f.safeReport(report); assert.deepEqual(f.snapshot(), before);
});

test("unprotected, linked, malformed and malicious configuration fails before any archive request", async t => {
  const f = await fixture(t);
  fs.chmodSync(f.inputFile, 0o644); assert.equal((await f.run()).code, "PROTECTED_JSON_REQUIRED"); fs.chmodSync(f.inputFile, 0o600);
  const link = path.join(f.directory, "linked.json"); fs.symlinkSync(f.inputFile, link);
  const linked = await preflight(link, { fetchImpl: () => { throw Error("unexpected egress"); } }); assert.equal(linked.code, "PROTECTED_JSON_REQUIRED");
  write(f.inputFile, '{"purchasePricing":"' + PRIVATE_MARKER); assert.equal((await f.run()).code, "PROTECTED_JSON_REQUIRED");
  for (const url of [`https://user:${PRIVATE_MARKER}@archive-a.invalid`, `https://archive-a.invalid/#${PRIVATE_MARKER}`, `http://archive-a.invalid/${PRIVATE_MARKER}`, PRIVATE_MARKER]) {
    f.input.purchasePricing.rpcUrls[0] = url; f.save(); const report = await f.run(); assert.equal(report.code, "TWO_DISTINCT_HTTPS_ARCHIVES_REQUIRED"); f.safeReport(report);
  }
  assert.equal(f.calls.length, 0);
});

test("remote error text, malformed bodies and fetch exceptions remain redacted per provider", async t => {
  const f = await fixture(t); f.flags[0].error = true;
  let report = await f.run(); assert.equal(report.providers[0].state, "failed"); assert.equal(report.providers[1].state, "observed");
  assert.equal(report.marketEvidence.state, "unavailable"); assert.equal(report.providers[0].code, "ARCHIVE_MAINNET_UNAVAILABLE"); f.safeReport(report);
  f.flags[0].error = false; f.flags[0].malformed = true; report = await f.run(); f.safeReport(report);
  report = await f.run({ fetchImpl: async () => { throw Error(PRIVATE_MARKER + " " + f.inputFile); } });
  assert.ok(report.providers.every(p => p.state === "failed")); f.safeReport(report);
});

test("different archive history or oracle evidence is reported as disagreement, never chosen or averaged", async t => {
  const f = await fixture(t, { parity: true }); f.flags[1].liquidity = 10n ** 20n + 1n;
  let report = await f.run(); assert.equal(report.marketEvidence.state, "disagreement"); assert.equal(report.quoteValidation.state, "not-run"); f.safeReport(report);
  delete f.flags[1].liquidity; f.flags[1].usdtAtoms = 100000001;
  report = await f.run(); assert.equal(report.marketEvidence.state, "disagreement"); assert.equal(report.quoteValidation.state, "not-run"); f.safeReport(report);
});

test("stale finalized anchors retain their actual observed age and fail the history stage", async t => {
  const f = await fixture(t); for (const flag of f.flags) flag.ageSeconds = 900;
  const report = await f.run();
  for (const provider of report.providers) {
    assert.equal(provider.finalizedAnchor.ageMs, 900000); assert.equal(provider.finalizedAnchor.withinProposedAge, false);
    assert.equal(provider.stages.finalized.state, "observed"); assert.equal(provider.stages.history.state, "failed");
    assert.equal(provider.code, "CANONICAL_HISTORY_OR_DEPTH_UNAVAILABLE");
  }
  assert.equal(report.quoteValidation.state, "not-run"); f.safeReport(report);
});

test("matching but depegged, shallow or non-executable depth evidence remains outside proposed bounds", async t => {
  const f = await fixture(t, { parity: true });
  for (const [field, value, section, comparison] of [["usdtAtoms", 95000000, "usdt", "deviation"],
    ["liquidity", 1n, "history", "minimumLiquidity"], ["depthBps", 9000n, "history", "buyDepth"]]) {
    for (const flag of f.flags) flag[field] = value;
    const report = await f.run(); assert.equal(report.marketEvidence.state, "matching");
    assert.equal(report.quoteValidation.state, "rejected"); assert.equal(report.state, "incomplete");
    for (const provider of report.providers) { assert.equal(provider[section].comparisons[comparison], false); assert.equal(provider[section].policyState, "outside-proposed-bounds"); }
    f.safeReport(report); for (const flag of f.flags) delete flag[field];
  }
});

test("invalid or stale supplied parity never invents a ratio or a publisher", async t => {
  const f = await fixture(t, { parity: true });
  const envelope = JSON.parse(fs.readFileSync(f.input.purchasePricing.parityFile, "utf8"));
  envelope.statement.validUntil = f.now; write(f.input.purchasePricing.parityFile, envelope);
  let report = await f.run(); assert.equal(report.parity.state, "rejected"); assert.equal(report.quoteValidation.state, "not-run"); f.safeReport(report);
  write(f.input.purchasePricing.parityFile, PRIVATE_MARKER); report = await f.run();
  assert.equal(report.parity.code, "PARITY_INVALID_STALE_OR_UNREADABLE"); f.safeReport(report);
});

test("overall and per-RPC deadlines stop requests without publishing raw abort errors", async t => {
  const f = await fixture(t); for (const flag of f.flags) flag.hang = true;
  let report = await f.run({ timeoutMs: 80, rpcTimeoutMs: 1000 });
  assert.equal(report.marketEvidence.state, "unavailable"); assert.ok(report.providers.every(p => p.code === "PREFLIGHT_DEADLINE_OR_CANCELLED")); f.safeReport(report);
  report = await f.run({ timeoutMs: 1000, rpcTimeoutMs: 80 });
  assert.ok(report.providers.every(p => p.stages.endpoint.state === "failed")); f.safeReport(report);
  const before = f.calls.length, abort = new AbortController(); abort.abort(Error(PRIVATE_MARKER));
  report = await f.run({ signal: abort.signal }); assert.equal(f.calls.length, before); f.safeReport(report);
});
