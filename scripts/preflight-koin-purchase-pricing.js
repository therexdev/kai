"use strict";
// Operator diagnostics only. No wallet, signing, transaction submission, service
// activation or configuration writes. Use the same read-only adapter as runtime.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { utils } = require("koilib");
const { V4HistoryReader, CONTRACTS } = require("../lib/koin-network/v4-history-reader");
const V = require("../lib/koin-network/v4-price-validation");
const { verifyParity, configuration: pricingConfiguration } = require("../lib/koin-network/v4-purchase-oracle");
const { MARKET } = require("../lib/koin-network/purchase-price");
const MAX_REPORT_BYTES = 32768;
const canonical = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === "object"
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => "0x" + crypto.createHash("sha256").update(canonical(value)).digest("hex");
const sourceHash = () => hash(Object.fromEntries(["v4-history-reader", "v4-price-validation", "v4-purchase-oracle", "purchase-price"].map(name =>
  [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "../lib/koin-network/", name + ".js"))).digest("hex")])));
class InputError extends Error { constructor(code) { super(code); this.code = code; } }
function protectedJson(file, maximum, secret = true) {
  let fd;
  try {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw Error();
    if (!fs.lstatSync(file).isFile()) throw Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum || (secret && process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw Error();
    const data = fs.readFileSync(fd); if (data.length > maximum) throw Error();
    return JSON.parse(data.toString("utf8"));
  } catch { throw new InputError("PROTECTED_JSON_REQUIRED"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function configuration(input) {
  const c = input?.purchasePricing;
  if (!c) throw new InputError("PURCHASE_PRICING_REQUIRED");
  if (c.schema === 2) {
    // Unlike schema-1 capability diagnostics, this explicit commercial reference
    // must identify the native deployment. Never infer it from the market alone.
    try {
      if (!input.deployment?.chainId || !input.deployment?.token) throw Error();
      const pricing = pricingConfiguration(c, input.deployment);
      return { pricing, policy: pricing.policy, deployment: { chainId: input.deployment.chainId, token: input.deployment.token } };
    } catch { throw new InputError("MERCHANT_REFERENCE_CONFIGURATION_REQUIRED"); }
  }
  if (c.schema !== 1 || Object.keys(c).some(k => !["schema", "rpcUrls", "usdtFeed", "policy", "paritySigner", "parityFile"].includes(k))) throw new InputError("PRICING_SCHEMA_INVALID");
  let policy;
  try { policy = V.config(c.policy, "parity"); } catch { throw new InputError("REVIEWED_POLICY_REQUIRED"); }
  if (!Array.isArray(c.rpcUrls) || c.rpcUrls.length !== 2 || c.rpcUrls.some(url => {
    try { const u = new URL(url); return typeof url !== "string" || url.length > 4096 || u.protocol !== "https:" || u.username || u.password || u.hash; }
    catch { return true; }
  }) || new Set(c.rpcUrls.map(url => new URL(url).hostname)).size !== 2) throw new InputError("TWO_DISTINCT_HTTPS_ARCHIVES_REQUIRED");
  if (typeof c.usdtFeed !== "string" || !/^0x[0-9a-f]{40}$/.test(c.usdtFeed) || policy.usdtSource !== "ethereum:chainlink:" + c.usdtFeed) throw new InputError("USDT_FEED_PIN_REQUIRED");
  // Parity is optional for capability diagnostics, but never optional for a
  // complete quote check. Do not replace missing evidence with a synthetic ratio.
  return { pricing: structuredClone(c), policy, deployment: input.deployment && { chainId: input.deployment.chainId, token: input.deployment.token } };
}
function anchorSummary(raw, now) {
  const quantity = value => {
    if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw Error();
    const n = Number(BigInt(value)); if (!Number.isSafeInteger(n) || n < 1) throw Error(); return n;
  };
  if (!/^0x[0-9a-f]{64}$/.test(raw?.hash) || !/^0x[0-9a-f]{64}$/.test(raw?.parentHash)) throw Error();
  const number = quantity(raw.number), timestamp = quantity(raw.timestamp);
  if (!Number.isSafeInteger(timestamp * 1000) || timestamp * 1000 > now) throw Error();
  return { number, hash: raw.hash, timestamp, ageMs: now - timestamp * 1000 };
}
const abs = value => value < 0n ? -value : value;
function deviationBps(value, reference) {
  if (reference <= 0n) return null;
  // Ceiling makes a displayed within-policy result conservative at boundaries.
  return String((abs(value - reference) * 10000n + reference - 1n) / reference);
}
function historySummary(history, policy, now) {
  const rows = history.blocks, last = rows.at(-1), start = last.timestamp - policy.windowSeconds;
  const spots = rows.map(row => V.price(row.sqrtPriceX96));
  let total = 0n, elapsed = 0, maxGapSeconds = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const duration = rows[i + 1].timestamp - Math.max(start, rows[i].timestamp);
    elapsed += duration; total += spots[i] * BigInt(duration);
    maxGapSeconds = Math.max(maxGapSeconds, rows[i + 1].timestamp - rows[i].timestamp);
  }
  if (elapsed <= 0) throw Error();
  const average = total / BigInt(elapsed), maximum = values => values.some(v => v === null) ? null : String(values.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b, "0"));
  const maxPriceDeviationBps = maximum(spots.map(spot => deviationBps(spot, average)));
  const depth = (row, spot, buy) => {
    const expected = buy ? BigInt(row.probeUsdtAtoms) * 100n * V.SCALE * 990000n / (spot * 1000000n)
      : BigInt(row.sellVkoinAtoms) * spot * 990000n / (100n * V.SCALE * 1000000n);
    return deviationBps(BigInt(buy ? row.buyVkoinAtoms : row.sellUsdtAtoms), expected);
  };
  const maxBuyDeviationBps = maximum(rows.map((row, i) => depth(row, spots[i], true)));
  const maxSellDeviationBps = maximum(rows.map((row, i) => depth(row, spots[i], false)));
  const minimumLiquidity = String(rows.reduce((a, row) => a < BigInt(row.liquidity) ? a : BigInt(row.liquidity), BigInt(rows[0].liquidity)));
  const ageMs = now - last.timestamp * 1000;
  const comparisons = {
    anchorFresh: ageMs >= 0 && ageMs <= policy.maxPriceAgeMs,
    fullWindow: elapsed === policy.windowSeconds,
    blockGaps: maxGapSeconds <= policy.maxBlockGapSeconds,
    minimumLiquidity: BigInt(minimumLiquidity) >= BigInt(policy.minLiquidity),
    priceDeviation: maxPriceDeviationBps !== null && BigInt(maxPriceDeviationBps) <= BigInt(policy.maxDeviationBps),
    buyDepth: maxBuyDeviationBps !== null && BigInt(maxBuyDeviationBps) <= BigInt(policy.maxSlippageBps),
    sellDepth: maxSellDeviationBps !== null && BigInt(maxSellDeviationBps) <= BigInt(policy.maxSlippageBps),
  };
  return { blockCount: rows.length, anchor: { number: last.number, hash: last.hash, timestamp: last.timestamp, ageMs },
    windowSeconds: elapsed, maxGapSeconds, minimumLiquidity, probeUsdtAtoms: policy.minProbeUsdtAtoms,
    maxPriceDeviationBps, maxBuyDeviationBps, maxSellDeviationBps, comparisons,
    policyState: Object.values(comparisons).every(Boolean) ? "within-proposed-bounds" : "outside-proposed-bounds", evidenceHash: hash(history) };
}
function usdtSummary(usdt, policy, now) {
  const ageMs = now - usdt.observedAt, depegBps = deviationBps(BigInt(usdt.usdAtoms), 100000000n);
  const comparisons = { fresh: ageMs >= 0 && ageMs <= policy.maxUsdtAgeMs && usdt.validUntil > now,
    deviation: depegBps !== null && BigInt(depegBps) <= BigInt(policy.maxUsdtDeviationBps) };
  return { observedAt: usdt.observedAt, validUntil: usdt.validUntil, ageMs, usdAtoms: usdt.usdAtoms, deviationBps: depegBps,
    comparisons, policyState: Object.values(comparisons).every(Boolean) ? "within-proposed-bounds" : "outside-proposed-bounds", evidenceHash: hash(usdt) };
}
function parityObservation(c, now) {
  const p = c.pricing, d = c.deployment;
  const base = { underlyingEvidenceVerified: false, redemptionVerified: false, publisherVerified: false };
  if (!p.parityFile || !p.paritySigner || !d?.chainId || !d?.token) return { report: { ...base, state: "missing", code: "PARITY_ENVELOPE_AND_IDENTITY_REQUIRED" } };
  try {
    if (typeof d.chainId !== "string" || d.chainId.length > 200 || !utils.isChecksumAddress(d.token)) throw Error();
    // An installed signed public envelope is root:service 0640. It must be a
    // bounded regular file, but does not contain the attestor's private key.
    const envelope = protectedJson(p.parityFile, 8192, false);
    const value = verifyParity(envelope, { signer: p.paritySigner, source: c.policy.paritySource, nativeChainId: d.chainId,
      nativeToken: d.token, now, maxAgeMs: c.policy.maxParityAgeMs });
    return { value, report: { ...base, state: "signature-and-freshness-verified", identityHash: hash({ signer: p.paritySigner, source: c.policy.paritySource, deployment: d }), observedAt: value.observedAt, validUntil: value.validUntil,
      ageMs: now - value.observedAt, envelopeHash: hash(envelope), attestationHash: value.evidenceHash, referencedEvidenceHash: envelope.statement.evidenceHash } };
  } catch { return { report: { ...base, state: "rejected", code: "PARITY_INVALID_STALE_OR_UNREADABLE" } }; }
}
const STAGE_CODES = { endpoint: "ARCHIVE_MAINNET_UNAVAILABLE", finalized: "FINALIZED_ANCHOR_UNAVAILABLE", history: "CANONICAL_HISTORY_OR_DEPTH_UNAVAILABLE", usdt: "USDT_ROUND_UNAVAILABLE", canonical: "ANCHOR_RECHECK_FAILED" };
async function inspectProvider(c, index, { fetchImpl, clock, signal, rpcTimeoutMs }) {
  const result = { provider: index + 1, state: "failed", stages: {} }, started = performance.now();
  const reader = new V4HistoryReader({ rpcUrl: c.pricing.rpcUrls[index], fetchImpl, clock, timeoutMs: rpcTimeoutMs });
  let stage = "endpoint", history, usdt;
  const failures = [], failed = () => failures.push(signal.aborted ? "PREFLIGHT_DEADLINE_OR_CANCELLED" : STAGE_CODES[stage]);
  async function step(name, action) {
    stage = name; const start = performance.now();
    try { const value = await action(); result.stages[name] = { state: "observed", elapsedMs: Math.round(performance.now() - start) }; return value; }
    catch { result.stages[name] = { state: "failed", elapsedMs: Math.round(performance.now() - start), code: STAGE_CODES[name] }; throw Error(); }
  }
  try {
    await step("endpoint", async () => { if (await reader.rpc("eth_chainId", [], signal) !== "0x1") throw Error(); });
    result.finalizedAnchor = await step("finalized", async () => anchorSummary(await reader.rpc("eth_getBlockByNumber", ["finalized", false], signal), clock()));
    result.finalizedAnchor.withinProposedAge = result.finalizedAnchor.ageMs <= c.policy.maxPriceAgeMs;
  } catch { failed(); }
  if (!failures.length) {
    try {
      history = await step("history", () => reader.window(c.policy, signal));
      result.history = historySummary(history, c.policy, clock());
    } catch { failed(); }
    // A too-tight proposed finalized-age limit should still let the operator
    // measure the stablecoin round. Use the actual history anchor when present;
    // otherwise this remains a diagnostic read at the separately observed one.
    const anchor = history?.blocks.at(-1) || result.finalizedAnchor;
    try {
      usdt = await step("usdt", () => reader.usdt({ feed: c.pricing.usdtFeed, source: c.policy.usdtSource, policy: c.policy, anchor, signal }));
      result.usdt = usdtSummary(usdt, c.policy, clock());
    } catch { failed(); }
    try { await step("canonical", () => reader.canonical(anchor, signal)); } catch { failed(); }
  }
  if (failures.length) { result.code = failures[0]; result.codes = [...new Set(failures)]; }
  else result.state = "observed";
  result.elapsedMs = Math.round(performance.now() - started);
  return { report: result, history, usdt };
}
const INPUT_HELP = {
  PROTECTED_JSON_REQUIRED: "Use an absolute regular JSON file owned by the operator with no group/world permissions; no symlink, maximum 64 KiB.",
  PURCHASE_PRICING_REQUIRED: "Add purchasePricing with schema, two archive rpcUrls, usdtFeed and the proposed policy. No mainnet pricing defaults are supplied.",
  PRICING_SCHEMA_INVALID: "Use the purchasePricing schema documented in V4_PURCHASE_PRICING.md.",
  REVIEWED_POLICY_REQUIRED: "Supply every proposed pricing policy field with valid bounds; fixture thresholds are not production policy.",
  TWO_DISTINCT_HTTPS_ARCHIVES_REQUIRED: "Supply two independently reviewed HTTPS archive endpoints on distinct hosts in the protected file.",
  USDT_FEED_PIN_REQUIRED: "Pin the lowercase Ethereum USDT/USD feed and matching ethereum:chainlink:<address> policy source.",
  MERCHANT_REFERENCE_CONFIGURATION_REQUIRED: "Use the exact explicit schema-2 merchant reference and market policy, bound to deployment.chainId and deployment.token. This does not approve or activate that commercial policy.",
};
async function preflight(inputFile, { fetchImpl = fetch, clock = Date.now, signal, timeoutMs = 70000, rpcTimeoutMs = 8000 } = {}) {
  const report = { schema: 1, purpose: "read-only-purchase-pricing-preflight", state: "incomplete", startedAt: clock(), purchasesEnabled: false,
    configurationChanged: false, signed: false, sourceCodeHash: sourceHash(), toolCodeHash: "0x" + crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"), providers: [], limitations: [
      "A single observation does not establish long-term reliability or approve policy thresholds.",
      "Different archive hostnames do not prove independent operators.",
      "A parity signature does not verify underlying backing, redemption availability or a renewal publisher.",
    ] };
  let c;
  try { c = configuration(protectedJson(inputFile, 65536)); }
  catch (error) { const code = Object.hasOwn(INPUT_HELP, error.code) ? error.code : "PRICING_SCHEMA_INVALID";
    return { ...report, state: "input-required", completedAt: clock(), code, action: INPUT_HELP[code] }; }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000 || !Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 1 || rpcTimeoutMs > 30000) throw new InputError("INVALID_DIAGNOSTIC_TIMEOUT");
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  report.policyHash = hash(c.policy);
  report.pricingMode = c.pricing.schema === 2 ? "merchant-exchange-reference" : "attested-parity";
  report.marketSourcesHash = hash({ rpcUrls: c.pricing.rpcUrls, feed: c.pricing.usdtFeed, market: MARKET, contracts: CONTRACTS });
  report.market = { chainId: MARKET.chainId, protocol: MARKET.protocol, poolId: MARKET.poolId };
  // Only hashes leave the tool. Endpoint paths/query strings, source labels,
  // local paths and raw remote/error content may contain credentials.
  const observations = await Promise.all([0, 1].map(index => inspectProvider(c, index, { fetchImpl, clock, signal: deadline, rpcTimeoutMs })));
  report.providers = observations.map(value => value.report);
  const complete = observations.every(value => value.report.state === "observed");
  const matching = complete && canonical(observations[0].history) === canonical(observations[1].history) && canonical(observations[0].usdt) === canonical(observations[1].usdt);
  report.marketEvidence = { state: !complete ? "unavailable" : matching ? "matching" : "disagreement" };
  const merchantReference = c.pricing.schema === 2;
  const parity = merchantReference ? null : parityObservation(c, clock());
  if (merchantReference) {
    report.reference = { state: "explicit-commercial-reference", identityHash: hash(c.pricing.reference),
      bridgeRedemptionVerified: false, underlyingEvidenceVerified: false, commercialPolicyApproved: false };
  } else report.parity = parity.report;
  report.quoteValidation = { state: "not-run", usableForPurchase: false };
  if (matching && (merchantReference || parity.value)) {
    try {
      const quote = V.validate({ policy: c.policy, history: observations[0].history, usdt: observations[0].usdt,
        ...(merchantReference ? { reference: c.pricing.reference, deployment: c.deployment } : { parity: parity.value }), now: clock() });
      report.quoteValidation = { state: "passed-current-runtime-validation", usableForPurchase: false,
        usdPerKoinAtoms: quote.usdPerKoin, observedAt: quote.observedAt, expiresAt: quote.expiresAt, quoteHash: hash(quote),
        ...(quote.maxPurchaseUsdAtoms ? { maxPurchaseUsdAtoms: quote.maxPurchaseUsdAtoms, maxPurchaseKoinAtoms: quote.maxPurchaseKoinAtoms } : {}) };
      report.state = "observations-valid";
    } catch { report.quoteValidation = { state: "rejected", usableForPurchase: false, code: "RUNTIME_PRICING_POLICY_REJECTED" }; }
  }
  report.completedAt = clock();
  if (report.state !== "observations-valid") report.action = !complete ? "Review failed provider stages and measured finalized age before changing any proposed thresholds."
    : !matching ? "Resolve archive disagreement; do not choose one provider or fall back to spot pricing."
      : !merchantReference && !parity.value ? "Market observations are diagnostic only. Supply a reviewed fresh signed parity envelope and identity; the evidence collector/publisher must be established separately."
        : "Observed evidence fails the current runtime policy. Review the measurements; do not relax runtime gates automatically.";
  return report;
}
function serialize(report) {
  const json = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(json) > MAX_REPORT_BYTES) throw Error("REPORT_BOUND_EXCEEDED");
  return json;
}
if (require.main === module) {
  (async () => {
    if (process.argv.length !== 3) {
      process.stdout.write(serialize({ schema: 1, state: "input-required", purchasesEnabled: false, code: "CONFIG_PATH_REQUIRED",
        action: "Usage: node scripts/preflight-koin-purchase-pricing.js /absolute/private/proposal-or-runtime.json" })); process.exitCode = 1; return;
    }
    try { const report = await preflight(process.argv[2]); process.stdout.write(serialize(report)); process.exitCode = report.state === "observations-valid" ? 0 : 1; }
    catch { process.stdout.write(serialize({ schema: 1, state: "failed", purchasesEnabled: false, code: "PREFLIGHT_FAILED" })); process.exitCode = 1; }
  })();
}
module.exports = { preflight, configuration, protectedJson, historySummary, usdtSummary, serialize, hash, MAX_REPORT_BYTES };
