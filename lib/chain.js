"use strict";

const crypto = require("crypto");
const { Provider, Contract, Signer, utils } = require("koilib");

/*
 * Koinos chain client — mounted into the koinosai.com website (mirrored from
 * therexdev/kaiapp server/chain.js — keep in sync).
 * M2 settlement (§20), against the Foundation
 * testnet (koinos/koinos-testnet). Alpha anchoring is contract-free ("v0"):
 * the epoch's Merkle root is committed by transferring 1 satoshi of vKOIN to
 * an address DERIVED FROM THE ROOT (base58check of ripemd160(sha256(root))).
 * Anyone can recompute root -> address and find the transfer on-chain, so
 * the commitment is publicly verifiable with zero deployed contracts. The
 * real KAI token + claim contract replaces this in the next increment; the
 * anchor interface stays the same.
 */

/*
 * Network presets. Selected with KAI_CHAIN (foundation-testnet | harbinger |
 * mainnet); every field is individually overridable with KAI_RPC_URL /
 * KAI_CHAIN_ID / KAI_KOIN_CONTRACT so a preset never blocks a live fix.
 * assertChain() fails closed on any mismatch, so a wrong preset can't spend
 * a single satoshi against the wrong network — worst case is a refused boot.
 *
 * HARBINGER NOTE: chainId/koinContract below are pinned from the live
 * [chaincheck] CI probe (core/scripts/chain-probe.js in kaiapp) — if the
 * probe ever disagrees, the probe is right; update these.
 */
const NETWORKS = {
  "foundation-testnet": {
    rpc: "https://testnet.koinosfoundation.org/jsonrpc",
    chainId: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==",
    koinContract: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju",
    faucet: "https://t.me/KoinosTestnetFaucetBot",
  },
  harbinger: {
    rpc: "https://harbinger-api.koinos.io",
    chainId: null, // pinned by the [chaincheck] probe before first use; assertChain refuses null
    koinContract: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju",
    faucet: "Koinos Discord #faucet ($faucet <address>)",
  },
  mainnet: {
    rpc: "https://api.koinos.io",
    chainId: null, // same rule: pin from the probe, never from memory
    koinContract: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK",
  },
};

function networkPreset() {
  const name = process.env.KAI_CHAIN || "foundation-testnet";
  const base = NETWORKS[name];
  if (!base) throw new Error(`Unknown KAI_CHAIN: ${name} (know: ${Object.keys(NETWORKS).join(", ")})`);
  return {
    name,
    rpc: process.env.KAI_RPC_URL || base.rpc,
    chainId: process.env.KAI_CHAIN_ID || base.chainId,
    koinContract: process.env.KAI_KOIN_CONTRACT || base.koinContract,
    faucet: base.faucet,
  };
}

const TESTNET = NETWORKS["foundation-testnet"]; // legacy export; callers predate presets

/** Deterministic address commitment for a hex Merkle root. */
function rootToAnchorAddress(rootHex) {
  if (!/^[0-9a-f]{64}$/i.test(String(rootHex))) throw new Error("root must be 32 bytes of hex");
  const sha = crypto.createHash("sha256").update(Buffer.from(rootHex, "hex")).digest();
  const h160 = crypto.createHash("ripemd160").update(sha).digest();
  const payload = Buffer.concat([Buffer.from([0x00]), h160]);
  const check = crypto
    .createHash("sha256")
    .update(crypto.createHash("sha256").update(payload).digest())
    .digest()
    .subarray(0, 4);
  return utils.encodeBase58(Buffer.concat([payload, check]));
}

class ChainClient {
  constructor({ rpc, chainId, koinContract, wif, onEvent } = {}) {
    const preset = networkPreset();
    this.network = preset.name;
    this.rpc = rpc || preset.rpc;
    this.expectedChainId = chainId || preset.chainId;
    this.onEvent = onEvent || (() => {});
    this.provider = new Provider([this.rpc]);
    this.signer = wif ? Signer.fromWif(wif) : null;
    if (this.signer) this.signer.provider = this.provider;
    this.koin = new Contract({
      id: koinContract || preset.koinContract,
      abi: utils.tokenAbi,
      provider: this.provider,
      signer: this.signer ?? undefined,
    });
  }

  get address() {
    return this.signer ? this.signer.getAddress() : null;
  }

  async headInfo() {
    return this.provider.getHeadInfo();
  }

  /** Fails loudly if the RPC is a different chain than configured (§20 safety).
   *  A null expectation refuses too: an unpinned preset (harbinger before the
   *  probe ran) must never be treated as "anything goes". */
  async assertChain() {
    if (!this.expectedChainId) {
      throw new Error(
        `No chain id pinned for ${this.network} — run the [chaincheck] probe and set KAI_CHAIN_ID (or pin the preset)`
      );
    }
    const id = await this.provider.getChainId();
    if (id !== this.expectedChainId) {
      throw new Error(`RPC chain id mismatch: got ${id}, expected ${this.expectedChainId}`);
    }
    return id;
  }

  async balanceOf(address) {
    const { result } = await this.koin.functions.balanceOf({ owner: address });
    return BigInt(result?.value ?? 0);
  }

  /**
   * Anchor an epoch root on-chain (v0 address-commitment). Needs a funded
   * operator key — the Telegram faucet dispenses vKOIN (see TESTNET.faucet).
   */
  async anchorRoot(epoch, rootHex) {
    if (!this.signer) throw new Error("Anchoring needs an operator key (KAI_OPERATOR_WIF)");
    await this.assertChain();
    const anchorAddress = rootToAnchorAddress(rootHex);
    const { transaction } = await this.koin.functions.transfer(
      { from: this.signer.getAddress(), to: anchorAddress, value: "1" },
      { rcLimit: "100000000" }
    );
    await transaction.wait("byBlock", 60000).catch(() => {
      /* mined-wait is best effort; the id is valid once accepted */
    });
    const record = { epoch, root: rootHex, anchorAddress, txId: transaction.id, rpc: this.rpc };
    this.onEvent({ type: "settlement:anchored", ...record });
    return record;
  }

  /** Verify an anchor independently: recompute the address, check it holds the dust. */
  async verifyAnchor(rootHex) {
    const anchorAddress = rootToAnchorAddress(rootHex);
    const balance = await this.balanceOf(anchorAddress);
    return { anchorAddress, anchored: balance > 0n, balance: balance.toString() };
  }
}

/**
 * Bindings for the deployed KAI settlement contract (contracts/kai). The
 * contract lives at the operator's address (Koinos uploads to the signer).
 */
class KaiContract {
  constructor({ chain, contractId, abiPath }) {
    const { Contract } = require("koilib");
    const abi = JSON.parse(require("fs").readFileSync(
      abiPath || require("path").join(__dirname, "..", "contracts", "kai", "abi", "kai-abi.json"), "utf8"));
    // The AS-SDK ABI dialect (entryPoint/input/output/readOnly) predates
    // koilib's (entry_point/argument/return/read_only) — normalize both ways.
    for (const m of Object.values(abi.methods)) {
      m.entry_point = m.entry_point ?? m.entryPoint;
      m.argument = m.argument ?? m.input;
      m.return = m.return ?? m.output;
      m.read_only = m.read_only ?? m.readOnly ?? m["read-only"] ?? false;
    }
    this.chain = chain;
    this.contract = new Contract({
      id: contractId || chain.address,
      abi,
      provider: chain.provider,
      signer: chain.signer ?? undefined,
    });
  }

  /** Upload contracts/kai/build/kai.wasm to the operator's address. */
  async deploy(wasmPath) {
    const fs = require("fs");
    const path = require("path");
    this.contract.bytecode = fs.readFileSync(
      wasmPath || path.join(__dirname, "..", "contracts", "kai", "build", "kai.wasm"));
    const { transaction } = await this.contract.deploy({ rcLimit: "1000000000" });
    await transaction.wait("byBlock", 60000).catch(() => {});
    return { txId: transaction.id, contractId: this.contract.getId() };
  }

  async submitRoot(epoch, rootHex) {
    const { transaction } = await this.contract.functions.submit_root(
      { epoch: String(epoch), root: Buffer.from(rootHex, "hex").toString("base64url") },
      { rcLimit: "600000000" });
    await transaction.wait("byBlock", 60000).catch(() => {});
    return { txId: transaction.id };
  }

  async getRoot(epoch) {
    const { result } = await this.contract.functions.get_root({ epoch: String(epoch) });
    return result?.value ? Buffer.from(result.value, "base64url").toString("hex") : null;
  }

  /** Claim on behalf of a worker — permissionless push; operator pays MANA (§21 spirit). */
  async claim(epoch, worker, { count, index, proof }) {
    const { transaction } = await this.contract.functions.claim(
      {
        epoch: String(epoch),
        worker,
        count: String(count),
        index: String(index),
        proof: proof.map((h) => Buffer.from(h, "hex").toString("base64url")),
      },
      { rcLimit: "600000000" });
    await transaction.wait("byBlock", 60000).catch(() => {});
    return { txId: transaction.id };
  }

  /** Amendment A1 value claim: mints exactly `amount` satoshis to the worker. */
  async claimValue(epoch, worker, { amount, index, proof }) {
    const { transaction } = await this.contract.functions.claim_value(
      {
        epoch: String(epoch),
        worker,
        amount: String(amount),
        index: String(index),
        proof: proof.map((h) => Buffer.from(h, "hex").toString("base64url")),
      },
      { rcLimit: "600000000" });
    await transaction.wait("byBlock", 60000).catch(() => {});
    return { txId: transaction.id };
  }

  async kaiBalance(addressB58) {
    const { Signer } = require("koilib");
    void Signer;
    const { result } = await this.contract.functions.balance_of({ owner: addressB58 });
    return BigInt(result?.value ?? 0);
  }
}

/**
 * Settlement adapter for the scheduler (§20–§22): submit the epoch root and
 * push every worker's claim, idempotently — re-running skips whatever is
 * already on-chain. The operator key signs and pays MANA; workers receive KAI.
 */
function makeSettlement({ wif, contractId, rpc, abiPath } = {}) {
  const chain = new ChainClient({ wif, rpc });
  const kai = new KaiContract({ chain, contractId, abiPath });
  let checked = false;
  const ready = async () => {
    if (!checked) {
      await chain.assertChain(); // fail closed on wrong network (§27 spirit)
      checked = true;
    }
  };
  return {
    async settleEpoch(summary) {
      await ready();
      const out = { rootTx: null, claims: {}, settledAt: new Date().toISOString() };
      const existing = await kai.getRoot(summary.epoch);
      if (existing === summary.root) {
        out.rootTx = "already-on-chain";
      } else if (existing) {
        throw new Error(`epoch ${summary.epoch} already has a different root on-chain`);
      } else {
        out.rootTx = (await kai.submitRoot(summary.epoch, summary.root)).txId;
      }
      for (const [worker, packet] of Object.entries(summary.claims)) {
        try {
          // Value-based claims (amount in satoshis) are the current format;
          // count-based packets from pre-A1 epochs still settle via claim().
          const r = packet.amount != null
            ? await kai.claimValue(summary.epoch, worker, packet)
            : await kai.claim(summary.epoch, worker, packet);
          out.claims[worker] = { tx: r.txId };
        } catch (e) {
          // "already claimed" lands here on re-runs — recorded, not fatal.
          out.claims[worker] = { error: String(e.message).slice(0, 200) };
        }
      }
      return out;
    },
    async kaiBalance(address) {
      await ready();
      return (await kai.kaiBalance(address)).toString();
    },
    /** Cumulative KAI ever deposited by an address (monotonic, satoshis). */
    async depositsOf(address) {
      await ready();
      const { result } = await kai.contract.functions.deposits_of({ owner: address });
      return String(result?.value ?? "0");
    },
    /**
     * §21/§23 sponsored deposit, phase 1: build the unsigned deposit tx with
     * the operator as MANA payer. The APP signs it (from-authority) and sends
     * it back for co-signing — the user's key never leaves their machine and
     * the operator never gains authority over user balances.
     */
    async prepareDeposit(fromAddress, valueSat) {
      await ready();
      // Prepared but UNSIGNED: koilib needs a signer object to build the tx
      // (nonce/payer bookkeeping), but signTransaction:false keeps the
      // operator's signature off until the validated co-sign step.
      const { transaction } = await kai.contract.functions.deposit(
        { from: fromAddress, value: String(valueSat) },
        { payer: chain.signer.getAddress(), rcLimit: "600000000", sendTransaction: false, signTransaction: false }
      );
      return transaction;
    },
    /**
     * §21 co-sign gate: the operator signature is ONLY ever added to a tx that
     * is exactly one KAI-contract deposit from the claimed address, within the
     * per-tx cap. Anything else is refused — a sponsored lane must never
     * become a blank operator signature (§44).
     */
    async submitDeposit(tx, expectedFrom, maxSat = 1000n * 100000000n) {
      await ready();
      const ops = tx?.operations ?? [];
      if (ops.length !== 1) throw new Error("deposit tx must contain exactly one operation");
      const call = ops[0].call_contract;
      if (!call || call.contract_id !== kai.contract.getId()) throw new Error("operation is not a KAI contract call");
      const { name, args } = await kai.contract.decodeOperation(ops[0]);
      if (name !== "deposit") throw new Error("operation is not a deposit");
      if (args.from !== expectedFrom) throw new Error("deposit 'from' does not match the requesting account");
      if (BigInt(args.value ?? 0) <= 0n || BigInt(args.value ?? 0) > maxSat) throw new Error("deposit amount out of range");
      if (tx?.header?.payer !== chain.signer.getAddress()) throw new Error("payer must be the operator");
      await chain.signer.signTransaction(tx);
      await chain.provider.sendTransaction(tx);
      return { txId: tx.id, value: String(args.value) };
    },
  };
}

module.exports = { ChainClient, KaiContract, makeSettlement, rootToAnchorAddress, TESTNET, NETWORKS, networkPreset };
