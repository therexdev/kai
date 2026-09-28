"use strict";
const { Provider, Serializer, Transaction, utils, Signer } = require("koilib"),
  crypto = require("crypto");
const P = require("./policy");
const ABIS = {
  credits: require("./credits-abi.json"),
  rewards: require("./rewards-abi.json"),
};
const native = new Serializer(utils.tokenAbi.types);
const funding = (kind, method) =>
  (kind === "credits" && method === "purchase") ||
  (kind === "rewards" && method === "fund");
function fundingRequest(kind, method, args, actor) {
  if (!funding(kind, method)) throw Error("Choose a credit purchase or reward funding");
  address(actor);
  if (!args || Object.keys(args).sort().join() !== "account,amount" ||
      args.account !== encodedAddress(actor) || typeof args.amount !== "string" ||
      args.amount.length > 20 || P.uint(args.amount) === 0n)
    throw Error("Funding requires the exact owner and positive atom amount");
}
function address(a) {
  if (typeof a !== "string" || !utils.isChecksumAddress(a))
    throw Error("Invalid deployment address");
  return a;
}
const encodedAddress = (a) =>
  utils.encodeBase64url(utils.decodeBase58(address(a)));
function normalize(type, input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Expected contract message");
  const out = {};
  for (const [key, v] of Object.entries(input)) {
    const f = type.fields[key];
    if (!f) throw Error("Unknown contract field: " + key);
    f.resolve();
    if (v == null) continue;
    const one = (x) =>
      f.resolvedType?.fields ? normalize(f.resolvedType, x) : x;
    if (f.repeated) {
      if (!Array.isArray(v) || v.length > 32) throw Error("Invalid proof list");
      if (v.length) out[key] = v.map(one);
    } else if (f.resolvedType?.fields) out[key] = one(v);
    else {
      if (/^uint64$/.test(f.type)) P.uint(v);
      if (
        v !== false &&
        v !== 0 &&
        v !== "" &&
        !(v === "0" && f.type === "uint64")
      )
        out[key] = v;
    }
  }
  return out;
}
function validateDeployment(d) {
  if (
    !d ||
    d.schema !== 1 ||
    !["mainnet", "foundation-testnet", "isolated"].includes(d.network) ||
    d.decimals !== 8 ||
    !Array.isArray(d.rpc) ||
    !d.rpc.length ||
    d.rpc.length > 3
  )
    throw Error("Explicit KOIN deployment required");
  if (
    typeof d.chainId !== "string" ||
    Buffer.from(d.chainId, "base64").length !== 34 ||
    Buffer.from(d.chainId, "base64").subarray(0, 2).toString("hex") !== "1220" ||
    utils.encodeBase64url(Buffer.from(d.chainId, "base64")) !== d.chainId
  )
    throw Error("Pin the chain ID");
  for (const url of d.rpc) {
    const u = new URL(url);
    const local = d.network === "isolated" && u.protocol === "http:" && u.hostname === "127.0.0.1";
    if (d.network === "isolated" && !local) throw Error("Isolated loopback RPC required");
    if ((!local && u.protocol !== "https:") || u.username || u.password)
      throw Error("HTTPS RPC required");
  }
  for (const k of [
    "token",
    "credits",
    "rewards",
    "admin",
    "verifier",
    "mining",
    "operations",
  ])
    address(d[k]);
  for (const k of ["tokenHash", "creditsHash", "rewardsHash"])
    if (!/^0x1220[a-f0-9]{64}$/.test(d[k]))
      throw Error("Pin complete code hashes");
  if (new Set([d.credits, d.rewards, d.token]).size !== 3)
    throw Error("Separate custody contracts required");
  return structuredClone(d);
}
class KoinChain {
  constructor(deployment, provider) {
    this.d = validateDeployment(deployment);
    if (this.d.network === "isolated" && !provider)
      throw Error("Isolated mode requires an explicitly injected provider");
    Object.freeze(this.d.rpc); Object.freeze(this.d);
    this.provider = provider || new Provider(this.d.rpc);
    this.serializer = new Serializer(ABIS.credits.types);
  }
  async operation(kind, method, args = {}) {
    const entry = ABIS[kind]?.methods[method];
    if (!entry) throw Error("Unknown KOIN method");
    const bytes = await this.serializer.serialize(
      normalize(this.serializer.root.lookupType("koin.Request"), args),
      "koin.Request",
    );
    if (bytes.length > 16384) throw Error("Contract request too large");
    return {
      contract_id: this.d[kind],
      entry_point: entry.entry_point,
      args: utils.encodeBase64url(bytes),
    };
  }
  async operations(kind, method, args, actor) {
    const deposit = { call_contract: await this.operation(kind, method, args) };
    if (!funding(kind, method)) return [deposit];
    fundingRequest(kind, method, args, actor);
    if (actor === this.d[kind] || actor === this.d.token)
      throw Error("Custody and token accounts cannot be funding owners");
    // The native contract pulls from the owner only under this exact allowance.
    // Approval and deposit must never be signed/submitted separately.
    const entry = utils.tokenAbi.methods.approve;
    const approved = await native.serialize({ owner: actor, spender: this.d[kind], value: args.amount }, entry.argument);
    return [{ call_contract: { contract_id: this.d.token, entry_point: entry.entry_point,
      args: utils.encodeBase64url(approved) } }, deposit];
  }
  async read(kind, method, args = {}) {
    if (!ABIS[kind]?.methods[method]?.read_only)
      throw Error("Not a read method");
    const r = await this.provider.readContract(
      await this.operation(kind, method, args),
    );
    if (!r || typeof r !== "object" || Array.isArray(r) || r.error || r.rpc_error ||
        (r.result !== undefined && (typeof r.result !== "string" || r.result.length > 32768)))
      throw Error("Invalid KOIN contract read");
    return this.serializer.deserialize(r.result ?? "", "koin.Result");
  }
  async verify() {
    const d = this.d;
    if ((await this.provider.getChainId()) !== d.chainId)
      throw Error("Deployment chain mismatch");
    {
      const canonical = await this.provider.invokeGetContractAddress("koin");
      if (canonical?.value?.address !== d.token)
        throw Error("Asset is not canonical native KOIN");
    }
    for (const kind of ["token", "credits", "rewards"]) {
      const m = await this.provider.invokeGetContractMetadata(d[kind]);
      if (m.value?.hash !== d[kind + "Hash"])
        throw Error(kind + " bytecode changed");
      if (
        kind !== "token" &&
        ["system", "authorizes_call_contract", "authorizes_transaction_application", "authorizes_upload_contract"]
          .some(key => ![undefined, false].includes(m.value[key]))
      )
        throw Error("Unexpected contract authority override");
    }
    const [credits, rewards] = await Promise.all([
      this.read("credits", "config"),
      this.read("rewards", "config"),
    ]);
    for (const value of [credits, rewards]) {
      const c = value.config;
      if (
        !c ||
        Buffer.from(c.chain_id, "base64").toString("hex") !==
          Buffer.from(d.chainId, "base64").toString("hex")
      )
        throw Error("Config chain mismatch");
      for (const [key, expected] of Object.entries({
        token: d.token,
        credits: d.credits,
        treasury: d.rewards,
        admin: d.admin,
        verifier: d.verifier,
        mining: d.mining,
        operations: d.operations,
      }))
        if (c[key] !== encodedAddress(expected))
          throw Error("Unexpected on-chain " + key);
    }
    if (String(credits.config.version) !== String(rewards.config.version))
      throw Error("Contract policies are not synchronized");
    return {
      credits: credits.config,
      rewards: rewards.config,
      paused: credits.paused || rewards.paused,
    };
  }
  async prepare(kind, method, args, { actor, payer = actor, rcLimit }) {
    args = structuredClone(args);
    if (funding(kind, method) && (typeof rcLimit !== "string" || rcLimit.length > 20 || P.uint(rcLimit) === 0n))
      throw Error("Positive resource limit required");
    const state = await this.verify();
    address(actor);
    address(payer);
    P.uint(rcLimit);
    if (ABIS[kind]?.methods[method]?.read_only || method === "initialize")
      throw Error("Choose a mutable configured method");
    if (funding(kind, method) && state.paused) throw Error("Funding is paused");
    return Transaction.prepareTransaction(
      {
        header: {
          chain_id: this.d.chainId,
          payer,
          ...(payer !== actor ? { payee: actor } : {}),
          rc_limit: rcLimit,
        },
        operations: await this.operations(kind, method, args, actor),
        signatures: [],
      },
      this.provider,
    );
  }
  async verifyTransaction(
    tx,
    { kind, method, args, actor, payer = actor, maxRc },
  ) {
    // Exact intended operation supplied locally; never sign an arbitrary scheduler draft.
    tx = structuredClone(tx); args = structuredClone(args);
    address(actor); address(payer);
    const operations = await this.operations(kind, method, args, actor);
    if (
      !tx?.header ||
      Object.keys(tx).some(k => !["id", "header", "operations", "signatures"].includes(k)) ||
      tx.header.chain_id !== this.d.chainId ||
      !Array.isArray(tx.operations) || tx.operations.length !== operations.length ||
      tx.header.payer !== payer ||
      (tx.header.payee || tx.header.payer) !== actor ||
      P.uint(tx.header.rc_limit) > P.uint(maxRc)
    )
      throw Error("Transaction exceeds approved scope");
    if (
      Object.keys(tx.header).some(
        (k) =>
          ![
            "chain_id",
            "payer",
            "payee",
            "nonce",
            "rc_limit",
            "operation_merkle_root",
          ].includes(k),
      )
    )
      throw Error("Unknown transaction header");
    for (let i = 0; i < operations.length; i++) {
      const op = tx.operations[i];
      if (!op || Object.keys(op).join() !== "call_contract") throw Error("Unexpected operation");
      const expected = operations[i].call_contract, actual = op.call_contract;
      if (!actual || Object.keys(actual).sort().join() !== "args,contract_id,entry_point" ||
          actual.contract_id !== expected.contract_id || actual.entry_point !== expected.entry_point || actual.args !== expected.args)
        throw Error("Transaction differs from approved request");
    }
    const canonical = await Transaction.prepareTransaction(structuredClone(tx));
    if (
      canonical.id !== tx.id ||
      canonical.header.operation_merkle_root !== tx.header.operation_merkle_root
    )
      throw Error("Transaction commitment mismatch");
    return true;
  }
  async submit(tx, intent) {
    tx = structuredClone(tx); intent = structuredClone(intent);
    const state = await this.verify();
    if (funding(intent.kind, intent.method) && state.paused) throw Error("Funding is paused");
    await this.verifyTransaction(tx, intent);
    if (!(await Signer.recoverAddresses(tx)).includes(intent.actor))
      throw Error("Account signature required");
    const r = await this.provider.call("chain.submit_transaction", {
      transaction: tx,
      broadcast: true,
    });
    if (r.receipt?.reverted) throw Error("Transaction reverted");
    return { txId: tx.id, state: "submitted" };
  }
  static codeHash(bytes) {
    return "0x1220" + crypto.createHash("sha256").update(bytes).digest("hex");
  }
}
module.exports = { KoinChain, validateDeployment, normalize, encodedAddress, fundingRequest };
