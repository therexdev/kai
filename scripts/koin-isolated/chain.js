"use strict";
const fs = require("fs"), path = require("path"), assert = require("node:assert/strict");
const { Provider, Signer, Serializer, Transaction, utils } = require("koilib");
const { hash } = require("./prepare"), upstream = require("./upstream.json");
const { DAY } = require("../../lib/koin-network/policy");
const enc = utils.encodeBase64url, bytes = address => enc(utils.decodeBase58(address));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== false && x !== 0 && x !== "0" && x !== "" && x != null)
    .map(([key, value]) => [key, canonical(value)]));
}
class LocalProvider extends Provider {
  constructor(endpoint) {
    if (endpoint !== "http://127.0.0.1:48080") throw Error("Isolated loopback endpoint required");
    super(endpoint); this.endpoint = endpoint; this.pinnedChain = null;
  }
  async call(method, params) {
    if (["chain.submit_transaction", "chain.submit_block"].includes(method)) {
      if (!this.pinnedChain || (await this.call("chain.get_chain_id", {})).chain_id !== this.pinnedChain) throw Error("Isolated chain identity changed");
      if (method === "chain.submit_transaction" && params.transaction.header.chain_id !== this.pinnedChain) throw Error("Transaction chain mismatch");
    }
    const response = await fetch(this.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!response.ok) throw Error("Isolated RPC HTTP " + response.status);
    const body = await response.json(); if (body.error) throw Error(JSON.stringify(body.error));
    return body.result;
  }
}
class IsolatedChain {
  constructor(directory) {
    this.directory = path.resolve(directory); this.manifest = JSON.parse(fs.readFileSync(path.join(this.directory, "manifest.json")));
    const m = this.manifest;
    if (m.schema !== 1 || m.mode !== "isolated-chain" || m.upstreamCommit !== upstream.commit ||
        hash(fs.readFileSync(path.join(this.directory, "genesis.json"))) !== m.genesisHash) throw Error("Disposable genesis manifest required");
    for (const [name, digest] of Object.entries(upstream.sha256)) if (hash(fs.readFileSync(path.join(m.upstreamDir, name))) !== digest) throw Error("Changed isolated bootstrap artifact");
    for (const a of Object.values(m.artifacts)) if (hash(fs.readFileSync(a.wasm)) !== a.sha256) throw Error("Custody WASM changed after preparation");
    if (!m.walletClient || hash(fs.readFileSync(m.walletClient.file)) !== m.walletClient.sha256) throw Error("Pinned desktop wallet client required");
    this.provider = new LocalProvider(m.endpoint); this.records = []; this.resourceEnabled = false;
    this.now = Math.floor(Date.now() / DAY) * DAY - 4 * DAY + 10000;
    this.serializer = new Serializer(require("../../lib/koin-network/credits-abi.json").types);
    this.bootstrapSerializer = new Serializer({ nested: {
      record: { fields: { name: { type: "string", id: 1 }, address: { type: "bytes", id: 2 } } },
      mint: { fields: { to: { type: "bytes", id: 1 }, value: { type: "uint64", id: 2 } } },
      balance: { fields: { owner: { type: "bytes", id: 1 } } },
      amount: { fields: { value: { type: "uint64", id: 1 } } },
      allowance: { fields: { owner: { type: "bytes", id: 1 }, spender: { type: "bytes", id: 2 } } },
      approve: { fields: { owner: { type: "bytes", id: 1 }, spender: { type: "bytes", id: 2 }, value: { type: "uint64", id: 3 } } },
    } });
    this.actors = Object.fromEntries(["credits", "rewards", "admin", "verifier", "buyer", "sponsor", "manual", "alice", "bob", "mining", "operations", "empty"]
      .map(name => [name, Signer.fromSeed("kai-isolated-only-v1-" + name)]));
  }
  async connect() {
    for (let n = 0; ; n++) {
      try { await this.provider.getHeadInfo(); break; } catch (e) { if (n >= 90) throw e; await pause(1000); }
    }
    assert.equal((await this.provider.getHeadInfo()).head_topology.height ?? "0", "0", "Never attach to an existing chain");
    const marker = this.manifest.marker;
    assert.equal(await this.provider.invokeGetObject(marker), marker.value, "Fresh genesis marker must match before any signing");
    this.chainId = await this.provider.getChainId(); this.provider.pinnedChain = this.chainId;
    // Published upstream test fixtures, never environment or wallet secrets.
    const source = fs.readFileSync(path.join(this.manifest.upstreamDir, "integration/integration.go"), "utf8");
    this.keys = Object.fromEntries(["Genesis", "NameService", "GetContractMetadata", "Koin", "Resources", "Governance"].map(name => {
      const match = source.match(new RegExp("\\b" + name + ':\\s+"([^"\\n]+)"'));
      if (!match) throw Error("Missing upstream fixture identity");
      const signer = Signer.fromWif(match[1]); signer.provider = this.provider; return [name, signer];
    }));
  }
  address(name) { return this.actors[name].getAddress(); }
  async signed(operations, actor, { payer = actor, rcLimit } = {}) {
    assert.equal(await this.provider.getChainId(), this.chainId);
    rcLimit ??= this.resourceEnabled ? "10000000000" : await this.provider.getAccountRc(payer.getAddress());
    const transaction = await Transaction.prepareTransaction({ header: { chain_id: this.chainId, payer: payer.getAddress(),
      ...(payer.getAddress() !== actor.getAddress() && { payee: actor.getAddress() }), rc_limit: rcLimit }, operations, signatures: [] }, this.provider);
    await actor.signTransaction(transaction); if (payer.getAddress() !== actor.getAddress()) await payer.signTransaction(transaction);
    return transaction;
  }
  async block(transactions = [], timestamp = this.now + 1) {
    this.now = timestamp;
    // Protobuf JSON omits height at genesis. koilib otherwise computes NaN.
    const head = await this.provider.getHeadInfo();
    const block = await this.keys.Genesis.prepareBlock({ header: { timestamp: String(timestamp),
      height: String(BigInt(head.head_topology.height ?? "0") + 1n) }, transactions });
    await this.keys.Genesis.signBlock(block);
    const result = await this.provider.submitBlock(block);
    assert.equal(result.receipt?.id, block.id); return result.receipt;
  }
  async send(label, operations, actor, options = {}) {
    const transaction = await this.signed(operations, actor, options);
    const receipt = await this.include(label, transaction);
    if (!options.reverted) assert.notEqual(receipt.reverted, true, label + ": " + JSON.stringify(receipt.logs));
    else assert.equal(receipt.reverted, true, label + " must revert");
    return { transaction, receipt };
  }
  async include(label, transaction) {
    const block = await this.block([transaction]), receipt = block.transaction_receipts?.find(r => r.id === transaction.id);
    assert.ok(receipt && !receipt.rpc_error, label + " needs a real receipt");
    this.records.push({ label, resourceEnabled: this.resourceEnabled, blockId: block.id, height: block.height, transaction, receipt });
    console.log(JSON.stringify({ step: label, height: block.height, reverted: receipt.reverted === true }));
    return receipt;
  }
  async finalize(height) {
    for (let n = 0; ; n++) {
      if (BigInt((await this.provider.getHeadInfo()).last_irreversible_block ?? "0") >= BigInt(height)) break;
      if (n >= 400) throw Error("Isolated chain did not reach finality");
      await this.block();
    }
    // Stores consume block broadcasts asynchronously; require the actual record.
    for (let n = 0; ; n++) {
      const h = await this.provider.getHeadInfo();
      const [b] = await this.provider.getBlocks(Number(height), 1, h.head_topology.id, { returnBlock: true, returnReceipt: true });
      if (b?.block && b?.receipt) return b;
      if (n >= 40) throw Error("Isolated block store did not catch up"); await pause(100);
    }
  }
  async operation(kind, method, args = {}) {
    const abi = require("../../lib/koin-network/" + kind + "-abi.json");
    return { call_contract: { contract_id: this.address(kind), entry_point: abi.methods[method].entry_point,
      args: enc(await this.serializer.serialize(canonical(args), "koin.Request")) } };
  }
  async read(kind, method, args = {}) {
    const { call_contract } = await this.operation(kind, method, args);
    return this.serializer.deserialize((await this.provider.readContract(call_contract)).result ?? "", "koin.Result");
  }
  async balance(address) {
    const args = enc(await this.bootstrapSerializer.serialize({ owner: bytes(address) }, "balance"));
    const result = await this.provider.readContract({ contract_id: this.keys.Koin.getAddress(), entry_point: 0x5c721497, args });
    return (await this.bootstrapSerializer.deserialize(result.result ?? "", "amount")).value ?? "0";
  }
  async walletClient() {
    const { KoinChain } = require(this.manifest.walletClient.file);
    const deployment = { schema: 1, network: "isolated", decimals: 8, rpc: [this.manifest.endpoint],
      chainId: this.chainId, token: this.keys.Koin.getAddress(),
      tokenHash: (await this.provider.invokeGetContractMetadata(this.keys.Koin.getAddress())).value.hash };
    for (const kind of ["credits", "rewards", "admin", "verifier", "mining", "operations"]) deployment[kind] = this.address(kind);
    for (const kind of ["credits", "rewards"]) deployment[kind + "Hash"] = "0x1220" + this.manifest.artifacts[kind].sha256;
    return new KoinChain(deployment, this.provider);
  }
  async allowance(kind, actor) {
    const request = { owner: bytes(actor.getAddress()), spender: bytes(this.address(kind)) };
    const response = await this.provider.readContract({ contract_id: this.keys.Koin.getAddress(), entry_point: 0x32f09fa1,
      args: enc(await this.bootstrapSerializer.serialize(request, "allowance")) });
    return (await this.bootstrapSerializer.deserialize(response.result ?? "", "amount")).value ?? "0";
  }
  async deposit(kind, method, actor, amount) {
    const client = await this.walletClient(), args = { account: bytes(actor.getAddress()), amount };
    const intent = { kind, method, args, actor: actor.getAddress(), maxRc: "10000000000" };
    const transaction = await client.prepare(kind, method, args, { actor: intent.actor, rcLimit: intent.maxRc });
    await client.verifyTransaction(transaction, intent);
    // Exercise the actual desktop encoder/validator, using only a public fixture key.
    assert.equal(transaction.operations.length, 2);
    assert.deepEqual(await this.bootstrapSerializer.deserialize(transaction.operations[0].call_contract.args, "approve"),
      { owner: args.account, spender: bytes(this.address(kind)), value: amount });
    await actor.signTransaction(transaction);
    await client.submit(transaction, intent);
    const receipt = await this.include(method, transaction);
    assert.notEqual(receipt.reverted, true, JSON.stringify(receipt.logs));
    assert.equal(await this.allowance(kind, actor), "0", "Deposit must consume the entire allowance");
    return { transaction, receipt };
  }
  async bootstrap() {
    const syscall = (call_id, signer, entry_point) => ({ set_system_call: { call_id, target: { system_call_bundle: { contract_id: signer.getAddress(), entry_point } } } });
    const upload = async (name, file, record) => {
      const signer = this.keys[name], contract_id = signer.getAddress();
      await this.send("bootstrap-upload-" + name, [{ upload_contract: { contract_id,
        bytecode: enc(fs.readFileSync(path.join(this.manifest.upstreamDir, "contracts", file + ".wasm"))) } }], signer);
      const args = enc(await this.bootstrapSerializer.serialize({ name: record, address: bytes(contract_id) }, "record"));
      await this.send("bootstrap-register-" + name, [{ set_system_contract: { contract_id, system_contract: true } },
        { call_contract: { contract_id: this.keys.NameService.getAddress(), entry_point: 0xe248c73a, args } }], this.keys.Genesis);
    };
    await upload("NameService", "name_service", "name_service");
    await this.send("bootstrap-name-system-calls", [syscall(10000, this.keys.NameService, 0xe5070a16), syscall(10001, this.keys.NameService, 0xa61ae5e8)], this.keys.Genesis);
    await upload("GetContractMetadata", "get_contract_metadata", "get_contract_metadata");
    await this.send("bootstrap-metadata-system-call", [syscall(112, this.keys.GetContractMetadata, 0x784faa08)], this.keys.Genesis);
    await upload("Koin", "koin", "koin"); await upload("Resources", "resources", "resources");
    // Native Mana looks up the exempt governance identity even for ordinary
    // accounts. Register the upstream fixture; none of our payers uses it.
    await this.send("bootstrap-governance-name", [{ call_contract: { contract_id: this.keys.NameService.getAddress(), entry_point: 0xe248c73a,
      args: enc(await this.bootstrapSerializer.serialize({ name: "governance", address: bytes(this.keys.Governance.getAddress()) }, "record")) } }], this.keys.Genesis);
    const recipients = [this.keys.Genesis.getAddress(), this.keys.Koin.getAddress(),
      ...["admin", "verifier", "buyer", "sponsor", "manual"].map(name => this.address(name))];
    const mint = [];
    for (const to of recipients) mint.push({ call_contract: { contract_id: this.keys.Koin.getAddress(), entry_point: 0xdc6f17bb,
      args: enc(await this.bootstrapSerializer.serialize({ to: bytes(to), value: "100000000000000" }, "mint")) } });
    await this.send("bootstrap-fixture-balances", mint, this.keys.Koin);
    await this.send("bootstrap-enable-real-resource-accounting", [syscall(201, this.keys.Koin, 0x2d464aab), syscall(202, this.keys.Koin, 0x80e3f5c9),
      syscall(203, this.keys.Resources, 0x427a0394), syscall(204, this.keys.Resources, 0x9850b1fd)], this.keys.Genesis);
    this.resourceEnabled = true;
    for (const kind of ["credits", "rewards"]) await this.send("deploy-" + kind, [{ upload_contract: {
      contract_id: this.address(kind), bytecode: enc(fs.readFileSync(this.manifest.artifacts[kind].wasm)) } }], this.actors[kind], { payer: this.keys.Genesis });
    this.config = { chain_id: this.chainId, token: bytes(this.keys.Koin.getAddress()), credits: bytes(this.address("credits")), treasury: bytes(this.address("rewards")),
      admin: bytes(this.address("admin")), verifier: bytes(this.address("verifier")), mining: bytes(this.address("mining")), operations: bytes(this.address("operations")),
      version: "1", daily_bps: 500, availability_bps: 7000, reward_bps: 6000, mining_bps: 2500, operations_bps: 1500, work_cap_bps: 8000 };
    for (const kind of ["credits", "rewards"]) await this.send("initialize-" + kind, [await this.operation(kind, "initialize", { config: this.config })], this.actors[kind], { payer: this.keys.Genesis });
  }
}
module.exports = { IsolatedChain, LocalProvider, canonical, bytes, pause };
