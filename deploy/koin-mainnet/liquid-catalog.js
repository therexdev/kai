"use strict";
const fs=require("node:fs"),path=require("node:path"),P=require("../../lib/koin-network/job-protocol");
const Models=require("../../lib/koin-network/model-configuration"),Readiness=require("../../lib/koin-network/runtime-readiness"),Previous=require("./model-readiness");
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function reviewed() {
  const bytes=fs.readFileSync(path.join(__dirname,"qualification/liquid-lfm3-1.7b.review.json")), review=JSON.parse(bytes),reviewHash=P.hash(bytes);
  const candidate=require("./candidates/liquid-lfm3-1.7b.json"), observationBytes=fs.readFileSync(path.join(__dirname,"candidates/liquid-lfm3-1.7b.observation.json")),observation=JSON.parse(observationBytes);
  if(review.schema!==1||review.kind!=="additive-model-catalog-review"||review.basePolicyHash!==Previous.reviewed().review.scope.policyHash||
    review.model!==candidate.tariff.model||review.modelHash!==candidate.tariff.modelHash||!same(review.tariff,candidate.tariff)||!same(review.tokenizer,candidate.tokenizer)||
    review.observationSha256!==P.hash(observationBytes)||review.nominalParametersBillions!==1.7||review.modelWeight!==String(require("../../lib/koin-network/policy").modelWeight(1.7))||review.freeEligible!==true||
    observation.fullModelSha256Verified!==true||observation.modelHash!==review.modelHash||observation.syntheticResponses!==false||observation.providerRegistered!==false||
    observation.vectors?.length!==10||observation.vectors.some(v=>v.passed!==true)||observation.results?.length!==10||
    !same(review.criteria,{kind:Readiness.KIND,version:1,minPass:2,total:2,maxOutput:256,maxLatencyMs:30000,renewBeforeMs:3600000,retryMs:300000,qualificationLifetimeMs:86400000})) throw Error("Liquid catalog review or native evidence changed");
  const seen=new Set();for(const r of observation.results){ const key=r.round+":"+r.id;
    if(!Number.isInteger(r.round)||r.round<1||r.round>5||seen.has(key)||!Readiness.CASES.some(c=>c.id===r.id)||!Readiness.answer(r.output,r.nonce)||r.passed!==true||r.stop!=="eos"||!Number.isSafeInteger(r.elapsedMs)||r.elapsedMs<1||r.elapsedMs>30000)throw Error("Liquid readiness observation failed");seen.add(key);
  }
  const policy={schema:2,kind:Readiness.KIND,model:review.model,modelHash:review.modelHash,modelWeight:review.modelWeight,coverageBps:10000,
    reviewedEvidenceHash:reviewHash,maxLatencyMs:30000,minPass:2,renewBeforeMs:3600000,retryMs:300000,cases:structuredClone(Readiness.CASES)};
  require("../../lib/koin-network/provider-qualification").policy(policy,review.tariff);
  return {review,reviewHash,policy,extension:{schema:1,policyHash:review.catalogPolicyHash,models:[{tariff:review.tariff,tokenizer:review.tokenizer}],qualificationPolicies:[policy]}};
}
function nextRuntime(bytes) {
  const original=JSON.parse(bytes),{configuration}=require("../../lib/koin-network/test-config"),c=configuration(original),r=reviewed(),scope=Previous.reviewed().review.scope;
  if(c.schema!==2||c.mode!==scope.mode||c.schedulerUrl!==scope.schedulerUrl||c.policyHash!==r.review.basePolicyHash||c.accountMode!=="public"||Object.entries(scope.deployment).some(([k,v])=>c.deployment[k]!==v)||!same(c.qualificationPolicies,Previous.reviewed().policies))throw Error("Exact reviewed live deployment and readiness policies required");
  const base=Models.entries(c),full=Models.policyHash({models:[...base,...r.extension.models],version:c.version});
  if(base.length!==15||full!==r.extension.policyHash)throw Error("Existing catalog differs from reviewed extension");
  const already=c.catalogExtension!==undefined;
  if(already&&!same(c.catalogExtension,r.extension))throw Error("Unknown existing catalog extension preserved");
  original.catalogExtension=r.extension;
  if(original.freePolicy?.eligibleModels&&!original.freePolicy.eligibleModels.includes(r.review.model))original.freePolicy.eligibleModels.push(r.review.model);
  configuration(original);
  const next=Buffer.from(JSON.stringify(original,null,2)+"\n");
  if(already&&!same(JSON.parse(bytes),original))throw Error("Installed extension has inconsistent free eligibility");
  return {bytes:already?bytes:next,already,review:{schema:1,reviewHash:r.reviewHash,models:Previous.summary([...c.qualificationPolicies,r.policy]),catalogPolicyHash:full,eligibilityCreated:false}};
}
module.exports={reviewed,nextRuntime};
