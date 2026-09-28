"use strict";
// Validate already-signed settlement envelopes. No key, signer, HTTP client,
// transaction builder with RPC access, or broadcast operation is available here.
const { Transaction, Signer, utils } = require("koilib");
const P = require("./job-protocol"), { uint } = require("./policy"), { address } = require("./metering");
function policy(v) {
  if (!v || Object.keys(v).sort().join() !== "maxAttempts,maxRcPerDay,maxRcPerTransaction,minRetryMs,payer,verifier") throw Error("Exact settlement sponsorship policy required");
  const p = { verifier: address(v.verifier), payer: address(v.payer),
    maxRcPerTransaction: String(uint(v.maxRcPerTransaction)), maxRcPerDay: String(uint(v.maxRcPerDay)),
    maxAttempts: P.integer(v.maxAttempts, 1, 20), minRetryMs: P.integer(v.minRetryMs, 1000, 3600000) };
  if (!uint(p.maxRcPerTransaction) || uint(p.maxRcPerDay) < uint(p.maxRcPerTransaction)) throw Error("Invalid sponsorship ceilings");
  return p;
}
function encodeNonce(value) {
  let n = uint(value); const bytes = [0x28];
  if (!n) throw Error("Positive transaction nonce required");
  do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n);
  return utils.encodeBase64url(Uint8Array.from(bytes));
}
function nonce(value) {
  if (typeof value !== "string") throw Error("Canonical nonce required");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < 2 || bytes.length > 11 || bytes[0] !== 0x28) throw Error("Invalid transaction nonce");
  let n = 0n;
  for (let i = 1; i < bytes.length; i++) n |= BigInt(bytes[i] & 127) << BigInt(7 * (i - 1));
  if (encodeNonce(n) !== value) throw Error("Noncanonical transaction nonce");
  return String(n);
}
async function validateSigned(transaction, { target, policy: p, operation }) {
  const tx = structuredClone(transaction), h = tx?.header;
  if (!tx || Object.keys(tx).sort().join() !== "header,id,operations,signatures" ||
      typeof tx.id !== "string" || !/^0x1220[a-f0-9]{64}$/.test(tx.id) || !h ||
      Object.keys(h).sort().join() !== (p.payer === p.verifier ? "chain_id,nonce,operation_merkle_root,payer,rc_limit" : "chain_id,nonce,operation_merkle_root,payee,payer,rc_limit") ||
      h.chain_id !== target.chainId || h.payer !== p.payer || (h.payee || h.payer) !== p.verifier ||
      typeof h.rc_limit !== "string" || !uint(h.rc_limit) || uint(h.rc_limit) > uint(p.maxRcPerTransaction)) throw Error("Settlement transaction header or sponsorship mismatch");
  const n = nonce(h.nonce);
  if (!Array.isArray(tx.operations) || tx.operations.length !== 1 || Object.keys(tx.operations[0]).join() !== "call_contract") throw Error("Exactly one settlement operation required");
  const op = tx.operations[0].call_contract;
  if (!op || Object.keys(op).sort().join() !== "args,contract_id,entry_point" ||
      ["args", "contract_id", "entry_point"].some(k => op[k] !== operation[k])) throw Error("Transaction differs from the exact prepared settlement");
  const prepared = await Transaction.prepareTransaction(structuredClone(tx));
  if (prepared.id !== tx.id || prepared.header.operation_merkle_root !== h.operation_merkle_root) throw Error("Settlement transaction commitment mismatch");
  const required = [...new Set([p.verifier, p.payer])].sort(), signers = [];
  if (!Array.isArray(tx.signatures) || tx.signatures.length !== required.length) throw Error("Verifier and sponsor signatures required");
  for (const signature of tx.signatures) {
    if (typeof signature !== "string") throw Error("Invalid settlement signature");
    const bytes = Buffer.from(signature, "base64url");
    if (bytes.length !== 65 || utils.encodeBase64url(bytes) !== signature) throw Error("Invalid settlement signature encoding");
    signers.push(Signer.recoverAddress(Buffer.from(tx.id.slice(6), "hex"), bytes));
  }
  if (JSON.stringify(signers.sort()) !== JSON.stringify(required)) throw Error("Wrong settlement signers");
  // Stable JSON ordering freezes the exact envelope returned on every retry.
  return { transaction: { id: tx.id, header: prepared.header,
    operations: [{ call_contract: { contract_id: op.contract_id, entry_point: op.entry_point, args: op.args } }],
    signatures: tx.signatures }, nonce: n, rcLimit: h.rc_limit };
}
module.exports = { policy, encodeNonce, nonce, validateSigned };
