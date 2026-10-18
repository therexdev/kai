"use strict";
const { encodedAddress } = require("./chain"), { utils } = require("koilib");
const { inspectFinality } = require("./finality"), P = require("./job-protocol"), T = require("./rpc-transport");
const enc = hex => utils.encodeBase64url(Buffer.from(hex, "hex"));
// Backend accounting only. Neither this queue nor a failed payout can hold or
// restore customer credits. A confirmed answer has exactly one usage ID.
class PrepaidSettlement {
  constructor({ client, ledger, signing, config, clock = Date.now }) { Object.assign(this, { client, ledger, signing, config, clock }); }
  async tick() {
    const { client: c, ledger: l, signing: s, config } = this;
    await s.reconcile();
    let inspected = 0;
    for (const j of l.pendingJobs()) {
      const id = P.hash("prepaid-usage:" + j.id), prior = s.statusFor(id);
      if (!l.rewardEligible(j, j.provider)) { l.settlement(j.id, { state: "needs_review", reason: "customer_provider_ownership" }); continue; }
      if (prior?.state === "reverted") { l.settlement(j.id, { state: "needs_review", reason: "settlement_reverted" }); continue; }
      if (j.settlement.attempts >= 3 && j.settlement.state !== "needs_review") l.settlement(j.id, { state: "needs_review", reason: "attempt_limit" });
      if (prior?.state !== "finalized" && (j.settlement.state === "needs_review" || j.settlement.attempts >= 3)) continue;
      if (++inspected > 32) break;
      // Persist fair retry order before reads/signing: capacity waits and read
      // failures cannot monopolize every bounded pass, even after restart.
      l.rotateSettlement(j.id);
      if (prior?.state === "finalized") {
        const tx = s.envelope(id), proof = await inspectFinality(c.provider, { chainId: c.d.chainId, txId: tx.id, expectedOperation: tx.operations[0].call_contract });
        if (proof.state === "finalized") l.settlement(j.id, { state: "finalized", txId: tx.id, finality: proof });
        continue;
      }
      if (s.status().some(r => r.id !== id && r.owner === c.d.verifier && ["signing", "signed"].includes(r.state))) return;
      const unified = j.settlement.kind === "unified-usage", paid = j.funding?.paidUsed ?? j.receipt.usage.amount;
      if (unified && (!require("./product").isUsd(c.d) || !j.funding || BigInt(paid) + BigInt(j.funding.freeUsed) !== BigInt(j.receipt.usage.amount))) throw Error("Unified usage accounting mismatch");
      if (unified && !await require("./sponsor-headroom").sponsorHeadroom({ client: c, ledger: l, job: j, clock: this.clock })) { l.settlement(j.id, { state: "capacity_wait", reason: "sponsor_daily_headroom_or_unreconciled_work" }); continue; }
      const operation = await c.operation("credits", unified ? "settle_credit_usage" : "settle_usage", {
        ...(!j.owner.startsWith("account-") ? { account: encodedAddress(j.owner) } : {}),
        ...(unified ? { id: enc(P.digest(j.funding.accountId)), amount: paid } : {}), charge: {
          id: enc(j.id), provider: encodedAddress(j.provider), receipt_hash: enc(j.receiptHash), policy_hash: enc(j.quote.policyHash), amount: unified ? j.receipt.usage.amount : paid,
        } });
      const tx = await s.prepare(id, { operation, owner: c.d.verifier, payer: config.roles.settlement,
        maxRc: config.maxRcPerTransaction, signers: [c.d.verifier, config.roles.settlement] });
      if (await T.resourceReadiness(c, tx)) return;
      if (j.settlement.lastAttempt && this.clock() < j.settlement.lastAttempt + 30000) return;
      const today = Math.floor(this.clock() / 86400000);
      // Include unconfirmed attempts in the resource budget, not just receipts.
      const used = l.jobs().flatMap(h => h.settlement?.resources || []).filter(r => r.day === today).reduce((n, r) => n + BigInt(r.limit), 0n);
      if (used + BigInt(tx.header.rc_limit) > BigInt(config.maxRcPerDay)) return;
      l.settlement(j.id, { state: "submitted", txId: tx.id, attempts: j.settlement.attempts + 1, lastAttempt: this.clock(),
        resources: [...(j.settlement.resources || []), { day: today, limit: tx.header.rc_limit }] });
      try { await T.submitter(c)(tx, { signal: AbortSignal.timeout(30000) }); }
      catch { /* Reconcile exact signed bytes next time, never create a new charge. */ }
      return;
    }
  }
}
module.exports = { PrepaidSettlement };
