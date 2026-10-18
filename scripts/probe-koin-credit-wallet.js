"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Signer } = require("koilib"), { select } = require("../lib/koin-network/credit-wallet");
test("credit wallet selection is explicit, membership-checked and compatible with single-wallet accounts", () => {
  const a = Signer.fromSeed("wallet-a").getAddress(), b = Signer.fromSeed("wallet-b").getAddress(), c = Signer.fromSeed("wallet-c").getAddress(), wallets = [{ address: a }, { address: b }];
  assert.throws(() => select(wallets, {}), /Select/);
  assert.equal(select(wallets, { creditWallet: b }), b);
  assert.throws(() => select(wallets, { creditWallet: c }), /not linked/);
  assert.throws(() => select(wallets, { creditWallet: null }), /not linked/);
  assert.equal(select(wallets, { creditWallet: null }, { walletless: true }), null);
  assert.equal(select([wallets[0]], {}), a); assert.equal(select([], {}, { walletless: true }), null);
  assert.throws(() => select([], {}), /required/);
});
