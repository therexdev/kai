"use strict";
const { utils } = require("koilib");
function select(wallets, input, { walletless = false } = {}) {
  if (!Array.isArray(wallets) || wallets.length > 64 || wallets.some(w => !utils.isChecksumAddress(w?.address))) throw Error("Invalid linked wallets");
  if (Object.hasOwn(input, "creditWallet")) {
    if (input.creditWallet === null && walletless) return null;
    if (typeof input.creditWallet !== "string" || !wallets.some(w => w.address === input.creditWallet)) throw Error("The selected credit wallet is not linked to this account");
    return input.creditWallet;
  }
  if (wallets.length > 1) throw Error("Select the linked credit wallet on this computer");
  if (!wallets.length && !walletless) throw Error("A linked wallet is required");
  return wallets[0]?.address || null;
}
module.exports = { select };
