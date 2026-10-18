"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { nativeForDollars, USD_ATOMS } = require("../lib/koin-network/purchase-quote");

test("USD packs round native atoms upward without under-crediting the selected amount", () => {
  for (const [dollars, requested] of [["0.01", 1000000n], ["1", 100000000n], ["12.34", 1234000000n]]) {
    for (const price of [1n, 33333333n, 100000000n, 999999999999n]) {
      const amount = BigInt(nativeForDollars(dollars, String(price)));
      assert.ok(amount * price / USD_ATOMS >= requested);
      assert.ok((amount - 1n) * price / USD_ATOMS < requested);
    }
  }
  assert.equal(nativeForDollars("1", "25000000"), "400000000");
  assert.equal(nativeForDollars("1.00", "25000000"), "400000000");
});
test("USD packs reject ambiguous decimals, zero, precision loss and contract overflow", () => {
  for (const amount of [undefined, null, 1, "", "0", "0.00", "01", ".5", "1.", "1.001", "1e3", "-1", "+1", " 1", "1,000", "NaN", "9999999999999"])
    assert.throws(() => nativeForDollars(amount, "25000000"));
  for (const price of ["0", "-1", "18446744073709551616", 1]) assert.throws(() => nativeForDollars("1", price));
  assert.throws(() => nativeForDollars("999999999999", "1"), /uint64/);
});
