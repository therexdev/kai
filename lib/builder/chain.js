"use strict";
const crypto = require("crypto"),
  fs = require("fs"),
  path = require("path"),
  {
    Provider,
    Contract,
    Transaction,
    Signer,
    Serializer,
    utils,
  } = require("koilib"),
  { fail } = require("./store");
const abi = require("../../contracts/build-app/build/contract.abi.json");
const FOUNDATION_CHAIN = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==";
const PUBLISHING_PROTOCOL = 2;
// Keep useful node/contract diagnostics, never whole RPC requests or state.
function chainErrorDetail(message, data) {
  if (typeof data === "string" && data.length <= 16000) {
    try {
      data = JSON.parse(data);
    } catch {
      data = null;
    }
  }
  const clean = (s) =>
    typeof s === "string"
      ? s
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300)
      : "";
  return (
    [
      ...new Set(
        [
          message,
          data?.message,
          ...(Array.isArray(data?.logs) ? data.logs.slice(-3) : []),
        ]
          .map(clean)
          .filter(Boolean),
      ),
    ]
      .join(" · ")
      .slice(0, 800) || "request rejected"
  );
}
function waiting(message, phase) {
  return Object.assign(fail(message, 409), { confirmationPhase: phase });
}
// Foundation testnet exposes the system metadata contract through read_contract,
// but its gateway does not expose chain.invoke_system_call. This address is
// bound to that exact chain, from the official local-testnet genesis contracts.
const metadataContract = (chainId) =>
  chainId === FOUNDATION_CHAIN ? "1GERisQC8e4bcsHmgU1mVGUJCwCJ3ioz7C" : null;
const guardAbi = {
  ...abi,
  methods: {
    verify_template: {
      entry_point: 1,
      argument: "app.MetadataArgs",
      return: "app.Result",
      read_only: false,
    },
  },
};
const wasmHash = (name) =>
  "0x1220" +
  crypto
    .createHash("sha256")
    .update(
      fs.readFileSync(
        path.join(
          __dirname,
          "../../contracts/build-app/build/" + name + ".wasm",
        ),
      ),
    )
    .digest("hex");
function guardOperation(id, guardId, owner, pending) {
  const fields = [];
  for (const [tag, value] of [
    [10, id],
    [18, owner],
    [26, pending],
  ])
    if (value) {
      const address = utils.decodeBase58(validAddress(value));
      fields.push(Buffer.from([tag, address.length]), Buffer.from(address));
    }
  return {
    call_contract: {
      contract_id: validAddress(guardId),
      entry_point: 1,
      args: utils.encodeBase64url(Buffer.concat(fields)),
    },
  };
}
const READ = new Set(["get_config", "list_records", "get_record"]),
  WRITE = new Set(["create_record", "edit_record", "vote", "close_poll"]);
const bytes = (a) => utils.encodeBase64url(utils.decodeBase58(a));
const address = (b) =>
  b ? utils.encodeBase58(utils.decodeBase64url(b)) : null;
function settings(env = process.env) {
  return {
    rpc:
      env.KAI_BUILD_RPC_URL || "https://testnet.koinosfoundation.org/jsonrpc",
    chainId:
      env.KAI_BUILD_CHAIN_ID ||
      "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==",
    network: env.KAI_BUILD_NETWORK || "testnet",
    rcLimit: env.KAI_BUILD_RC_LIMIT || "200000000",
  };
}
function validAddress(a) {
  if (typeof a !== "string" || !utils.isChecksumAddress(a))
    throw fail("Choose a valid Koinos wallet address.");
  return a;
}
function cleanArgs(method, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw fail("Invalid app arguments.");
  const out = {};
  for (const name of ["id", "choice", "offset"])
    if (args[name] != null) {
      const v = Number(args[name]);
      if (!Number.isInteger(v) || v < 0 || v > 10000)
        throw fail("Invalid " + name + ".");
      out[name] = v;
    }
  for (const [name, max] of [
    ["title", 160],
    ["body", 4000],
  ])
    if (args[name] != null) {
      if (typeof args[name] !== "string" || args[name].length > max)
        throw fail("The " + name + " is too long.");
      out[name] = args[name];
    }
  if (args.options != null) {
    if (
      !Array.isArray(args.options) ||
      args.options.length > 8 ||
      args.options.some(
        (v) => typeof v !== "string" || !v.length || v.length > 120,
      )
    )
      throw fail("Polls support up to eight short options.");
    out.options = args.options;
  }
  return out;
}
function publicResult(result) {
  const r = structuredClone(result || {});
  if (r.config) {
    r.config.owner = address(r.config.owner);
    r.config.pending_owner = address(r.config.pending_owner);
    r.config.release_hash = r.config.release_hash
      ? Buffer.from(utils.decodeBase64url(r.config.release_hash)).toString(
          "hex",
        )
      : null;
  }
  for (const record of [...(r.records || []), ...(r.record ? [r.record] : [])])
    record.author = address(record.author);
  return r;
}
class BuildChain {
  constructor(config = settings()) {
    this.config = config;
    this.provider = new Provider([config.rpc]);
    this.provider.onError = () => true;
    // Koilib's default transport can wait indefinitely. Bound every RPC and
    // response size without allowing the caller to supply an endpoint.
    this.provider.call = async (method, params) => {
      const response = await fetch(config.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw fail("The Koinos node is unavailable. Retry shortly.", 502);
      const raw = await response.text();
      if (raw.length > 4000000)
        throw fail("The Koinos node returned too much data.", 502);
      const data = JSON.parse(raw);
      if (data.error) {
        const detail = chainErrorDetail(data.error.message, data.error.data);
        throw Object.assign(fail("Koinos: " + detail, 502), {
          rpcError: true,
          rpcTransient:
            /timeout|timed out|deadline exceeded|unavailable|connection|socket|temporar/i.test(
              detail,
            ),
        });
      }
      return data.result;
    };
    if (metadataContract(config.chainId))
      this.provider.invokeGetContractMetadata = async (id) => {
        const serializer = new Serializer(abi.koilib_types),
          args = utils.encodeBase64url(
            await serializer.serialize(
              { contract_id: bytes(validAddress(id)) },
              "app.MetadataArgs",
            ),
          );
        const result = await this.provider.call("chain.read_contract", {
          contract_id: metadataContract(config.chainId),
          entry_point: 0x784faa08,
          args,
        });
        const decoded = result?.result
          ? await serializer.deserialize(result.result, "app.MetadataResult")
          : {};
        if (decoded.value?.hash)
          decoded.value.hash =
            "0x" +
            Buffer.from(utils.decodeBase64url(decoded.value.hash)).toString(
              "hex",
            );
        return decoded;
      };
  }
  async assertChain() {
    if (!this.config.chainId)
      throw fail("The builder network is not configured.", 503);
    if ((await this.provider.getChainId()) !== this.config.chainId)
      throw fail(
        "The RPC returned a different blockchain. Publishing has been stopped.",
        503,
      );
  }
  contract(id) {
    return new Contract({ id: validAddress(id), abi, provider: this.provider });
  }
  async read(id, method, args) {
    if (!READ.has(method)) throw fail("This method is not a public read.");
    await this.assertChain();
    const { result } = await this.contract(id).functions[method](
      cleanArgs(method, args),
    );
    return publicResult(result);
  }
  async operation(id, method, args) {
    const { operation } = await this.contract(id).functions[method](args, {
      onlyOperation: true,
    });
    return operation;
  }
  async verifiedGuard(id, guardId) {
    if (!guardId)
      throw fail(
        "This app needs a verified deployment guard before wallet actions are available.",
        409,
      );
    const [app, guard] = await Promise.all([
      this.provider.invokeGetContractMetadata(validAddress(id)),
      this.provider.invokeGetContractMetadata(validAddress(guardId)),
    ]);
    const a = app?.value,
      g = guard?.value;
    if (
      a?.hash?.toLowerCase() !== wasmHash("contract") ||
      a.system ||
      !a.authorizes_call_contract ||
      !a.authorizes_transaction_application ||
      !a.authorizes_upload_contract
    )
      throw fail(
        "This app's contract was replaced. Wallet actions through KAI Build are disabled.",
        409,
      );
    if (
      g?.hash?.toLowerCase() !== wasmHash("guard") ||
      g.system ||
      !g.authorizes_upload_contract
    )
      throw fail("The app's immutable guard could not be verified.", 409);
    return guardOperation(id, guardId);
  }
  async prepare(id, method, args, payer, guardId) {
    await this.assertChain();
    validAddress(payer);
    await this.verifiedGuard(id, guardId);
    const guard = guardOperation(
        id,
        guardId,
        ["set_release", "propose_owner"].includes(method) ? payer : null,
        method === "accept_owner" ? payer : null,
      ),
      operation = await this.operation(id, method, args);
    return Transaction.prepareTransaction(
      {
        header: {
          chain_id: this.config.chainId,
          rc_limit: this.config.rcLimit,
          payer,
        },
        operations: [guard, operation],
      },
      this.provider,
      payer,
    );
  }
  async preparePublic(id, method, args, payer, guardId) {
    if (!WRITE.has(method))
      throw fail("This app cannot request that action.", 403);
    const a = cleanArgs(method, args);
    a.account = bytes(validAddress(payer));
    return this.prepare(id, method, a, payer, guardId);
  }
  async submitExact(expected, signed, signerAddress) {
    if (
      !signed ||
      !Array.isArray(signed.signatures) ||
      signed.signatures.length < 1 ||
      signed.signatures.length > 5
    )
      throw fail("The signed transaction is missing a wallet signature.");
    // A wallet may reorder object keys but must not change any transaction field.
    const canonical = (v) => JSON.stringify(v, Object.keys(v).sort());
    if (
      canonical(signed.header) !== canonical(expected.header) ||
      JSON.stringify(signed.operations) !==
        JSON.stringify(expected.operations) ||
      signed.id !== expected.id
    )
      throw fail(
        "The wallet changed the transaction. Turn off Use free mana and sign a fresh request.",
      );
    const tx = {
      id: expected.id,
      header: expected.header,
      operations: expected.operations,
      signatures: signed.signatures,
    };
    if (Transaction.computeTransactionId(tx.header) !== tx.id)
      throw fail("Transaction integrity check failed.");
    const recovered = await Signer.recoverAddresses(tx);
    if (!recovered.includes(signerAddress))
      throw fail("Sign with the wallet shown in this request.", 403);
    await this.assertChain();
    await this.provider.sendTransaction(tx);
    return tx.id;
  }
  async vaultReceipt(expected, txId) {
    if (!/^0x1220[0-9a-f]{64}$/i.test(txId || ""))
      throw fail("Invalid KOIN Vault transaction ID.");
    await this.assertChain();
    const { transactions } = await this.provider.getTransactionsById([txId]);
    const actual = transactions?.find(
      (t) => t.transaction?.id === txId,
    )?.transaction;
    if (!actual)
      throw fail(
        "Waiting for KOIN Vault's transaction to reach the chain. Keep this request open and retry confirmation.",
        409,
      );
    try {
      require("./wallet-proof").verify(expected, actual, txId, {
        Transaction,
        utils,
      });
    } catch {
      throw fail(
        "KOIN Vault's transaction does not match the reviewed app action.",
        409,
      );
    }
    return txId;
  }
  async confirmed(txId) {
    // Look up the recorded transaction, including old blocks after a restart.
    // A scan beginning at today's head would permanently lose older results.
    const { transactions } = await this.provider.getTransactionsById([txId]);
    const ids = transactions?.find(
      (t) => t.transaction?.id === txId || t.id === txId,
    )?.containing_blocks;
    if (!ids?.length)
      throw waiting(
        "Waiting for the transaction to enter a block. Retry confirmation shortly.",
        "not_seen",
      );
    const result = await this.provider.getBlocksById(ids, {
        returnBlock: false,
        returnReceipt: true,
      }),
      head = await this.provider.getHeadInfo();
    for (const block of result.block_items || []) {
      const height = Number(block.block_height);
      if (!Number.isSafeInteger(height) || height < 1) continue;
      const canonical = await this.provider.getBlocks(
        height,
        1,
        head.head_topology.id,
      );
      if (canonical?.[0]?.block_id !== block.block_id) continue;
      if (BigInt(head.last_irreversible_block || 0) < BigInt(height))
        throw waiting(
          "The transaction is in a block and is waiting for finality. Retry confirmation shortly.",
          "finality",
        );
      const receipt = block.receipt?.transaction_receipts?.find(
        (r) => r.id === txId,
      );
      if (!receipt)
        throw waiting(
          "The node has not supplied the transaction receipt. Retry confirmation shortly.",
          "receipt",
        );
      if (receipt.reverted)
        throw fail(
          "Koinos reverted this transaction. " +
            chainErrorDetail(null, { logs: receipt.logs }),
          422,
        );
      return true;
    }
    throw waiting(
      "The transaction is not on the confirmed chain yet. Retry confirmation shortly.",
      "fork",
    );
  }
}
class SignerClient {
  constructor(env = process.env) {
    this.url = env.KAI_BUILD_SIGNER_URL;
    this.token = env.KAI_BUILD_SIGNER_TOKEN;
    if (this.url) {
      const u = new URL(this.url);
      if (
        u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
        )
      )
        throw Error("Builder signer requires HTTPS or loopback.");
    }
  }
  get configured() {
    return !!(this.url && this.token);
  }
  async call(action, payload = {}) {
    if (!this.configured)
      throw fail(
        "Publishing is awaiting the server's builder signing setup. Your project and preview are saved.",
        503,
      );
    const res = await fetch(this.url.replace(/\/$/, "") + "/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + this.token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(75000),
    });
    const data = await res.json();
    if (!res.ok)
      throw fail(
        data.error || "The publishing service could not complete the request.",
        res.status,
      );
    return data;
  }
}
module.exports = {
  BuildChain,
  SignerClient,
  abi,
  guardAbi,
  guardOperation,
  wasmHash,
  metadataContract,
  bytes,
  address,
  validAddress,
  cleanArgs,
  publicResult,
  settings,
  READ,
  WRITE,
  PUBLISHING_PROTOCOL,
  chainErrorDetail,
};
