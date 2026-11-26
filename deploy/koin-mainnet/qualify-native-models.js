#!/usr/bin/env node
"use strict";
// Operator-only bounded qualification. Synthetic tool results only; no connected app actions.
const path = require("node:path"), { execFileSync } = require("node:child_process");
const { MODELS, VALUES, validateModels } = require("./activate-qualified-native");
const { RELEASES, verifyInstalled } = require("./native-rollout-release");
async function qualify({ models, maxOutput, probe, guard = () => {}, log = console.log }) {
  validateModels(models);
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 512 || maxOutput > 8192) throw Error("max-output must be 512..8192");
  const passed = [], failed = [];
  for (const model of models) {
    guard(); // A service change stops the batch, not merely this model's probe.
    try {
      const result = await probe(model, maxOutput);
      if (result?.model !== model || result.qualified !== true || result.protocol !== 2 || result.calls !== 2 || result.enabled !== false) throw Error("Invalid probe report");
      passed.push(model); log(JSON.stringify(result));
    } catch (_) {
      failed.push(model); log(JSON.stringify({ model, qualified: false, enabled: false, automaticRetries: 0 }));
    }
  }
  const report = { passed, failed, maxSupplierCalls: models.length * 2, maxOutputTokensPerCall: maxOutput, enabled: false };
  log(JSON.stringify(report)); return report;
}
function productionProbe(model, maxOutput, release, execute = execFileSync) {
  if (!RELEASES.includes(release)) throw Error("Unsupported qualification release");
  const raw = execute("runuser", ["-u", "kai-koin-prepaid", "--", "env", "-i", "PATH=/usr/bin:/bin",
    ...Object.entries(VALUES).filter(([k]) => k !== "KAI_NATIVE_TOOL_MODELS").map(([k,v]) => `${k}=${v}`),
    "/usr/bin/node", path.join(release,"deploy/koin-mainnet/check-native-tools.js"), model, "--probe", "--max-output", String(maxOutput)],
    { cwd: release, encoding: "utf8", stdio: ["ignore","pipe","pipe"] });
  return JSON.parse(raw);
}
async function main() {
  const args = process.argv.slice(2);
  if (process.getuid?.() !== 0 || process.execPath !== "/usr/bin/node" || args.length !== 4 || args[0] !== "--models" || args[2] !== "--max-output")
    throw Error("Run as root: /usr/bin/node qualify-native-models.js --models all|<IDs> --max-output <512..8192>");
  process.umask(0o077);
  const release = verifyInstalled();
  const report = await qualify({ models: args[1] === "all" ? MODELS : args[1].split(","), maxOutput: Number(args[3]),
    guard: () => verifyInstalled(undefined, release), probe: (model, maxOutput) => productionProbe(model, maxOutput, release) });
  if (report.failed.length) process.exitCode = 1;
}
if (require.main === module) main().catch(error => {
  console.error(error.message);
  console.error("Qualification stopped; no activation or automatic retry occurred."); process.exitCode = 1;
});
module.exports = { qualify, verifyInstalled, productionProbe };
