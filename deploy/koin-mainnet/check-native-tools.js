#!/usr/bin/env node
"use strict";
// Explicit operator-run probe. It creates one synthetic provider inference per
// model; no connection credentials, customer content or external tools execute.
const {secret}=require("../../lib/koin-network/managed-provider"),M=require("../../lib/koin-network/managed-protocol"),N=require("../../lib/koin-network/native-chat");
async function main() {
  const model=M.find(process.argv[2]);
  if(process.argv.length!==4 || process.argv[3]!=="--probe" || !model) throw Error("Usage: node deploy/koin-mainnet/check-native-tools.js <managed-model-id> --probe");
  const key=secret();if(!key) throw Error("Configure the protected AkashML credential source first");
  const tools=[{type:"function",function:{name:"native_probe",description:"Return the supplied synthetic value",parameters:{type:"object",properties:{value:{type:"string"}},required:["value"]}}}];
  const response=await fetch("https://api.akashml.com/v1/chat/completions",{method:"POST",redirect:"error",signal:AbortSignal.timeout(60000),headers:{authorization:"Bearer "+key,"content-type":"application/json"},
    body:JSON.stringify({model:model.upstream,messages:[{role:"user",content:"Call native_probe once with value kai_probe. Do not answer in prose."}],tools,tool_choice:"auto",parallel_tool_calls:false,max_completion_tokens:512})});
  if(!response.ok) throw Error("Provider probe failed with HTTP "+response.status);
  const raw=await response.text();if(Buffer.byteLength(raw)>200000) throw Error("Probe response too large");
  const value=JSON.parse(raw),choice=value.choices?.[0],answer=N.unpackAnswer(N.packAnswer(choice?.message,choice?.finish_reason));
  const call=answer.message.tool_calls?.[0];
  if(answer.message.tool_calls?.length!==1 || call.function.name!=="native_probe" || JSON.parse(call.function.arguments).value!=="kai_probe" || !Number.isSafeInteger(value.usage?.prompt_tokens) || !Number.isSafeInteger(value.usage?.completion_tokens)) throw Error("Provider did not complete a valid native tool call with usage");
  console.log(JSON.stringify({model:model.model,nativeTools:1,checkedAt:new Date().toISOString(),usage:value.usage}));
}
main().catch(()=>{console.error("Native tool probe did not pass. Leave this model out of KAI_NATIVE_TOOL_MODELS. Check protected server diagnostics; no tool was executed.");process.exitCode=1;});
