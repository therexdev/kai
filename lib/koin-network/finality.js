"use strict";

const { Transaction } = require("koilib");
const { uint } = require("./policy");
const { address } = require("./metering");
const id = (v) => {
  if (typeof v !== "string" || !/^0x1220[a-f0-9]{64}$/.test(v)) throw Error("Invalid chain object ID");
  return v;
};
function operation(v) {
  if (!v || Object.keys(v).sort().join() !== "args,contract_id,entry_point" ||
      !Number.isInteger(v.entry_point) || v.entry_point < 0 || v.entry_point > 0xffffffff ||
      typeof v.args !== "string" || v.args.length > 22000) throw Error("Invalid expected operation");
  address(v.contract_id);
  return [v.contract_id, v.entry_point, v.args];
}

// Read-only verifier, following Koinos' irreversible-chain procedure. SDK
// wait() means inclusion, not finality. No threshold like "six confirmations".
// Provider is a trusted, deployment-pinned RPC; this is not a light client.
async function inspectFinality(provider, { chainId, txId, expectedOperation }) {
  id(txId);
  if (typeof chainId !== "string" || Buffer.from(chainId, "base64").length !== 34) throw Error("Pin chain ID");
  const expected = operation(expectedOperation);
  if (await provider.getChainId() !== chainId) throw Error("RPC chain mismatch");
  const response = await provider.getTransactionsById([txId]);
  if (!response || typeof response !== "object" || Array.isArray(response) || response.error || response.rpc_error ||
      (response.transactions !== undefined && !Array.isArray(response.transactions))) throw Error("Missing transaction lookup result");
  // Native protobuf JSON omits empty repeated fields. Unknown transactions
  // still keep their exact-envelope fence; an empty lookup never proves paid.
  const records = (response.transactions ?? []).filter((r) => r.transaction?.id === txId);
  if (records.length === 0) return { state: "unknown", txId };
  if (records.length !== 1) throw Error("Ambiguous transaction lookup");
  const record = records[0], tx = record.transaction;
  if (tx.header?.chain_id !== chainId || tx.operations?.length !== 1 ||
      Object.keys(tx.operations[0]).join() !== "call_contract" ||
      JSON.stringify(operation(tx.operations[0].call_contract)) !== JSON.stringify(expected)) throw Error("Settlement operation mismatch");
  const canonical = await Transaction.prepareTransaction(structuredClone(tx));
  if (canonical.id !== txId || canonical.header.operation_merkle_root !== tx.header.operation_merkle_root) throw Error("Transaction commitment mismatch");
  const containing = record.containing_blocks ?? [];
  if ((record.containing_blocks !== undefined && !Array.isArray(record.containing_blocks)) || containing.length > 100) throw Error("Invalid containing blocks");
  if (!containing.length) return { state: "pending", txId };
  containing.forEach(id);
  const head = await provider.getHeadInfo(), lib = uint(head.last_irreversible_block ?? "0");
  id(head.head_topology?.id);
  if (lib > uint(head.head_topology.height)) throw Error("Invalid irreversibility height");
  const candidates = await provider.getBlocksById(containing, { returnBlock: false, returnReceipt: false });
  if (!candidates || typeof candidates !== "object" || Array.isArray(candidates) || candidates.error || candidates.rpc_error ||
      (candidates.block_items !== undefined && !Array.isArray(candidates.block_items))) throw Error("Missing block lookup result");
  let reversible = false;
  for (const b of candidates.block_items ?? []) {
    if (!containing.includes(b.block_id)) throw Error("Unexpected containing block");
    const height = uint(b.block_height);
    if (height > lib) { reversible = true; continue; }
    if (height > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("Block height exceeds SDK range");
    // Resolve against the SAME head used for LIB. Looking up by ID alone
    // would incorrectly accept an old fork at an irreversible height.
    const [main] = await provider.getBlocks(Number(height), 1, head.head_topology.id,
      { returnBlock: true, returnReceipt: true });
    if (!main || main.block_id !== b.block_id) continue;
    if (uint(main.block_height) !== height || main.block?.id !== b.block_id ||
        uint(main.block.header?.height) !== height || main.receipt?.id !== b.block_id ||
        uint(main.receipt.height) !== height) throw Error("Inconsistent finalized block");
    const included = main.block.transactions?.filter((t) => t.id === txId);
    const receipts = main.receipt.transaction_receipts?.filter((r) => r.id === txId);
    if (included?.length !== 1 || receipts?.length !== 1) throw Error("Missing finalized transaction or receipt");
    const actual = included[0], r = receipts[0];
    const commitment = await Transaction.prepareTransaction(structuredClone(actual));
    if (commitment.id !== txId || commitment.header.operation_merkle_root !== actual.header?.operation_merkle_root ||
        actual.header?.chain_id !== chainId ||
        actual.operations?.length !== 1 || Object.keys(actual.operations[0]).join() !== "call_contract" ||
        JSON.stringify(operation(actual.operations[0].call_contract)) !== JSON.stringify(expected)) throw Error("Finalized transaction mismatch");
    // False is omitted in some protobuf JSON responses; a receipt itself is
    // always required. Malformed booleans or RPC errors cannot prove success.
    if (r.rpc_error || ![undefined, false, true].includes(r.reverted)) throw Error("Invalid finalized receipt");
    return { state: r.reverted === true ? "reverted" : "finalized", txId,
      blockId: b.block_id, height: height.toString(), irreversibleHeight: lib.toString() };
  }
  return { state: reversible ? "reversible" : "unknown", txId };
}
module.exports = { inspectFinality };
