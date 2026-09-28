"use strict";
const { Signer, Transaction } = require("koilib"), { setup } = require("./koin-delegation-fixture");
const { FundedReservations } = require("../../lib/koin-network/funded-reservations");
const { SettlementRecovery } = require("../../lib/koin-network/settlement-recovery");
const { fundedResultHash } = require("../../lib/koin-network/funded-protocol");
const { encodeNonce } = require("../../lib/koin-network/settlement-outbox");
const P = require("../../lib/koin-network/job-protocol"), path = require("path");
const verifier = Signer.fromSeed("funded-probe-verifier"), payer = Signer.fromSeed("outbox-probe-sponsor"), worker = Signer.fromSeed("outbox-probe-worker");
const policy = { verifier: verifier.getAddress(), payer: payer.getAddress(), maxRcPerTransaction: "10000", maxRcPerDay: "15000", maxAttempts: 3, minRetryMs: 1000 };
async function fixture(t, override = {}) {
  const settlementPolicy = { ...policy, ...override }, f = await setup(t, { settlementPolicy }), approval = await f.authorize();
  const blocks = new Map([[100, structuredClone(f.block)]]), lookup = { transactions: [] };
  const currentBlock = () => ({ block_id: f.head.head_topology.id, block_height: f.head.head_topology.height,
    block: { id: f.head.head_topology.id, header: { height: f.head.head_topology.height, timestamp: f.head.head_block_time } } });
  blocks.set(101, currentBlock()); f.head.last_irreversible_block = "101";
  f.rpc.getBlocks = async (height) => [structuredClone(blocks.get(height))];
  f.rpc.getBlocksById = async ids => ({ block_items: [...blocks.values()].filter(b => ids.includes(b.block_id)).map(b => ({ block_id: b.block_id, block_height: b.block_height })) });
  f.rpc.getTransactionsById = async () => structuredClone(lookup);
  const observe = async () => (await f.observer.observe({ id: f.id, owner: f.owner, purpose: "reconciliation" })).observationId;
  const accepted = async name => {
    const r = f.request(approval, name); await f.ledger.reserveDelegated(r);
    const h = await f.ledger.markDispatched({ id: r.id, observationId: r.observationId, provider: worker.getAddress() });
    const signature = Buffer.from(await worker.signHash(fundedResultHash(f.target, h, "4"))).toString("base64");
    f.ledger.complete({ id: r.id, output: "4", signature }); return r.id;
  };
  const signed = async (id, n = "1", rc = "10000", mutate = () => {}) => {
    f.ledger.prepare(id);
    const tx = await Transaction.prepareTransaction({ header: { chain_id: f.target.chainId, payer: payer.getAddress(), payee: verifier.getAddress(),
      nonce: encodeNonce(n), rc_limit: rc }, operations: [{ call_contract: await f.ledger.settlementOperation(id) }], signatures: [] });
    mutate(tx); await Transaction.prepareTransaction(tx);
    await verifier.signTransaction(tx); await payer.signTransaction(tx); return tx;
  };
  const stage = async (id, n = "1", rc) => {
    const transaction = await signed(id, n, rc);
    await f.ledger.stageSettlement({ id, transaction, observationId: await observe() }); return transaction;
  };
  const handles = []; t.after(() => { for (const h of handles) h.close(); });
  const reopen = (extra = {}) => {
    const h = new FundedReservations(path.join(f.config.dataDir, "koin-funded-sessions"), {
      accounts: f.accounts, observer: f.observer, target: f.target, meter: f.meter, accept: ({ output }) => output === "4",
      clock: f.config.koinFundedSessions.clock, settlementPolicy, ...extra }); handles.push(h); return h;
  };
  const advance = ms => {
    f.time(f.config.koinFundedSessions.clock() + ms); f.head.head_block_time = String(f.config.koinFundedSessions.clock());
    const height = Number(f.head.head_topology.height) + 1, id = "0x1220" + P.hash("outbox-block-" + height);
    f.head.head_topology = { id, height: String(height) }; f.head.last_irreversible_block = String(height);
    const block = currentBlock(); blocks.set(height, block); return block;
  };
  const finalized = (id, transaction, { reverted = false, extraSpend = 0 } = {}) => {
    const block = advance(10), height = Number(block.block_height), c = f.ledger.job(id).intent;
    block.block.transactions = [transaction]; block.receipt = { id: block.block_id, height: block.block_height, transaction_receipts: [{ id: transaction.id, reverted }] };
    lookup.transactions = [{ transaction, containing_blocks: [block.block_id] }];
    if (!reverted) {
      const amount = BigInt(c.amount) + BigInt(extraSpend);
      f.session.session.remaining = String(BigInt(f.session.session.remaining) - amount);
      f.session.session.jobs = String(BigInt(f.session.session.jobs) + 1n); f.session.session.nonce = f.session.session.jobs;
      f.balances.balance.reserved = f.session.session.remaining;
      f.balances.liabilities = String(BigInt(f.balances.liabilities) - amount); f.balances.liquid = f.balances.liabilities;
    }
    return height;
  };
  return Object.assign(f, { approval, settlementPolicy, blocks, lookup, observe, accepted, signed, stage, reopen, advance, finalized,
    recovery: () => new SettlementRecovery(f.ledger) });
}
module.exports = { fixture, policy, verifier, payer, worker };
