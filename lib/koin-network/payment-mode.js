"use strict";
const { KoinChain } = require("./chain");
// Mainnet requires a separate explicit mode and its exact chain/token pins.
const { MAINNET_CHAIN, MAINNET_TOKEN } = require("./payment-network");
const FOUNDATION_CHAIN = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==";
const FOUNDATION_TOKEN = "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju";
function assertPaymentMode(mode, client) {
  if (!(client instanceof KoinChain)) throw Error("Explicit payment client required");
  if (mode === "isolated-rehearsal" && client.d.network === "isolated" && client.d.chainId !== MAINNET_CHAIN) return mode;
  if (mode === "test-deployment" && client.d.network === "foundation-testnet" &&
      client.d.chainId === FOUNDATION_CHAIN && client.d.token === FOUNDATION_TOKEN) return mode;
  if (mode === "mainnet-pilot" && client.d.network === "mainnet" && client.d.chainId === MAINNET_CHAIN && client.d.token === MAINNET_TOKEN) return mode;
  throw Error("Explicit isolated rehearsal, pinned Foundation Test deployment or pinned mainnet pilot required");
}
function testDomain(deployment, schedulerUrl) {
  return (deployment.chainId === MAINNET_CHAIN ? "shadow:mainnet-pilot-" : "shadow:test-") + require("./job-protocol").hash(JSON.stringify([deployment.chainId, deployment.credits, schedulerUrl]));
}
module.exports = { assertPaymentMode, FOUNDATION_CHAIN, FOUNDATION_TOKEN, MAINNET_CHAIN, MAINNET_TOKEN, testDomain };
