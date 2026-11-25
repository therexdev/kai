#!/usr/bin/env node
"use strict";
// Operator-only bounded qualification. Synthetic tool results only; no connected app actions.
const path = require("node:path"), { execFileSync } = require("node:child_process");
const { MODELS, RELEASE, VALUES, validateModels } = require("./activate-qualified-native");
async function qualify({ models, maxOutput, probe, log = console.log }) {
  validateModels(models);
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 512 || maxOutput > 8192) throw Error("max-output must be 512..8192");
  const passed = [], failed = [];
  for (const model of models) {
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
function verifyInstalled(run = (exe, args) => execFileSync(exe,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim()) {
  for (const [key,value] of Object.entries({ WorkingDirectory: RELEASE, User: "kai-koin-prepaid", Group: "kai-koin-prepaid" }))
    if (run("systemctl",["show","kai-koin-prepaid.service","--value","--property="+key]) !== value) throw Error("Unexpected installed service identity; qualification was not changed");
}
function productionProbe(model, maxOutput) {
  const raw = execFileSync("runuser", ["-u", "kai-koin-prepaid", "--", "env", "-i", "PATH=/usr/bin:/bin",
    ...Object.entries(VALUES).filter(([k]) => k !== "KAI_NATIVE_TOOL_MODELS").map(([k,v]) => `${k}=${v}`),
    "/usr/bin/node", path.join(RELEASE,"deploy/koin-mainnet/check-native-tools.js"), model, "--probe", "--max-output", String(maxOutput)],
    { cwd: RELEASE, encoding: "utf8", stdio: ["ignore","pipe","pipe"] });
  return JSON.parse(raw);
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (process.getuid?.() !== 0 || process.execPath !== "/usr/bin/node" || args.length !== 4 || args[0] !== "--models" || args[2] !== "--max-output")
    throw Error("Run as root: /usr/bin/node qualify-native-models.js --models all|<IDs> --max-output <512..8192>");
  process.umask(0o077);
  verifyInstalled();
  qualify({ models: args[1] === "all" ? MODELS : args[1].split(","), maxOutput: Number(args[3]), probe: productionProbe })
    .then(r => { if(r.failed.length) process.exitCode=1; })
    .catch(() => { console.error("Qualification stopped; no activation or automatic retry occurred."); process.exitCode=1; });
}
module.exports = { qualify, verifyInstalled };
