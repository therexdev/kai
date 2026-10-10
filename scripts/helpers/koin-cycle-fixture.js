"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("node:assert/strict");
const { Serializer, Signer, Transaction, utils } = require("koilib");
const ABI = require("../../lib/koin-network/rewards-abi.json"), CABI = require("../../lib/koin-network/credits-abi.json");
const P = require("../../lib/koin-network/job-protocol"), M = require("../../lib/koin-network/reward-manifest"), Tree = require("../../lib/koin-network/merkle");
const { DAY } = require("../../lib/koin-network/policy"), { encodeNonce } = require("../../lib/koin-network/settlement-outbox");
const { RewardObserver } = require("../../lib/koin-network/reward-observer"), { RewardClaims } = require("../../lib/koin-network/reward-claims");
const { RewardCycle } = require("../../lib/koin-network/reward-cycle"), { RewardCycleRunner } = require("../../lib/koin-network/reward-cycle-runner");
const payer = Signer.fromSeed("cycle-fixture-payer"), verifier = Signer.fromSeed("cycle-fixture-verifier");
const addr = n => Signer.fromSeed("cycle-fixture-" + n).getAddress(), enc = utils.encodeBase64url, bytes = a => enc(utils.decodeBase58(a));
async function fixture(t, overrides = {}, mainnet = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koin-cycle-")), handles = [];
  let now = DAY + 1000, nonce = 0, cycle;
  const target = { chainId: enc(Buffer.from("1220" + P.hash("cycle-chain"), "hex")),
    rewards: addr("rewards"), rewardsHash: "0x1220" + P.hash("rewards"), credits: addr("credits"), creditsHash: "0x1220" + P.hash("credits"),
    token: addr("token"), tokenHash: "0x1220" + P.hash("token"), verifier: verifier.getAddress(), version: "1", workCapBps: 8000 };
  if (mainnet) Object.assign(target, { chainId: require("../../lib/koin-network/payment-mode").MAINNET_CHAIN, token: require("../../lib/koin-network/payment-mode").MAINNET_TOKEN });
  const mode = mainnet ? "mainnet-pilot" : "isolated-rehearsal";
  const policy = { verifier: target.verifier, payer: payer.getAddress(), maxRcPerTransaction: "10000", maxRcPerDay: "30000", maxAttempts: 3, minRetryMs: 1000, ...overrides };
  const budgetPolicy = { dailyBps: 500, availabilityBps: 7000 };
  const tree = Tree.build({ chainId: target.chainId, contract: target.rewards, epoch: "1", version: "1" },
    ["alice", "bob"].map(n => ({ address: addr(n), availability: "10", work: "4" })));
  const manifest = { schema: 1, mode: mainnet ? "reward-mainnet-pilot" : "reward-rehearsal", target, epoch: "1", evidenceHash: P.hash("cycle-test-evidence"), root: tree.root,
    allocations: tree.claims.map(({ address, availability, work }) => ({ address, availability, work })) };
  const envelope = { manifest, signature: Buffer.from(await verifier.signHash(M.signingHash(manifest))).toString("base64") };
  const config = { config: { chain_id: target.chainId, token: bytes(target.token), credits: bytes(target.credits), treasury: bytes(target.rewards),
    verifier: bytes(target.verifier), version: "1", work_cap_bps: 8000, daily_bps: 500, availability_bps: 7000 } };
  const epochs = new Map(), balances = { liquid: "1000", liabilities: "0" }, metadata = {}, blocks = new Map(), lookups = new Map();
  for (const k of ["token", "credits", "rewards"]) metadata[target[k]] = { value: { hash: target[k + "Hash"] } };
  const head = { head_topology: { id: "0x1220" + P.hash("cycle-block-100"), height: "100" }, last_irreversible_block: "100", head_block_time: String(now) };
  const saveBlock = () => { const b = { block_id: head.head_topology.id, block_height: head.head_topology.height,
    block: { id: head.head_topology.id, header: { height: head.head_topology.height, timestamp: head.head_block_time } } };
    blocks.set(Number(b.block_height), b); return b; };
  saveBlock(); const ser = new Serializer(ABI.types);
  const rpc = {
    getChainId: async () => target.chainId, getHeadInfo: async () => structuredClone(head),
    invokeGetContractAddress: async () => ({ value: { address: target.token } }), invokeGetContractMetadata: async a => structuredClone(metadata[a]),
    readContract: async op => {
      const args = await ser.deserialize(op.args, "koin.Request"); let value;
      if (op.entry_point === ABI.methods.config.entry_point) value = config;
      else if (op.contract_id === target.rewards && op.entry_point === ABI.methods.get_epoch.entry_point) value = epochs.has(args.epoch) ? { epoch: epochs.get(args.epoch) } : {};
      else if (op.contract_id === target.rewards && op.entry_point === ABI.methods.balances.entry_point) value = balances;
      else if (op.contract_id === target.rewards && op.entry_point === ABI.methods.claimed.entry_point) value = {};
      else if (op.contract_id === target.credits && op.entry_point === CABI.methods.get_spend.entry_point) value = { amount: args.account ? "10" : "20" };
      else throw Error("Unexpected cycle read");
      const result = enc(await ser.serialize(value, "koin.Result")); return result ? { result } : {};
    },
    getBlocks: async height => [structuredClone(blocks.get(height))],
    getBlocksById: async ids => ({ block_items: [...blocks.values()].filter(b => ids.includes(b.block_id)).map(b => ({ block_id: b.block_id, block_height: b.block_height })) }),
    getTransactionsById: async ids => ({ transactions: ids.flatMap(id => lookups.has(id) ? [structuredClone(lookups.get(id))] : []) }),
  };
  const observer = () => new RewardObserver(rpc, { target, clock: () => now });
  const options = { mode, target, policy, budgetPolicy, clock: () => now };
  const open = (extra = {}) => { const c = new RewardCycle(dir, { ...options, observer: observer(), ...extra }); handles.push(c); return c; };
  cycle = open(); cycle.queueDay("1");
  const signed = [], sent = [];
  const prepare = async decision => {
    const tx = await Transaction.prepareTransaction({ header: { chain_id: target.chainId, payer: policy.payer, rc_limit: decision.maxRc, nonce: encodeNonce(String(++nonce)) },
      operations: [{ call_contract: decision.operation }], signatures: [] });
    await payer.signTransaction(tx); if (decision.method === "propose_root") await verifier.signTransaction(tx);
    signed.push(structuredClone(tx)); return tx;
  };
  const submit = async tx => { sent.push(structuredClone(tx)); return { txId: tx.id }; };
  const runner = extra => new RewardCycleRunner({ mode, cycle, prepare, submit, ...extra });
  const advance = ms => { now += ms; const h = Number(head.head_topology.height) + 1;
    head.head_topology = { id: "0x1220" + P.hash("cycle-block-" + h), height: String(h) };
    head.last_irreversible_block = String(h); head.head_block_time = String(now); return saveBlock(); };
  const baseEpoch = id => ({ id, opened_at: String(now), version: "1", credits: bytes(target.credits), verifier: bytes(target.verifier),
    work_cap_bps: 8000, budget: "50", availability_budget: "35", work_budget: "15", paid: "0" });
  const include = async (tx, { reverted = false, irreversible = true, apply = true } = {}) => {
    const oldLib = head.last_irreversible_block, b = advance(1), op = tx.operations[0].call_contract;
    const args = await ser.deserialize(op.args, "koin.Request"), id = args.epoch;
    b.block.transactions = [structuredClone(tx)]; b.receipt = { id: b.block_id, height: b.block_height, transaction_receipts: [{ id: tx.id, reverted }] };
    lookups.set(tx.id, { transaction: structuredClone(tx), containing_blocks: [b.block_id] });
    if (apply && !reverted) {
      if (op.entry_point === ABI.methods.open_epoch.entry_point) { assert.equal(id, String(Math.floor(now / DAY))); epochs.set(id, baseEpoch(id)); balances.liabilities = String(BigInt(balances.liabilities) + 50n); }
      else if (op.entry_point === ABI.methods.propose_root.entry_point) { epochs.get(id).root = args.root; epochs.get(id).review_until = String(now + DAY); }
      else if (op.entry_point === ABI.methods.finalize_root.entry_point) { const e = epochs.get(id); assert.ok(now >= Number(e.review_until)); e.finalized = true;
        balances.liabilities = String(BigInt(balances.liabilities) - BigInt(e.budget) + BigInt(e.root.availability) + BigInt(e.root.work)); }
      else throw Error("Unexpected cycle write");
    }
    if (!irreversible) head.last_irreversible_block = oldLib;
    return b;
  };
  const claims = () => { const c = new RewardClaims(path.join(dir, "claims"), { target, observer: observer(), clock: () => now,
    policy: { ...policy, verifier: addr("claims-payer"), payer: addr("claims-payer") } }); handles.push(c); return c; };
  t.after(() => { for (const h of handles) try { h.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, target, policy, budgetPolicy, options, config, epochs, balances, head, blocks, lookups, metadata, rpc, envelope, signed, sent,
    prepare, submit, runner, advance, include, open, claims, baseEpoch, clock: () => now,
    reopen: () => { cycle.close(); cycle = open(); return cycle; }, get cycle() { return cycle; } };
}
module.exports = { fixture, payer, verifier, addr };
