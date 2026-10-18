"use strict";

// Revision 2 pins a v4 market, not the legacy two-ticker adapter. Until the
// block-history/depth/parity implementation is reviewed, new purchases must
// remain unavailable. Do not make this a startup gate: reconciliation and
// consumption of already-purchased credits do not require a market quote.
const MARKET = Object.freeze({
  chainId: 1,
  protocol: "uniswap-v4",
  poolId: "0xd833a3afa936ca389966a9ed3a3d9abf7ec45c11b0d575aaaf6ca4d354687da6",
  fee: 10000,
  wrappedToken: "0xa50ad3a559A10f384a5bB2e27516f63E0B937b1A",
  quoteToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
});

function purchasePrice({ mode, fixture } = {}) {
  // This is deliberately the same isolation boundary as the runtime. A
  // configuration flag, stale ticker or dashboard spot estimate cannot enable
  // a mainnet quote. Fixture injection remains usable for local rehearsals.
  if (fixture !== undefined) {
    if (mode !== "isolated-rehearsal" || typeof fixture?.read !== "function")
      throw Error("Fixture prices require an isolated chain and a price reader");
    return fixture;
  }
  return Object.freeze({
    async read() {
      throw Object.assign(new Error("Current purchase pricing is unavailable. Existing credits are still usable. Please try again later."), {
        code: "PURCHASE_PRICE_UNAVAILABLE",
      });
    },
  });
}

module.exports = { MARKET, purchasePrice };
