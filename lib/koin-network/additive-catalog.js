"use strict";
// A new catalog commitment never replaces the durable payment/provider target.
// Existing models keep their exact old quotes and qualification evidence.
const P = require('./job-protocol'), Models = require('./model-configuration');
const { Meter } = require('./metering');
function extension(config) {
  const value = config.catalogExtension;
  if (value === undefined) return null;
  if (config.schema !== 2 || !require('./product').isUsd(config.deployment) || !value ||
      Object.keys(value).sort().join() !== 'models,policyHash,qualificationPolicies,schema' || value.schema !== 1)
    throw Error('Exact additive USD catalog extension required');
  if (!Array.isArray(config.qualificationPolicies)) throw Error("Catalog extensions require existing per-model readiness policies");
  const base = Models.entries(config), added = Models.entries({models:value.models,version:config.version});
  if (base.length + added.length > 64 || added.some(a => base.some(b => a.tariff.model === b.tariff.model))) throw Error('Catalog extensions may only add new model aliases');
  const policyHash = Models.policyHash({models:[...base,...added],version:config.version});
  if (P.digest(value.policyHash) !== policyHash || policyHash === config.policyHash) throw Error('Additive catalog commitment mismatch');
  if (!Array.isArray(value.qualificationPolicies) || value.qualificationPolicies.length !== added.length) throw Error('Each added model requires a readiness policy');
  const seen = new Set();
  for (const policy of value.qualificationPolicies) {
    const tariff = added.find(e=>e.tariff.model===policy?.model)?.tariff;
    if (!tariff || seen.has(policy.model) || !require('./runtime-readiness').isPolicy(policy)) throw Error('Unique added-model readiness policy required');
    require('./provider-qualification').policy(policy,tariff);seen.add(policy.model);
  }
  return {schema:1,policyHash,models:added,qualificationPolicies:structuredClone(value.qualificationPolicies)};
}
class AdditiveMeter {
  constructor(base, added, expectedHash) {
    if (!(base instanceof Meter) || !Array.isArray(added) || !added.length) throw Error('Explicit base meter and additions required');
    const old=base.tariffs();
    if (added.some(e=>old.some(t=>t.model===e.tariff.model))) throw Error('Existing tariffs cannot be replaced by an extension');
    this.base=base;this.full=new Meter([...old.map(tariff=>({tariff,adapter:{...base.entry(tariff.model,tariff.version),...tariff}})),...added]);
    if (this.full.policyHash!==expectedHash)throw Error('Additive runtime catalog hash mismatch');
    this.policyHash=base.policyHash;this.catalogPolicyHash=expectedHash;this.added=new Set(added.map(e=>e.tariff.model));
  }
  forModel(model){return this.added.has(model)?this.full:this.base;}
  catalogMeter(hash=this.policyHash){if(hash===this.policyHash)return this.base;if(hash===this.catalogPolicyHash)return this.full;throw Error('Unknown requested catalog commitment');}
  tariffs(){return this.full.tariffs();}
  entry(model,version){return this.forModel(model).entry(model,version);}
  quote(domain,model,...args){return this.forModel(model).quote(domain,model,...args);}
  measure(quote,output){if(quote.policyHash!==this.forModel(quote.tariff.model).policyHash)throw Error('Quote catalog changed');return this.forModel(quote.tariff.model).measure(quote,output);}
}
function targetForModel(target,meter,model){return {...target,policyHash:meter.forModel?meter.forModel(model).policyHash:target.policyHash};}
function quoteTarget(target,meter,quote){const wanted=targetForModel(target,meter,quote.tariff.model);if(quote.policyHash!==wanted.policyHash)throw Error('Job catalog differs from approved model');return wanted;}
function catalogMeter(meter,hash){if(meter.catalogMeter)return meter.catalogMeter(hash);if(hash!==undefined&&hash!==meter.policyHash)throw Error('Unknown requested catalog commitment');return meter;}
module.exports={extension,AdditiveMeter,targetForModel,quoteTarget,catalogMeter};
