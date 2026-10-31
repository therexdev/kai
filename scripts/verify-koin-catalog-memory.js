"use strict";
// Read-only deployment preflight. Uses the exact runtime Meter constructor and
// all locally installed artifacts; never opens accounts, ledgers or signing keys.
const fs = require("node:fs"), path = require("node:path");
const { configuration, read } = require("../lib/koin-network/test-config");
const { loadRuntimeMeter } = require("../lib/koin-network/test-runtime");
function verify(directory) {
  const config = configuration(JSON.parse(read(path.join(directory, "runtime.json"))));
  const meter = loadRuntimeMeter(config, path.join(directory, "tokenizer"));
  const report = { models: meter.tariffs().length, policyHash: meter.policyHash,
    catalogPolicyHash: meter.catalogPolicyHash || meter.policyHash,
    heapUsedMiB: Math.ceil(process.memoryUsage().heapUsed / 1048576),
    peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) };
  return report;
}
if (require.main === module) {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw Error("Usage: node --max-old-space-size=768 scripts/verify-koin-catalog-memory.js /absolute/config-directory");
  console.log(JSON.stringify(verify(process.argv[2])));
}
module.exports = { verify };
