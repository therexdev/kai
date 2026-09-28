"use strict";
const fs = require("fs"), { Signer, utils } = require("koilib");
const { KoinChain } = require("./chain"), { assertPaymentMode } = require("./payment-mode");
const { target, amount } = require("./session-delegation"), P = require("./job-protocol");
function read(file, max = 65536, secret = false) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > max || (secret && process.platform !== "win32" && (st.mode & 0o077))) throw Error("Expected protected regular configuration file");
  return fs.readFileSync(file, "utf8");
}
function configuration(c) {
  if (!c || c.schema !== 1 || c.mode !== "test-deployment" || Object.keys(c).sort().join() !== "deployment,maxRcPerDay,maxRcPerTransaction,mode,policyHash,roles,schedulerUrl,schema,tariff,tokenizer,version") throw Error("Explicit Test runtime configuration required");
  const client = new KoinChain(c.deployment); assertPaymentMode(c.mode, client);
  const u = new URL(c.schedulerUrl);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/scheduler" || u.href !== c.schedulerUrl) throw Error("Dedicated HTTPS Test scheduler required");
  target({ chainId: c.deployment.chainId, credits: c.deployment.credits, creditsHash: c.deployment.creditsHash, domain: c.schedulerUrl, policyHash: c.policyHash });
  P.integer(c.version, 1); amount(c.maxRcPerTransaction); amount(c.maxRcPerDay);
  if (BigInt(c.maxRcPerTransaction) > BigInt(c.maxRcPerDay)) throw Error("Test resource limit exceeds daily budget");
  if (!c.roles || Object.keys(c.roles).sort().join() !== "claims,lifecycle,settlement" || Object.values(c.roles).some(a => !utils.isChecksumAddress(a))) throw Error("Dedicated Test sponsor roles required");
  const addresses = [...Object.values(c.roles), c.deployment.verifier, c.deployment.admin, c.deployment.credits, c.deployment.rewards, c.deployment.mining, c.deployment.operations];
  if (new Set(addresses).size !== addresses.length) throw Error("Separate Test signing, custody and revenue roles required");
  return structuredClone(c);
}
function loadKeys(file, config) {
  const keys = JSON.parse(read(file, 16384, true)), addresses = [config.deployment.verifier, ...Object.values(config.roles)].sort();
  if (Object.keys(keys).sort().join() !== addresses.join()) throw Error("Exact runtime key roles required; admin and custody keys must stay offline");
  const signers = {};
  for (const a of addresses) { const signer = Signer.fromWif(keys[a]); if (signer.getAddress() !== a) throw Error("Test signing key does not match its role"); signers[a] = signer; }
  return signers;
}
module.exports = { read, configuration, loadKeys };
