"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const { qualify }=require("./qualify-native-models"),{ MODELS }=require("./activate-qualified-native");
const result=model=>({model,qualified:true,protocol:2,calls:2,enabled:false});
test("all six routes receive one bounded qualification, without activation",async()=>{
  const calls=[];
  const r=await qualify({models:MODELS,maxOutput:2048,log:()=>{},probe:async(m,b)=>{calls.push([m,b]);return result(m);}});
  assert.deepEqual(calls,MODELS.map(m=>[m,2048]));assert.deepEqual(r.passed,MODELS);assert.equal(r.maxSupplierCalls,12);assert.equal(r.enabled,false);
});
test("failed or malformed routes are excluded, never retried and do not hide passing routes",async()=>{
  let count=0;
  const r=await qualify({models:MODELS,maxOutput:1024,log:()=>{},probe:async m=>{count++;if(m===MODELS[0])throw Error("secret supplier details");if(m===MODELS[1])return result(MODELS[0]);return result(m);}});
  assert.equal(count,6);assert.deepEqual(r.failed,MODELS.slice(0,2));assert.deepEqual(r.passed,MODELS.slice(2));
});
test("invalid limits and model lists fail before a supplier call",async()=>{
  let calls=0;
  for(const config of [{models:["unknown"],maxOutput:2048},{models:MODELS,maxOutput:9000},{models:MODELS,maxOutput:511}])
    await assert.rejects(qualify({...config,probe:()=>{calls++;},log:()=>{}}));
  assert.equal(calls,0);
});

test("qualification refuses a different installed release before changing route evidence",()=>{
  const { verifyInstalled }=require("./qualify-native-models"),{ RELEASE }=require("./activate-qualified-native");
  verifyInstalled((_,args)=>args.at(-1)==="--property=WorkingDirectory" ? RELEASE : "kai-koin-prepaid");
  assert.throws(()=>verifyInstalled(()=>"other-release"),/qualification was not changed/);
});
