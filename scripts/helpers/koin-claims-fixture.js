"use strict";
const assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { Serializer, Signer, Transaction, utils } = require("koilib");
const ABI = require("../../lib/koin-network/rewards-abi.json"), CABI = require("../../lib/koin-network/credits-abi.json");
const M = require("../../lib/koin-network/merkle"), R = require("../../lib/koin-network/reward-manifest");
const P = require("../../lib/koin-network/job-protocol"), { DAY } = require("../../lib/koin-network/policy");
const { RewardClaims } = require("../../lib/koin-network/reward-claims");
const { RewardObserver } = require("../../lib/koin-network/reward-observer");
const { RehearsalSubmitter } = require("../../lib/koin-network/rehearsal-submitter");
const { encodeNonce } = require("../../lib/koin-network/settlement-outbox");
const verifier = Signer.fromSeed("reward-probe-verifier"), sponsor = Signer.fromSeed("reward-probe-sponsor");
const addr = name => Signer.fromSeed("reward-probe-" + name).getAddress(), enc = utils.encodeBase64url, bytes = a => enc(utils.decodeBase58(a));
async function fixture(t, override = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koin-claims-"));
  let now = 3 * DAY + 10000, txNonce = 0, ledger, observer;
  const target = { chainId: enc(Buffer.from("1220" + P.hash("reward-fixture-chain"), "hex")), rewards: addr("rewards"), rewardsHash: "0x1220" + P.hash("rewards-wasm"),
    credits: addr("credits"), creditsHash: "0x1220" + P.hash("credits-wasm"), token: addr("token"), tokenHash: "0x1220" + P.hash("token-wasm"),
    verifier: verifier.getAddress(), version: "1", workCapBps: 8000 };
  const policy = { verifier: sponsor.getAddress(), payer: sponsor.getAddress(), maxRcPerTransaction: "10000", maxRcPerDay: "15000", maxAttempts: 3, minRetryMs: 1000, ...override };
  const tree = M.build({ chainId: target.chainId, contract: target.rewards, epoch: "1", version: "1" },
    ["alice", "bob"].map(name => ({ address: addr(name), availability: "10", work: "8" })));
  const manifest = { schema: 1, mode: "reward-rehearsal", target, epoch: "1", evidenceHash: P.hash("fixture-evidence-only"), root: tree.root,
    allocations: tree.claims.map(({ address, availability, work }) => ({ address, availability, work })) };
  const envelope = { manifest, signature: Buffer.from(await verifier.signHash(R.signingHash(manifest))).toString("base64") };
  const config = { config: { chain_id: target.chainId, token: bytes(target.token), credits: bytes(target.credits), treasury: bytes(target.rewards),
    verifier: bytes(target.verifier), version: "1", work_cap_bps: 8000 } };
  const epoch = { id: "1", opened_at: String(DAY), version: "1", budget: "200", availability_budget: "100", work_budget: "100",
    work_cap_bps: 8000, credits: bytes(target.credits), verifier: bytes(target.verifier), root: { ...tree.root, hash: enc(Buffer.from(tree.root.hash, "hex")) },
    review_until: String(3 * DAY), finalized: true, paid: "0" };
  const balances = { liabilities: "36", liquid: "1000" }, claimed = new Set(), lookups = new Map(), blocks = new Map(), metadata = {};
  for (const kind of ["token", "rewards", "credits"]) metadata[target[kind]] = { value: { hash: target[kind + "Hash"] } };
  const head = { head_topology: { id: "0x1220" + P.hash("reward-block-100"), height: "100" }, head_block_time: String(now), last_irreversible_block: "100" };
  const block = () => ({ block_id: head.head_topology.id, block_height: head.head_topology.height,
    block: { id: head.head_topology.id, header: { height: head.head_topology.height, timestamp: head.head_block_time } } });
  blocks.set(100, block());
  const ser = new Serializer(ABI.types);
  const rpc = {
    getChainId: async () => target.chainId, getHeadInfo: async () => structuredClone(head),
    invokeGetContractAddress: async name => { assert.equal(name, "koin"); return { value: { address: target.token } }; },
    invokeGetContractMetadata: async id => structuredClone(metadata[id]),
    readContract: async op => {
      const args = await ser.deserialize(op.args, "koin.Request"), account = args.account && utils.encodeBase58(utils.decodeBase64url(args.account));
      let result;
      if (op.entry_point === ABI.methods.config.entry_point) result = config;
      else if (op.contract_id === target.rewards && op.entry_point === ABI.methods.get_epoch.entry_point) { assert.equal(args.epoch, "1"); result = { epoch }; }
      else if (op.contract_id === target.rewards && op.entry_point === ABI.methods.claimed.entry_point) result = { claimed: claimed.has(account) };
      else if (op.contract_id === target.rewards && op.entry_point === ABI.methods.balances.entry_point) result = balances;
      else if (op.contract_id === target.credits && op.entry_point === CABI.methods.get_spend.entry_point) result = { amount: account ? "10" : "20" };
      else throw Error("Unexpected claim fixture operation");
      return { result: enc(await ser.serialize(result, "koin.Result")) };
    },
    getBlocks: async height => [structuredClone(blocks.get(height))],
    getBlocksById: async ids => ({ block_items: [...blocks.values()].filter(b => ids.includes(b.block_id)).map(b => ({ block_id: b.block_id, block_height: b.block_height })) }),
    getTransactionsById: async ids => ({ transactions: ids.flatMap(id => lookups.has(id) ? [structuredClone(lookups.get(id))] : []) }),
  };
  function reopen(extra = {}) {
    ledger?.close(); observer = new RewardObserver(rpc, { target, clock: () => now });
    ledger = new RewardClaims(dir, { target, policy, observer, clock: () => now, ...extra }); return ledger;
  }
  reopen(); t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ids = ledger.importManifest(envelope), sent = [], signed = [];
  const prepare = async decision => {
    const transaction = await Transaction.prepareTransaction({ header: { chain_id: decision.chainId, payer: decision.payer,
      nonce: encodeNonce(String(++txNonce)), rc_limit: decision.maxRc }, operations: [{ call_contract: decision.operation }], signatures: [] });
    await sponsor.signTransaction(transaction); signed.push(structuredClone(transaction)); return transaction;
  };
  const submit = async transaction => { sent.push(structuredClone(transaction)); return { txId: transaction.id }; };
  const runner = (extra = {}) => new RehearsalSubmitter({ mode: "isolated-rehearsal", claims: ledger, prepareClaim: prepare, submit, ...extra });
  const advance = ms => {
    now += ms; const height = Number(head.head_topology.height) + 1;
    head.head_topology = { id: "0x1220" + P.hash("reward-block-" + height), height: String(height) };
    head.last_irreversible_block = String(height); head.head_block_time = String(now);
    const b = block(); blocks.set(height, b); return b;
  };
  const pay = account => { claimed.add(account); epoch.paid = String(BigInt(epoch.paid) + 18n); balances.liabilities = String(BigInt(balances.liabilities) - 18n); balances.liquid = String(BigInt(balances.liquid) - 18n); };
  const finalized = (transaction, { reverted = false, recordClaim = true } = {}) => {
    const b = advance(10); b.block.transactions = [structuredClone(transaction)];
    b.receipt = { id: b.block_id, height: b.block_height, transaction_receipts: [{ id: transaction.id, reverted }] };
    lookups.set(transaction.id, { transaction: structuredClone(transaction), containing_blocks: [b.block_id] });
    if (!reverted && recordClaim) {
      const row = ids.map(id => ledger.status(id)).find(r => r.txId === transaction.id); pay(row.account);
    }
    return b;
  };
  return { dir, target, policy, envelope, epoch, config, balances, claimed, head, rpc, blocks, metadata, lookups, ids, sent, signed, prepare, submit,
    runner, advance, finalized, pay, reopen, get ledger() { return ledger; }, get observer() { return observer; }, clock: () => now };
}
module.exports = { fixture, sponsor, verifier, addr };
