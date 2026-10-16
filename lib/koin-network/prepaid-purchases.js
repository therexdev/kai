"use strict";
const { FundingObserver } = require("./funding-observer"), { encodedAddress } = require("./chain");
class PrepaidPurchases {
  constructor(client, ledger, { clock = Date.now } = {}) {
    if (client.d.product !== "prepaid-v1") throw Error("Prepaid deployment required");
    this.client = client; this.ledger = ledger; this.observer = new FundingObserver(client, { clock });
  }
  async inspect(id, owner) {
    const c = this.client, found = await c.provider.getTransactionsById([id]);
    if (!found || found.error || found.rpc_error || !Array.isArray(found.transactions || [])) throw Error("Purchase lookup unavailable");
    const matches = (found.transactions || []).filter(r => r.transaction?.id === id);
    if (!matches.length) return { state: "pending" };
    if (matches.length !== 1) throw Error("Ambiguous purchase lookup");
    const tx = matches[0].transaction, op = tx.operations?.[1]?.call_contract;
    if (tx.operations?.length !== 2 || !op || op.contract_id !== c.d.credits || op.entry_point !== c.abis.credits.methods.purchase.entry_point)
      return { state: "invalid" };
    const args = await c.serializer.deserialize(op.args, "koin.Request");
    if (args.account !== encodedAddress(owner) || tx.header.payer !== owner) return { state: "invalid" };
    const intent = { kind: "credits", method: "purchase", args, actor: owner, maxRc: tx.header.rc_limit };
    const proof = await this.observer.finality(tx, intent);
    return { ...proof, owner, amount: args.amount };
  }
  async tick() {
    for (const p of this.ledger.pendingPurchases()) {
      try {
        const proof = await this.inspect(p.id, p.owner);
        if (proof.state === "finalized") this.ledger.confirmPurchase(p.id, proof);
        else if (["invalid", "reverted"].includes(proof.state)) this.ledger.rejectPurchase(p.id, proof.state);
      } catch { /* A node outage leaves just this purchase pending, never existing credits. */ }
    }
  }
}
module.exports = { PrepaidPurchases };
