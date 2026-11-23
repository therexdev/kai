"use strict";
// Deliberately requires the reviewed premium-model release first; never replaces
// an unrelated live payment runtime or silently enables upstream providers.
const Web=require("./update-web-api");
const BASE="ed35690b0a4d681aa4dd1f2972c95d7a5de724eb";
const REQUIRED=["lib/accounts.js","lib/credit-gateway.js","lib/credit-vault.js","lib/koin-network/model-catalog.js","public/platform/index.html","public/platform/platform.js","test-server.js","scripts/probe-credit-vault.js","deploy/koin-mainnet/update-android-account.js","docs/ANDROID_ACCOUNT.md"];
const ALLOWED=new Set([...REQUIRED,".github/workflows/android-account.yml"]);
const PROBES=["scripts/probe-accounts.js","scripts/probe-credit-account-web.js","scripts/probe-account-dashboard.js","scripts/probe-credit-gateway.js","scripts/probe-credit-platform-dom.js","scripts/probe-credit-vault.js","deploy/koin-mainnet/update-web-api.test.js"];
const LOCKS=["kai-android-account-update.lock",...Web.LOCKS];
async function health({fetchImpl=fetch,...options}={}){return Web.health({...options,fetchImpl:async(url,init)=>{const response=await fetchImpl(url,init);if(!url.endsWith("/health")||!response.ok)return response;const body=await response.text();if(body.length>32768||JSON.parse(body).nativeAccountVersion!==1)throw Error("Native account support is not active");return{ok:response.ok,status:response.status,text:async()=>body};}});}
function update(options={}){return Web.update({...options,checkHealth:options.checkHealth||health,releasePolicy:{BASE,REQUIRED,ALLOWED,PROBES,LOCKS,PLAN_PREFIX:"kai-android-account"}});}
if(require.main===module){if(process.argv.length!==2||process.getuid?.()!==0||Number(process.versions.node.split(".")[0])<22||/^\/(root|home)\//.test(process.execPath))throw Error("Run with system Node 22+ as root; no arguments");process.umask(0o077);update().catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={update,health,BASE,REQUIRED,ALLOWED,PROBES,LOCKS,UNIT:Web.UNIT,PATHS:Web.PATHS};
