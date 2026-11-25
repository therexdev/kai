"use strict";
// Forward-only rollout; no changes to credit storage, funding or model allowlist.
const Web=require("./update-web-api"), Prior=require("./update-native-tools");
const BASE="bc1fca8328cdd463023c472ba3ee5ca84d9c6580";
const REQUIRED=["lib/koin-network/inference-diagnostics.js","lib/credit-gateway.js","lib/koin-network/managed-provider.js","lib/koin-network/model-catalog.js","lib/koin-network/native-chat.js","lib/koin-network/native-replay.js","lib/koin-network/native-qualification.js","lib/koin-network/native-probe.js","test-server.js","scripts/probe-native-tools.js","scripts/probe-native-qualification.js","deploy/koin-mainnet/check-native-tools.js","deploy/koin-mainnet/update-native-qualification.js","deploy/koin-mainnet/update-web-api.test.js"];
const ALLOWED=new Set([...REQUIRED,".github/workflows/managed-inference.yml","deploy/koin-mainnet/NATIVE_TOOLS_PHASE2.md","qa/native-phase2/VALIDATION.md"]);
const PROBES=[...new Set([...Prior.PROBES,"scripts/probe-native-qualification.js"])];
const LOCKS=["kai-native-qualification-update.lock",...Prior.LOCKS];
async function health({fetchImpl=fetch,...options}={}) {
 return Prior.health({...options,fetchImpl:async(url,init)=>{
  const response=await fetchImpl(url,init);
  if(!url.endsWith("/health")||!response.ok)return response;
  const body=await response.text();
  if(body.length>32768)throw Error("Oversized native health response");
  const value=JSON.parse(body);
  if(value.nativeToolTransportVersion!==2||value.nativeQualificationVersion!==2)throw Error("Qualified native transport is not active");
  return {ok:response.ok,status:response.status,text:async()=>body};
 }});
}
function update(options={}) { return Web.update({...options,checkHealth:options.checkHealth||health,releasePolicy:{BASE,REQUIRED,ALLOWED,PROBES,LOCKS,PLAN_PREFIX:"kai-native-qualification"}}); }
if(require.main===module) {
 if(process.argv.length!==2||process.getuid?.()!==0||Number(process.versions.node.split(".")[0])<22||/^\/(root|home)\//.test(process.execPath))throw Error("Run with system Node 22+ as root; no arguments");
 process.umask(0o077);update().catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={update,health,BASE,REQUIRED,ALLOWED,PROBES,LOCKS,UNIT:Web.UNIT,PATHS:Web.PATHS};
