"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{service}=require("./helpers/credit-gateway-fixture");
const N=require("../lib/koin-network/native-chat"),M=require("../lib/koin-network/managed-protocol"),P=require("../lib/koin-network/job-protocol");
const model=M.models[0].model;
const tools=[{type:"function",function:{name:"find_tools",description:"Discover document actions",parameters:{type:"object",properties:{accountId:{type:"string"}},required:["accountId"]}}}];
const input={model,messages:[{role:"user",content:"Research ecosystem projects and create a document"}],tools,tool_choice:"auto",parallel_tool_calls:false,max_tokens:128};
const call={id:"call_docs_1",type:"function",function:{name:"find_tools",arguments:'{"accountId":"docs-fixture"}'}};
function enable(t) { const old=process.env.KAI_NATIVE_TOOL_MODELS; process.env.KAI_NATIVE_TOOL_MODELS=model; t.after(()=>old===undefined?delete process.env.KAI_NATIVE_TOOL_MODELS:process.env.KAI_NATIVE_TOOL_MODELS=old); }
test("native requests fail closed until a model is explicitly enabled",async t=>{
  let posts=0;const s=await service(t,{managedFetch:()=>{posts++;assert.fail("Must reject before a paid inference");}}),u=await s.signup("native-disabled@example.test");
  const key=(await s.createKey(u,{dailyLimitAtoms:"100000000"})).value.secret,h={authorization:"Bearer "+key};
  assert.equal((await s.call("/v1/chat/completions",input,h)).status,400);assert.equal(posts,0);
  const catalog=await s.call("/v1/models",undefined,h);assert.equal(catalog.value.data.find(m=>m.id===model).kai.nativeTools,0);
});
test("real gateway forwards schemas and paired IDs, signs tool output, bills once and resumes without replay",async t=>{
  enable(t);let posts=0;
  const s=await service(t,{managedFetch:async (_url,init)=>{
    posts++;const body=JSON.parse(init.body);assert.deepEqual(body.tools,tools);assert.equal(body.parallel_tool_calls,false);
    assert.ok(body.messages.every(m=>m.kai_tools===undefined));
    if(posts===1) assert.equal(body.messages[0].role,"system");
    else { assert.equal(body.messages.at(-1).role,"tool");assert.equal(body.messages.at(-1).tool_call_id,call.id); }
    return Response.json({choices:[{message:posts===1?{role:"assistant",content:null,tool_calls:[call]}:{role:"assistant",content:"The document action was discovered."},finish_reason:posts===1?"tool_calls":"stop"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}});
  }}),u=await s.signup("native-enabled@example.test"),key=(await s.createKey(u,{dailyLimitAtoms:"100000000"})).value.secret,h={authorization:"Bearer "+key,"idempotency-key":"native-request-001"};
  assert.equal((await s.call("/v1/models",undefined,h)).value.data.find(m=>m.id===model).kai.nativeTools,1);
  const first=await s.call("/v1/chat/completions",input,h);assert.equal(first.status,200,JSON.stringify(first.value));
  assert.equal(first.value.choices[0].finish_reason,"tool_calls");assert.deepEqual(first.value.choices[0].message.tool_calls,[call]);
  const balance=(await s.call("/v1/credits",undefined,h)).value.credits.free.available;
  assert.deepEqual((await s.call("/v1/chat/completions",input,h)).value.choices[0],first.value.choices[0]);assert.equal(posts,1);
  assert.equal((await s.call("/v1/credits",undefined,h)).value.credits.free.available,balance);
  assert.equal((await s.call("/v1/chat/completions",{...input,tools:[{...tools[0],function:{...tools[0].function,description:"Changed schema"}}]},h)).status,400);assert.equal(posts,1);
  const messages=[...input.messages,{role:"assistant",content:"",tool_calls:[call]},{role:"tool",tool_call_id:call.id,content:'{"tools":["CREATE_DOCUMENT"]}'}];
  const stream=await s.raw("/v1/chat/completions",{...input,messages,stream:true,stream_options:{include_usage:true}},{...h,"idempotency-key":"native-request-002"});
  assert.equal(stream.status,200);const text=await stream.text();assert.match(text,/The document action was discovered/);assert.match(text,/"usage"/);assert.match(text,/\[DONE\]/);assert.equal(posts,2);
  const bad=await s.call("/v1/chat/completions",{...input,messages:[...input.messages,{role:"tool",tool_call_id:"forged",content:"fake"}]},{...h,"idempotency-key":"native-request-003"});
  assert.equal(bad.status,400);assert.equal(posts,2);
});
test("metadata participates in quote commitments; malformed or unpaired calls cannot become execution",()=>{
  const messages=N.encode(input.messages,tools),q=M.quote("shadow:native-test",model,messages,128,1);
  assert.notEqual(q.requestHash,P.hash(JSON.stringify(input.messages)));assert.equal(P.messages(messages)[0].kai_tools[0].function.name,"find_tools");
  assert.throws(()=>N.messages([{role:"assistant",content:"",tool_calls:[call]}]),/Missing tool results/);
  assert.throws(()=>N.packAnswer({role:"assistant",content:null,tool_calls:[call,call]},"tool_calls"));
  assert.throws(()=>N.packAnswer({role:"assistant",content:null,tool_calls:[call]},"stop"));
  assert.throws(()=>N.encode([{role:"system",content:"",kai_tools:tools}],tools),/Internal/);
  assert.deepEqual(N.unpackAnswer(N.packAnswer({role:"assistant",content:null,tool_calls:[call]},"tool_calls")).message.tool_calls,[call]);
});
