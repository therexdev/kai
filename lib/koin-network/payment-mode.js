"use strict";
const { KoinChain } = require("./chain");
// The public Test deployment is deliberately pinned to Foundation testnet.
// A mainnet manifest cannot enable these controls, even in a Test installer.
const FOUNDATION_CHAIN = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==";
const FOUNDATION_TOKEN = "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju";
function assertPaymentMode(mode, client) {
  if (!(client instanceof KoinChain)) throw Error("Explicit payment client required");
  if (mode === "isolated-rehearsal" && client.d.network === "isolated") return mode;
  if (mode === "test-deployment" && client.d.network === "foundation-testnet" &&
      client.d.chainId === FOUNDATION_CHAIN && client.d.token === FOUNDATION_TOKEN) return mode;
  throw Error("Explicit isolated rehearsal or pinned Foundation Test deployment required");
}
function testDomain(deployment, schedulerUrl) {
  return "shadow:test-" + require("./job-protocol").hash(JSON.stringify([deployment.chainId, deployment.credits, schedulerUrl]));
}
module.exports = { assertPaymentMode, FOUNDATION_CHAIN, FOUNDATION_TOKEN, testDomain };
