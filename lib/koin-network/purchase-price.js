"use strict";

// Revision 2 pins a v4 market, not the legacy two-ticker adapter. Until the
// archive history, depth, stablecoin and explicit reference policy is present, new
// purchases remain unavailable. Do not make this a startup gate: reconciliation and
// consumption of already-purchased credits do not require a market quote.
const { MARKET } = require("./purchase-market");

function purchasePrice({ mode, fixture, reviewed, deployment, clock, fetchImpl } = {}) {
  // This is deliberately the same isolation boundary as the runtime. A
  // configuration flag, stale ticker or dashboard spot estimate cannot enable
  // a mainnet quote. Fixture injection remains usable for local rehearsals.
  if (fixture !== undefined) {
    if (reviewed !== undefined) throw Error("Choose reviewed pricing or an isolated fixture, never both");
    if (mode !== "isolated-rehearsal" || typeof fixture?.read !== "function")
      throw Error("Fixture prices require an isolated chain and a price reader");
    return fixture;
  }
  if (reviewed !== undefined) {
    try {
      if (!require("./product").isUsd(deployment)) throw Error("USD purchase deployment required");
      const oracle = new (require("./v4-purchase-oracle").V4PurchaseOracle)({ config: reviewed, deployment, clock, fetchImpl });
      return { refresh: () => oracle.refresh(), close: () => oracle.close(), async readEvidence() {
        try { return await oracle.readEvidence(); } catch { throw Object.assign(Error("Validated purchase pricing is unavailable. Existing credits are still usable."), { code: "PURCHASE_PRICE_UNAVAILABLE" }); }
      }, async read() {
        try { return await oracle.read(); } catch { throw Object.assign(Error("Validated purchase pricing is unavailable. Existing credits are still usable."), { code: "PURCHASE_PRICE_UNAVAILABLE" }); }
      } };
    } catch { /* Invalid pricing config pauses purchases, not existing usage. */ }
  }
  return Object.freeze({
    async read() {
      throw Object.assign(new Error("Current purchase pricing is unavailable. Existing credits are still usable. Please try again later."), {
        code: "PURCHASE_PRICE_UNAVAILABLE",
      });
    },
  });
}

function assertPurchaseSize(price, amount, { isolated = false } = {}) {
  const { uint } = require("./policy");
  if (price?.maxPurchaseUsdAtoms === undefined && price?.maxPurchaseKoinAtoms === undefined && isolated) return;
  if (typeof price?.maxPurchaseUsdAtoms !== "string" || !uint(price.maxPurchaseUsdAtoms) ||
      typeof price?.maxPurchaseKoinAtoms !== "string" || !uint(price.maxPurchaseKoinAtoms)) throw Error("Validated purchase depth is unavailable");
  if (!uint(amount) || !uint(price.usdPerKoin)) throw Error("Positive purchase amount and price required");
  if (uint(amount) > uint(price.maxPurchaseKoinAtoms))
    throw Object.assign(Error("Purchase amount exceeds current validated market depth. Choose a smaller amount."), { code: "PURCHASE_DEPTH_EXCEEDED" });
}
module.exports = { MARKET, purchasePrice, assertPurchaseSize };
