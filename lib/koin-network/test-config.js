"use strict";
const fs = require("fs"), { Signer, utils } = require("koilib");
const { KoinChain } = require("./chain"), { assertPaymentMode, testDomain } = require("./payment-mode");
const { target, amount } = require("./session-delegation"), P = require("./job-protocol");
function read(file, max = 1048576, secret = false) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > max || (secret && process.platform !== "win32" && (st.mode & 0o077))) throw Error("Expected protected regular configuration file");
  return fs.readFileSync(file, "utf8");
}
function configuration(c) {
  const keys = c && Object.keys(c).filter(k => !["freePolicy", "accountMode", "purchasePricing", "purchaseQuoteBudget", "qualificationPolicy", "qualificationPolicies"].includes(k)).sort().join();
  const expected = c?.schema === 2 ? "deployment,maxRcPerDay,maxRcPerTransaction,mode,models,policyHash,roles,schedulerUrl,schema,version" : "deployment,maxRcPerDay,maxRcPerTransaction,mode,policyHash,roles,schedulerUrl,schema,tariff,tokenizer,version";
  if (!c || ![1, 2].includes(c.schema) || !["test-deployment", "mainnet-pilot"].includes(c.mode) || keys !== expected) throw Error("Explicit Test runtime configuration required");
  if (c.schema === 2 && !require("./product").isUsd(c.deployment)) throw Error("Multi-model accounts require the separate USD product");
  const Models = require("./model-configuration"), tariffs = Models.tariffs(c);
  if (Models.policyHash(c) !== c.policyHash) throw Error("Model catalog commitment mismatch");
  if (c.accountMode !== undefined && !["invitations", "public"].includes(c.accountMode)) throw Error("Invalid account mode");
  if ((c.freePolicy || c.accountMode === "public") && !require("./product").isUsd(c.deployment)) throw Error("Public credit accounts require the separate USD product");
  require("./free-credits").policy(c.freePolicy);
  if (c.qualificationPolicy !== undefined && c.qualificationPolicies !== undefined) throw Error("Choose one qualification policy format");
  if (c.qualificationPolicy !== undefined) {
    if (tariffs.length !== 1) throw Error("Multi-model qualification requires per-model policies");
    require("./provider-qualification").policy(c.qualificationPolicy, tariffs[0]);
  }
  if (c.qualificationPolicies !== undefined) {
    if (!Array.isArray(c.qualificationPolicies) || !c.qualificationPolicies.length || c.qualificationPolicies.length > tariffs.length) throw Error("Bounded per-model qualification policies required");
    const seen = new Set();
    for (const policy of c.qualificationPolicies) {
      const tariff = tariffs.find(t => t.model === policy?.model);
      if (!tariff || seen.has(tariff.model)) throw Error("Unique configured qualification model required");
      seen.add(tariff.model); require("./provider-qualification").policy(policy, tariff);
    }
  }
  if (c.freePolicy?.eligibleModels?.some(model => !tariffs.some(t => t.model === model))) throw Error("Free-credit eligibility references an unconfigured model");
  if (c.purchasePricing !== undefined && !require("./product").isUsd(c.deployment)) throw Error("USD purchase pricing requires the separate USD product");
  if (c.purchaseQuoteBudget !== undefined && !require("./product").isUsd(c.deployment)) throw Error("Purchase quote budgets require the separate USD product");
  if (c.purchaseQuoteBudget !== undefined || c.accountMode === "public") require("./purchase-quote-journal").budget(c.purchaseQuoteBudget);
  const client = new KoinChain(c.deployment); assertPaymentMode(c.mode, client);
  const u = new URL(c.schedulerUrl);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/scheduler" || u.href !== c.schedulerUrl) throw Error("Dedicated HTTPS Test scheduler required");
  target({ chainId: c.deployment.chainId, credits: c.deployment.credits, creditsHash: c.deployment.creditsHash, domain: testDomain(c.deployment, c.schedulerUrl), policyHash: c.policyHash });
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
