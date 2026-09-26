"use strict";

const { Serializer, utils } = require("koilib");
const ABI = require("./credits-abi.json");
const { address, digest, hash } = require("./metering");
const { uint } = require("./policy");
const { inspectFinality } = require("./finality");

// Encodes the same generated ABI as the Test custody prototype. This adapter
// can observe a transaction, but cannot build/sign/broadcast one or fund a
// grant. Synthetic accounting remains explicitly shadow even after a match.
class ShadowSettlementMonitor {
  constructor(ledger, provider, { chainId, credits, creditsHash }) {
    if (typeof chainId !== "string" || Buffer.from(chainId, "base64").length !== 34 ||
        !/^0x1220[a-f0-9]{64}$/.test(creditsHash)) throw Error("Explicit chain and bytecode pins required");
    this.ledger = ledger; this.provider = provider;
    this.target = Object.freeze({ chainId, credits: address(credits), creditsHash });
    ledger.bindTarget(this.target);
    this.serializer = new Serializer(ABI.types);
  }
  async operation(id) {
    const j = this.ledger.get("jobs", id);
    if (!j.intent || j.intent.mode !== "shadow" || j.intent.domain !== this.ledger.domain ||
        hash(JSON.stringify(j.intent)) !== j.intentHash) throw Error("Invalid prepared intent");
    const c = j.intent.charge, charge = {};
    for (const key of ["id", "session_id", "policy_hash", "receipt_hash"]) {
      charge[key] = utils.encodeBase64url(Buffer.from(digest(c[key]), "hex"));
    }
    charge.provider = utils.encodeBase64url(utils.decodeBase58(address(c.provider)));
    for (const key of ["amount", "dispatched_at", "nonce"]) charge[key] = uint(c[key]).toString();
    const bytes = await this.serializer.serialize({ charge }, "koin.Request");
    return { contract_id: this.target.credits, entry_point: ABI.methods.settle.entry_point,
      args: utils.encodeBase64url(bytes) };
  }
  async reconcile(id) {
    const j = this.ledger.get("jobs", id);
    if (j.state === "settled") return { state: "settled", mode: "shadow", paymentsEnabled: false };
    if (j.state !== "submitted") throw Error("No submitted transaction to inspect");
    const metadata = await this.provider.invokeGetContractMetadata(this.target.credits);
    if (metadata.value?.hash !== this.target.creditsHash || metadata.value.authorizes_call_contract ||
        metadata.value.authorizes_transaction_application || metadata.value.authorizes_upload_contract) throw Error("Credits bytecode or authority changed");
    const evidence = await inspectFinality(this.provider, { chainId: this.target.chainId,
      txId: j.txId, expectedOperation: await this.operation(id) });
    if (evidence.state === "finalized") this.ledger.confirmSimulation(id, j.intentHash, evidence);
    // Unknown, forked, pending and reverted transactions retain the hold for
    // explicit recovery. This monitor never invents a replacement tx/nonce.
    return { ...evidence, mode: "shadow", paymentsEnabled: false };
  }
}
module.exports = { ShadowSettlementMonitor };
