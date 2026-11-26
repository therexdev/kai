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

test("qualification uses the selected release's probe and working directory",()=>{
  const { productionProbe }=require("./qualify-native-models"),{ RELEASES }=require("./native-rollout-release");
  for (const release of RELEASES) {
    let calls=0;
    assert.deepEqual(productionProbe(MODELS[0],2048,release,(exe,args,options)=>{
      calls++;assert.equal(exe,"runuser");assert.equal(options.cwd,release);
      assert.ok(args.includes(release+"/deploy/koin-mainnet/check-native-tools.js"));
      assert.deepEqual(args.slice(-4),[MODELS[0],"--probe","--max-output","2048"]);
      assert.ok(!args.some(a=>a.startsWith("KAI_NATIVE_TOOL_MODELS=")));
      return JSON.stringify(result(MODELS[0]));
    }),result(MODELS[0]));
    assert.equal(calls,1);
  }
  assert.throws(()=>productionProbe(MODELS[0],2048,"/unreviewed",()=>assert.fail("No supplier call")),/Unsupported/);
});
test("service guard failure aborts before the first or next model without retries",async()=>{
  for (const allowed of [0,1]) {
    let calls=0;
    await assert.rejects(qualify({models:MODELS,maxOutput:2048,log:()=>{},
      guard:()=>{if(calls===allowed)throw Error("Installed release changed");},
      probe:async m=>{calls++;return result(m);}}),/Installed release changed/);
    assert.equal(calls,allowed);
  }
});
