"use strict";
// Forward-only code rollout from the operator-confirmed credits release.
// Reuse clean drain, consistent snapshot, writer and financial-state guards.
const Web=require("./update-web-api"), Diagnostics=require("./update-inference-diagnostics");
const BASE="cac28b9ca7b3ac3f098593607dcba896e5d63acf";
const REQUIRED=["lib/credit-gateway.js", "lib/koin-network/inference-diagnostics.js", "lib/koin-network/job-protocol.js", "lib/koin-network/managed-protocol.js", "lib/koin-network/managed-provider.js", "lib/koin-network/model-catalog.js", "lib/koin-network/native-chat.js", "lib/koin-network/prepaid-ledger.js", "lib/koin-network/prepaid-router.js", "scripts/probe-inference-diagnostics.js", "scripts/probe-native-tools.js", "deploy/koin-mainnet/check-native-tools.js", "deploy/koin-mainnet/update-native-tools.js", "deploy/koin-mainnet/update-web-api.test.js"];
const ALLOWED=new Set([...REQUIRED,".github/workflows/managed-inference.yml","deploy/koin-mainnet/NATIVE_TOOLS.md","docs/SHARED_RUNTIME_FAILURES.md","qa/shared-runtime/node22-probes.log"]);
const PROBES=[...new Set([...Diagnostics.PROBES,"scripts/probe-native-tools.js","scripts/probe-managed-http.js","scripts/probe-koin-model-catalog.js","scripts/probe-koin-prepaid.js","scripts/probe-koin-metered-stream.js"])];
const LOCKS=["kai-native-tools-update.lock",...Diagnostics.LOCKS];
function update(options={}) { return Web.update({...options,checkHealth:options.checkHealth||Diagnostics.health,releasePolicy:{BASE,REQUIRED,ALLOWED,PROBES,LOCKS,PLAN_PREFIX:"kai-native-tools"}}); }
if(require.main===module) {
 if(process.argv.length!==2 || process.getuid?.()!==0 || Number(process.versions.node.split(".")[0])<22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root; no arguments");
 process.umask(0o077);update().catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={update,health:Diagnostics.health,BASE,REQUIRED,ALLOWED,PROBES,LOCKS,UNIT:Web.UNIT,PATHS:Web.PATHS};
