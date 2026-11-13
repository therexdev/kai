"use strict";
const { isDeepStrictEqual } = require("node:util");
const { uint } = require("./policy");
// Installing this capability authorizes at most ten Mana per claim. The
// original ledger identity and its separately configured daily budget stay put.
const MAX_CLAIM_RC = "1000000000";
function ceiling(base, daily) {
  const value = uint(base) > uint(MAX_CLAIM_RC) ? uint(base) : uint(MAX_CLAIM_RC);
  return String(value < uint(daily) ? value : uint(daily));
}
function receipt(transaction, response) {
  const r = response?.receipt;
  if (response?.rpc_error || !r || r.rpc_error || r.id !== transaction.id ||
      r.payer !== transaction.header.payer || ![false, undefined].includes(r.reverted) ||
      typeof r.rc_used !== "string" || !uint(r.rc_used) || uint(r.rc_used) > uint(transaction.header.rc_limit))
    throw Error("Claim resource simulation did not verify the exact transaction");
  return r.rc_used;
}
function estimatedLimit(used, floor, cap) {
  const buffered = (uint(used) * 125n + 99n) / 100n;
  const value = buffered > uint(floor) ? buffered : uint(floor);
  if (value > uint(cap)) throw wait("Claim resource estimate exceeds the authorized ceiling");
  return String(value);
}
function sameIntent(original, replacement) {
  const withoutLimit = tx => ({ header: { ...tx.header, rc_limit: undefined }, operations: tx.operations });
  if (!isDeepStrictEqual(withoutLimit(original), withoutLimit(replacement)))
    throw Error("Claim resource revision changed the original nonce or payment intent");
}
function insufficient(error) { return error?.code === "koin_rpc_insufficient_rc"; }
function wait(message) { return Object.assign(Error(message), { code: "koin_claim_resource_wait" }); }
function isPreparationWait(error) {
  return error?.claimResourcePreparation === true &&
    (insufficient(error) || error.code === "koin_claim_resource_wait" ||
      (error.code === "koin_rpc_unavailable" && error.retryable === true));
}
module.exports = { MAX_CLAIM_RC, ceiling, receipt, estimatedLimit, sameIntent, insufficient, wait, isPreparationWait };
