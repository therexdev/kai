"use strict";
// Dry validation only: no RPC calls, signing, credentials, deployment or funds.
const fs = require("node:fs");
const Runtime = require("../lib/koin-network/test-config"), { configuration, verifyParity } = require("../lib/koin-network/v4-purchase-oracle");
try {
  if (process.argv.length !== 3) throw Error("Usage: node scripts/validate-koin-purchase-pricing.js <runtime-config.json>");
  const runtime = Runtime.configuration(JSON.parse(Runtime.read(process.argv[2])));
  if (!runtime.purchasePricing) throw Error("Purchase pricing is unconfigured; existing credits do not require it");
  const pricing = configuration(runtime.purchasePricing, runtime.deployment);
  let parity;
  if (pricing.schema === 1) {
    const stat = fs.lstatSync(pricing.parityFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw Error("Bounded regular parity attestation file required");
    parity = verifyParity(JSON.parse(fs.readFileSync(pricing.parityFile, "utf8")), { signer: pricing.paritySigner, source: pricing.policy.paritySource,
      nativeChainId: runtime.deployment.chainId, nativeToken: runtime.deployment.token, now: Date.now(), maxAgeMs: pricing.policy.maxParityAgeMs });
  }
  process.stdout.write(JSON.stringify({ state: "configuration-valid", networkChecked: false, purchasesEnabled: false,
    pricingMode: pricing.schema === 1 ? "attested-parity" : "merchant-exchange-reference",
    policyVersion: pricing.policy.version, archiveSources: pricing.rpcUrls.length, ...(parity ? { parityValidUntil: parity.validUntil } : { bridgeRedemptionVerified: false }),
    detail: "Dry configuration validation only; canonical archive history, depth and oracle rounds still require live read-only verification. No commercial policy is activated." }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ state: "unavailable", purchasesEnabled: false, error: String(error.message) }) + "\n");
  process.exitCode = 1;
}
