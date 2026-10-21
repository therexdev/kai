"use strict";
// Shared public market identity; connection details never belong in this file.
const MARKET = Object.freeze({
  chainId: 1,
  protocol: "uniswap-v4",
  poolId: "0xd833a3afa936ca389966a9ed3a3d9abf7ec45c11b0d575aaaf6ca4d354687da6",
  fee: 10000,
  wrappedToken: "0xa50ad3a559A10f384a5bB2e27516f63E0B937b1A",
  quoteToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
});
module.exports = { MARKET };
