"use strict";
const test=require("node:test"), assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const R=require("../lib/koin-network/native-replay"), Q=require("../lib/koin-network/native-qualification"), N=require("../lib/koin-network/native-chat"), M=require("../lib/koin-network/managed-protocol"),{probe}=require("../lib/koin-network/native-probe");
const key="synthetic-provider-secret-only",now=1795500000000,model=M.models[0].model;
const scope={domain:"shadow:test",owner:"account-1",model:M.models[0].upstream};
const call={id:"call_1",type:"function",function:{name:"native_probe",arguments:'{"value":"kai_probe"}'}};
const message={role:"assistant",content:"",tool_calls:[call],reasoning_content:"PRIVATE synthetic continuation Ελληνικά"};
test("private continuation is authenticated ciphertext bound to exact call, account, domain and model",()=>{
 const token=R.seal(message,scope,key,now);assert.ok(R.valid(token));assert.ok(!token.includes("PRIVATE"));
 assert.deepEqual(R.open(token,message,scope,key,now),{reasoning_content:message.reasoning_content});
 const reordered={...message,tool_calls:[{function:{arguments:call.function.arguments,name:call.function.name},type:"function",id:call.id}]};
 assert.deepEqual(R.open(token,reordered,scope,key,now),{reasoning_content:message.reasoning_content});
 for(const s of [{...scope,owner:"other"},{...scope,model:"other"},{...scope,domain:"shadow:other"}])assert.throws(()=>R.open(token,message,s,key,now));
 for(const m of [{...message,content:"changed"},{...message,tool_calls:[{...call,id:"other"}]},{...message,tool_calls:[{...call,function:{...call.function,arguments:'{"value":"changed"}'}}]}])assert.throws(()=>R.open(token,m,scope,key,now));
 assert.throws(()=>R.open(token,message,scope,key+"rotated",now));assert.throws(()=>R.open(token,message,scope,key,now+R.TTL));
 const bytes=Buffer.from(token.slice(4),"base64url");bytes[29]^=1;assert.throws(()=>R.open("kr1."+bytes.toString("base64url"),message,scope,key,now));
});
test("replay has bounded fields and cannot become visible reasoning or arbitrary upstream metadata",()=>{
 const token=R.seal(message,scope,key,now), wire=N.unpackAnswer(N.packAnswer({...message,kai_replay:token},"tool_calls"));
 assert.equal(wire.message.reasoning_content,undefined);assert.equal(wire.message.kai_replay,token);
 assert.throws(()=>R.seal({...message,kai_replay:token},scope,key,now));
 assert.equal(R.seal({...message,tool_calls:[]},scope,key,now),undefined);
 assert.throws(()=>R.seal({...message,reasoning_content:"x".repeat(25000)},scope,key,now));
 assert.throws(()=>R.seal({...message,reasoning_content:{}},scope,key,now));
 assert.throws(()=>N.packAnswer({...message,reasoning_details:[{}]},"tool_calls"));
 assert.throws(()=>N.messages([{role:"user",content:"x",kai_replay:token}]));
});
test("qualification rejects stale, future, tampered, cross-model and rotated-key evidence",()=>{
 const value=Q.evidence(model,[{input:12,output:20},{input:40,output:5}],key,now);
 assert.equal(Q.verify(value,model,key,now),true);
 assert.equal(Q.verify(value,model,key,now+Q.TTL),false);
 assert.equal(Q.verify(value,model,key,now-1),false);
 assert.equal(Q.verify(value,model,key+"rotated",now),false);
 assert.equal(Q.verify(value,M.models[1].model,key,now),false);
 const bad=structuredClone(value);bad.record.contract="0".repeat(64);assert.equal(Q.verify(bad,model,key,now),false);
});
test("allowlist requires a private signed evidence file; deletion, expiry and insecure mode revoke capability",t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"kai-native-test-")),file=path.join(dir,"evidence.json");t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const env={KAI_NATIVE_TOOL_MODELS:model,KAI_AKASHML_API_KEY:key,KAI_NATIVE_QUALIFICATION_FILE:file};
 assert.equal(Q.capability(model,env,now),null);
 fs.writeFileSync(file,JSON.stringify({schema:1,routes:[Q.evidence(model,[{input:1,output:1},{input:1,output:1}],key,now)]}),{mode:0o600});
 assert.equal(Q.capability(model,env,now).version,2);
 assert.equal(Q.capability(model,{...env,KAI_NATIVE_TOOL_MODELS:""},now),null);
 assert.equal(Q.capability(model,env,now+Q.TTL),null);
 fs.chmodSync(file,0o644);assert.equal(Q.capability(model,env,now),null);
 fs.rmSync(file);assert.equal(Q.capability(model,env,now),null);
});
function provider(options={}) {
 let count=0;
 return {get count(){return count;},fetch:async(_url,init)=>{
  count++;const body=JSON.parse(init.body);assert.equal(body.stream,false);assert.equal(body.parallel_tool_calls,false);
  assert.ok(body.messages.every(m=>m.kai_replay===undefined&&m.kai_tools===undefined));
  const assistant=body.messages.find(m=>m.tool_calls);
  if(count===2) {assert.equal(assistant.reasoning_content,message.reasoning_content);assert.equal(body.messages.at(-1).tool_call_id,call.id);}
  const result=count===1?message:{role:"assistant",content:options.badFollowup?"invented":JSON.parse(body.messages.at(-1).content).nonce};
  return Response.json({choices:[{message:result,finish_reason:count===1?"tool_calls":"stop"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:options.badUsage?121:120}});
 }};
}
test("qualification requires two complete bounded native turns with replay and result-derived answer",async()=>{
 const p=provider(),value=await probe({model,key,maxOutput:512,fetchImpl:p.fetch,clock:()=>now});
 assert.equal(p.count,2);assert.equal(Q.verify(value,model,key,now),true);assert.equal(value.record.usage.length,2);
 assert.ok(!JSON.stringify(value).includes("PRIVATE"));
});
test("failed follow-up cannot qualify and never causes a third inference",async()=>{
 const p=provider({badFollowup:true});await assert.rejects(probe({model,key,maxOutput:512,fetchImpl:p.fetch,clock:()=>now}));assert.equal(p.count,2);
});
test("invalid first usage stops without follow-up or automatic retry",async()=>{
 const p=provider({badUsage:true});await assert.rejects(probe({model,key,maxOutput:512,fetchImpl:p.fetch,clock:()=>now}));assert.equal(p.count,1);
});
test("unapproved output escalation is rejected before supplier IO",async()=>{
 const p=provider();await assert.rejects(probe({model,key,maxOutput:999999,fetchImpl:p.fetch}));assert.equal(p.count,0);
});
