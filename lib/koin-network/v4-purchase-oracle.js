"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { utils } = require("koilib");
const V = require("./v4-price-validation"), { V4HistoryReader } = require("./v4-history-reader"), P = require("./job-protocol"), { MARKET } = require("./purchase-price");
const Provenance = require("./purchase-provenance");
function configuration(value, deployment) {
  const fields = value?.schema === 1 ? "parityFile,paritySigner,policy,rpcUrls,schema,usdtFeed" : "policy,reference,rpcUrls,schema,usdtFeed";
  if (!value || ![1, 2].includes(value.schema) || Object.keys(value).sort().join() !== fields) throw Error("Explicit v4 archive pricing configuration required");
  const c = structuredClone(value); c.policy = V.config(c.policy, c.schema === 1 ? "parity" : "reference");
  if (!Array.isArray(c.rpcUrls) || c.rpcUrls.length !== 2 || c.rpcUrls.some(url => {
    const u = new URL(url); return u.protocol !== "https:" || u.username || u.password || u.hash;
  }) || new Set(c.rpcUrls.map(url => new URL(url).hostname)).size !== 2) throw Error("Two independently reviewed HTTPS archive RPC hosts required");
  if (!/^0x[0-9a-f]{40}$/.test(c.usdtFeed) || c.policy.usdtSource !== "ethereum:chainlink:" + c.usdtFeed) throw Error("Pinned USDT/USD feed required");
  if (c.schema === 1) {
    if (!utils.isChecksumAddress(c.paritySigner) || typeof c.parityFile !== "string" || !path.isAbsolute(c.parityFile)) throw Error("Reviewed parity signer and absolute attestation file required");
  } else c.reference = V.reference(c.reference, deployment);
  return c;
}
function pricingIdentity(value, deployment) {
  const c = configuration(value, deployment);
  return Provenance.digest("KAI-USD-PRICING-POLICY-V1\0" + JSON.stringify(Provenance.canonical({ schema: c.schema, policy: c.policy, market: MARKET,
    native: { chainId: deployment.chainId, token: deployment.token }, usdtFeed: c.usdtFeed,
    ...(c.schema === 2 ? { reference: c.reference } : { paritySigner: c.paritySigner }) })));
}
const parityFields = ["schema", "nativeChainId", "nativeToken", "wrappedChainId", "wrappedToken", "wrappedPerNativeAtoms", "observedAt", "validUntil", "source", "state", "redemption", "evidenceHash"];
function parityHash(statement) {
  if (!statement || Object.keys(statement).sort().join() !== [...parityFields].sort().join()) throw Error("Exact parity attestation required");
  return crypto.createHash("sha256").update("KAI-VKOIN-PARITY-V1\0").update(JSON.stringify(parityFields.map(k => statement[k]))).digest();
}
function verifyParity(envelope, { signer, source, nativeChainId, nativeToken, now, maxAgeMs }) {
  if (!envelope || Object.keys(envelope).sort().join() !== "signature,statement") throw Error("Signed parity envelope required");
  const s = envelope.statement, hash = parityHash(s);
  if (!utils.isChecksumAddress(signer) || s.schema !== 1 || s.nativeChainId !== nativeChainId || s.nativeToken !== nativeToken ||
      s.wrappedChainId !== 1 || s.wrappedToken !== MARKET.wrappedToken || s.source !== source || s.state !== "verified" || s.redemption !== "available" ||
      !/^0x[0-9a-f]{64}$/.test(s.evidenceHash) || typeof s.wrappedPerNativeAtoms !== "string" || !/^[1-9]\d{0,19}$/.test(s.wrappedPerNativeAtoms) ||
      !Number.isSafeInteger(s.observedAt) || !Number.isSafeInteger(s.validUntil) || s.observedAt > now || now - s.observedAt > maxAgeMs || s.validUntil <= now || s.validUntil - s.observedAt > maxAgeMs) throw Error("Fresh verified wrapped/native redemption evidence required");
  P.signatureMatches(hash, envelope.signature, signer);
  return { source: s.source, evidenceHash: "0x" + hash.toString("hex"), observedAt: s.observedAt, validUntil: s.validUntil,
    state: "verified", nativeToken: "KOIN", wrappedToken: s.wrappedToken, wrappedPerNativeAtoms: s.wrappedPerNativeAtoms };
}
class V4PurchaseOracle {
  constructor({ config, deployment, fetchImpl, clock = Date.now }) {
    this.config = configuration(config, deployment); this.deployment = deployment; this.clock = clock;
    this.readers = this.config.rpcUrls.map(rpcUrl => new V4HistoryReader({ rpcUrl, fetchImpl, clock }));
    this.abort = new AbortController(); this.cache = null; this.pending = null;
  }
  parityEvidence() {
    const c = this.config, stat = fs.lstatSync(c.parityFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw Error("Bounded regular parity attestation file required");
    const envelope = JSON.parse(fs.readFileSync(c.parityFile, "utf8"));
    const parity = verifyParity(envelope, { signer: c.paritySigner, source: c.policy.paritySource,
      nativeChainId: this.deployment.chainId, nativeToken: this.deployment.token, now: this.clock(), maxAgeMs: c.policy.maxParityAgeMs });
    return { envelope, parity };
  }
  parity() { return this.parityEvidence().parity; }
  referenceInput() {
    return this.config.schema === 2 ? { reference: this.config.reference, deployment: this.deployment } : { parity: this.parity() };
  }
  async refresh() {
    this.abort.signal.throwIfAborted(); if (this.pending) return this.pending;
    const c = this.config;
    if (this.cache && this.cache.expiresAt - this.clock() > c.policy.maxQuoteMs / 2) return;
    this.pending = (async () => {
      const histories = await Promise.all(this.readers.map(reader => reader.window(c.policy, this.abort.signal)));
      if (JSON.stringify(histories[0]) !== JSON.stringify(histories[1])) throw Error("Independent archive RPC histories disagree");
      const history = histories[0], anchor = history.blocks.at(-1);
      const stable = await Promise.all(this.readers.map(reader => reader.usdt({ feed: c.usdtFeed, source: c.policy.usdtSource, policy: c.policy, anchor, signal: this.abort.signal })));
      if (JSON.stringify(stable[0]) !== JSON.stringify(stable[1])) throw Error("Independent USDT/USD oracle observations disagree");
      await Promise.all(this.readers.map(reader => reader.canonical(anchor, this.abort.signal)));
      const quote = V.validate({ policy: c.policy, history, usdt: stable[0], ...this.referenceInput(), now: this.clock() });
      this.abort.signal.throwIfAborted(); this.cache = { history, usdt: stable[0], expiresAt: quote.expiresAt };
    })().catch(error => { this.cache = null; throw error; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async readEvidence() {
    this.abort.signal.throwIfAborted();
    if (!this.cache) { this.refresh().catch(() => {}); throw Error("Validated purchase pricing is warming up. Existing credits remain usable."); }
    const saved = this.cache, anchor = saved.history.blocks.at(-1);
    try {
      await Promise.all(this.readers.map(reader => reader.canonical(anchor, this.abort.signal)));
      const c = this.config, now = this.clock(), parity = c.schema === 1 ? this.parityEvidence() : null;
      const usdt = require("./v4-history-reader").usdtObservation(saved.usdt.observation, { feed: c.usdtFeed, source: c.policy.usdtSource, policy: c.policy, anchor });
      if (JSON.stringify(Provenance.canonical(usdt)) !== JSON.stringify(Provenance.canonical(saved.usdt))) throw Error("USDT observation differs from validated evidence");
      const referenceInput = parity ? { parity: parity.parity } : { reference: c.reference, deployment: this.deployment };
      const price = V.validate({ policy: c.policy, history: saved.history, usdt: saved.usdt, ...referenceInput, now });
      const pricingPolicyHash = pricingIdentity(c, this.deployment);
      const archived = Provenance.evidence({ schema: 1, validatedAt: now, policy: c.policy, market: MARKET,
        native: { chainId: this.deployment.chainId, token: this.deployment.token },
        archiveProviderHashes: c.rpcUrls.map(url => Provenance.digest(url)), history: saved.history, usdt: saved.usdt,
        ...(parity ? { paritySigner: c.paritySigner, parityEnvelope: parity.envelope, parity: parity.parity } : { reference: c.reference }), price });
      const summary = Provenance.summary({ schema: 1, market: { chainId: MARKET.chainId, protocol: MARKET.protocol, poolId: MARKET.poolId },
        referenceKind: parity ? "signed-parity" : "merchant-exchange-reference", usdPerKoinAtoms: price.usdPerKoin,
        marketObservedAt: price.observedAt, expiresAt: price.expiresAt, windowSeconds: price.windowSeconds, anchorHash: price.anchorHash,
        pricingPolicyHash, referenceHash: parity ? parity.parity.evidenceHash.slice(2) : V.referenceHash(c.reference, c.policy).slice(2),
        maxPurchaseUsdAtoms: price.maxPurchaseUsdAtoms, maxPurchaseKoinAtoms: price.maxPurchaseKoinAtoms });
      return { price, evidence: archived.value, evidenceHash: archived.hash, summary };
    } catch (error) { this.cache = null; this.refresh().catch(() => {}); throw error; }
  }
  async read() { return (await this.readEvidence()).price; }
  close() { this.abort.abort(new Error("Purchase oracle stopped")); this.cache = null; }
}
module.exports = { configuration, pricingIdentity, parityHash, verifyParity, V4PurchaseOracle };
