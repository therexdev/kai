"use strict";
const { FundedReservations } = require("./funded-reservations");
const { SettlementRecovery } = require("./settlement-recovery");
const { RewardClaims } = require("./reward-claims");
const { assertPaymentMode } = require("./payment-mode");
const { integer } = require("./job-protocol");

// Explicit dependency injection for isolated rehearsal drivers only. There is
// no HTTP endpoint, key loader, RPC writer, timer or production registration.
// prepareClaim MUST only sign and return bytes; only submit may transmit them.
// A transport acknowledgment is never treated as chain finality or payment.
class RehearsalSubmitter {
  #mode; #settlements; #observe; #claims; #prepare; #submit; #timeout; #busy = false;
  constructor({ mode, settlements = null, observeSettlement = null, claims = null,
    prepareClaim = null, submit, timeoutMs = 5000, client = null }) {
    if (!["isolated-rehearsal", "test-deployment", "mainnet-pilot"].includes(mode) || typeof submit !== "function" ||
        (!settlements && !claims)) throw Error("Explicit isolated rehearsal transport required");
    if (settlements && (!(settlements instanceof FundedReservations) || typeof observeSettlement !== "function")) throw Error("Funded settlement recovery required");
    if (claims && (!(claims instanceof RewardClaims) || typeof prepareClaim !== "function")) throw Error("Restricted reward claim preparation required");
    if (settlements && claims && settlements.settlementSponsor() === claims.sponsor) throw Error("Claims require a separate sponsor budget and nonce account");
    if (mode !== "isolated-rehearsal") {
      assertPaymentMode(mode, client);
      for (const ledger of [settlements, claims].filter(Boolean)) {
        const target = ledger.deployment();
        for (const key of ["chainId", "credits", "creditsHash", ...(ledger === claims ? ["rewards", "rewardsHash", "token", "tokenHash"] : [])])
          if (target[key] !== client.d[key]) throw Error("Test submitter deployment mismatch");
      }
    }
    if (mode === "isolated-rehearsal" && [settlements, claims].filter(Boolean).some(ledger => ledger.deployment().chainId === require("./payment-network").MAINNET_CHAIN)) throw Error("Mainnet ledger requires explicit mainnet transport");
    this.#mode = mode;
    this.#settlements = settlements && new SettlementRecovery(settlements); this.#observe = observeSettlement;
    this.#claims = claims; this.#prepare = prepareClaim; this.#submit = submit;
    this.#timeout = integer(timeoutMs, 50, 30000);
  }
  async #send(decision) {
    if (decision.action !== "submit_exact_transaction") return decision;
    const { transaction, ...status } = decision;
    const controller = new AbortController(); let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.#submit(structuredClone(transaction), { signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("Submission timeout")); }, this.#timeout); }),
      ]);
      // Ignore claimed receipts/success; only the pinned observer can settle.
      const acknowledged = result?.txId === transaction.id;
      return { ...status, action: "await_finality", submission: acknowledged ? "acknowledged" : "unknown" };
    } catch {
      // Including explicit RPC errors: they do not prove the tx was never sent.
      return { ...status, action: "await_finality", submission: "unknown" };
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async #prepareClaim(decision) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.#prepare(structuredClone(decision), { signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("Claim signing response unavailable; recover its envelope")); }, this.#timeout); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async tick({ settlementIds = [], claimLimit = 1 } = {}) {
    if (this.#busy) return { mode: this.#mode === "mainnet-pilot" ? "mainnet-pilot" : "isolated-rehearsal", paymentsEnabled: this.#mode === "mainnet-pilot", busy: true, results: [] };
    if (!Array.isArray(settlementIds) || settlementIds.length > 16 || new Set(settlementIds).size !== settlementIds.length) throw Error("Bounded distinct settlement IDs required");
    integer(claimLimit, 0, 16);
    if (settlementIds.length && !this.#settlements) throw Error("Settlement service not configured");
    this.#busy = true; const results = [];
    try {
      for (const id of settlementIds) {
        const observationId = await this.#observe(id);
        results.push(await this.#send(await this.#settlements.step({ id, observationId })));
      }
      for (let count = 0; this.#claims && count < claimLimit; count++) {
        const id = this.#claims.next(); if (!id) break;
        let decision = await this.#claims.advance(id);
        if (decision.action === "prepare_claim") {
          // The signing fence is durable before this callback. A lost signing
          // response requires recovery of that envelope, never automatic resign.
          const transaction = await this.#prepareClaim(decision);
          await this.#claims.stage(id, transaction);
          decision = await this.#claims.advance(id);
        }
        results.push(await this.#send(decision));
        if (decision.action !== "done") break;
      }
      return { mode: this.#mode === "mainnet-pilot" ? "mainnet-pilot" : "isolated-rehearsal", paymentsEnabled: this.#mode === "mainnet-pilot", results };
    } finally { this.#busy = false; }
  }
}
module.exports = { RehearsalSubmitter };
