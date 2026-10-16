"use strict";
// Wire modes are derived from pinned deployment identity, never a remote flag.
const MAINNET_CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const MAINNET_TOKEN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
function protocol(target) {
  const live = target?.chainId === MAINNET_CHAIN;
  const liveDomain = typeof target?.domain === "string" && /^shadow:mainnet-pilot-[a-f0-9]{64}$/.test(target.domain);
  if (live !== liveDomain) throw Error("Mainnet requires its explicit pilot domain");
  const mode = live ? "mainnet-pilot" : "funded-rehearsal";
  return { mode, paymentsEnabled: live, prefix: live ? "/koin/funded/mainnet-pilot/" : "/koin/funded/rehearsal/",
    billing: live ? "koin-mainnet-pilot" : "koin-funded-rehearsal", jobType: live ? "koin-mainnet-pilot-chat" : "koin-funded-rehearsal-chat",
    capability: live ? "koinMainnetPilotJobs" : "koinFundedRehearsalJobs",
    signingTag: live ? "MAINNET-PILOT" : "REHEARSAL" };
}
function rewardMode(target) {
  if (target?.chainId === MAINNET_CHAIN && target?.token !== MAINNET_TOKEN) throw Error("Mainnet native KOIN pin required");
  return target?.chainId === MAINNET_CHAIN ? "reward-mainnet-pilot" : "reward-rehearsal";
}
module.exports = { MAINNET_CHAIN, MAINNET_TOKEN, protocol, rewardMode };
