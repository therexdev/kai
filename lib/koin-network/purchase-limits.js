"use strict";
const Q = require("./purchase-quote"), { uint } = require("./policy");
// Merchant credit purchases transfer native KOIN to KAI; they are not swaps
// against the reference pool. Keep the sales limit separate from price probes.
const MAX_DOLLARS = "1000", VERSION = 1;
function exceeded() {
  return Object.assign(Error("The maximum credit purchase is $1,000 per transaction. Choose $1,000 or less."), { code: "PURCHASE_LIMIT_EXCEEDED" });
}
function assertDollars(dollars) {
  if (BigInt(Q.nativeForDollars(dollars, String(Q.USD_ATOMS))) > 1000n * Q.USD_ATOMS) throw exceeded();
}
function limits(usdPerKoin) {
  // Use the same upward native-atom rounding as the selected USD pack. The
  // signed summary discloses the exact credited value, including that rounding.
  const maxPurchaseKoinAtoms = Q.nativeForDollars(MAX_DOLLARS, usdPerKoin);
  const maxPurchaseUsdAtoms = String(uint(BigInt(maxPurchaseKoinAtoms) * uint(usdPerKoin) / Q.USD_ATOMS));
  return { maxPurchaseKoinAtoms, maxPurchaseUsdAtoms };
}
function assertNative(amount, usdPerKoin) {
  if (!uint(amount)) throw Error("Positive purchase amount required");
  if (uint(amount) > uint(limits(usdPerKoin).maxPurchaseKoinAtoms)) throw exceeded();
}
module.exports = { MAX_DOLLARS, VERSION, assertDollars, assertNative, limits, exceeded };
