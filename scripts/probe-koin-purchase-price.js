"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { MARKET, purchasePrice } = require("../lib/koin-network/purchase-price");

test("Revision 2 purchase market is pinned to Ethereum v4 and the approved pool", () => {
  assert.equal(MARKET.chainId, 1);
  assert.equal(MARKET.protocol, "uniswap-v4");
  assert.equal(MARKET.poolId, "0xd833a3afa936ca389966a9ed3a3d9abf7ec45c11b0d575aaaf6ca4d354687da6");
  assert.equal(MARKET.fee, 10000);
  assert.ok(Object.isFrozen(MARKET));
});
test("missing validated v4 pricing fails at quote time, not service construction", async () => {
  for (const mode of ["mainnet-pilot", "test-deployment", "isolated-rehearsal"]) {
    const prices = purchasePrice({ mode });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(prices.read(), error => error.code === "PURCHASE_PRICE_UNAVAILABLE" && /Existing credits are still usable/.test(error.message));
    }
  }
});
test("fixture prices cannot bypass the mainnet boundary", () => {
  const fixture = { read: async () => ({ usdPerKoin: "25000000" }) };
  for (const mode of [undefined, "mainnet-pilot", "test-deployment"])
    assert.throws(() => purchasePrice({ mode, fixture }), /isolated chain/);
  for (const fixture of [null, {}, { read: "not a function" }])
    assert.throws(() => purchasePrice({ mode: "isolated-rehearsal", fixture }), /price reader/);
});
test("isolated rehearsal keeps its explicit fixture and never fetches a live price", async () => {
  let reads = 0;
  const fixture = { read: async () => { reads++; return { usdPerKoin: "25000000" }; } };
  const prices = purchasePrice({ mode: "isolated-rehearsal", fixture });
  assert.equal(prices, fixture);
  assert.deepEqual(await prices.read(), { usdPerKoin: "25000000" });
  assert.equal(reads, 1);
});
