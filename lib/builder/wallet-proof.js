"use strict";
// Shared by hosted and exported apps. Vault broadcasts its own transaction;
// validate it against the reviewed draft, then require canonical confirmation.
(function (root) {
  function verify(expected, actual, txId, { Transaction, utils }, wallet = "KOIN Vault") {
    const fail = () => {
      throw Error(
        wallet + "'s transaction does not match the reviewed app action.",
      );
    };
    const bytes = (s) => utils.encodeBase64url(utils.decodeBase64url(s || ""));
    if (
      !actual ||
      actual.id !== txId ||
      Transaction.computeTransactionId(actual.header) !== txId
    )
      fail();
    for (const field of ["chain_id", "payer", "nonce"])
      if (actual.header[field] !== expected.header[field]) fail();
    if (actual.header.payee && actual.header.payee !== expected.header.payer)
      fail();
    if (
      Object.keys(actual.header).some((key) => ![
        "chain_id", "payer", "payee", "nonce", "rc_limit", "operation_merkle_root",
      ].includes(key)) ||
      !/^\d+$/.test(String(actual.header.rc_limit)) ||
      BigInt(actual.header.rc_limit) <= 0n ||
      BigInt(actual.header.rc_limit) > 18446744073709551615n ||
      bytes(actual.header.operation_merkle_root) !== bytes(expected.header.operation_merkle_root)
    ) fail();
    if (
      !Array.isArray(actual.operations) ||
      actual.operations.length !== expected.operations.length
    )
      fail();
    for (let i = 0; i < expected.operations.length; i++) {
      const wanted = expected.operations[i].call_contract,
        op = actual.operations[i],
        got = op.call_contract;
      if (
        Object.keys(op).length !== 1 ||
        !wanted ||
        !got ||
        Object.keys(got).some(
          (k) => !["contract_id", "entry_point", "args"].includes(k),
        ) ||
        got.contract_id !== wanted.contract_id ||
        Number(got.entry_point) !== Number(wanted.entry_point) ||
        bytes(got.args) !== bytes(wanted.args)
      )
        fail();
    }
    return actual;
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = { verify };
  else root.KaiWalletProof = Object.freeze({ verify });
})(typeof window === "undefined" ? {} : window);
