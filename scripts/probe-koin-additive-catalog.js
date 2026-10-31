"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),P=require('../lib/koin-network/job-protocol');
const {fixture}=require('./helpers/koin-prepaid-fixture'),{Meter}=require('../lib/koin-network/metering'),{AdditiveMeter}=require('../lib/koin-network/additive-catalog');
function addition(f){const tariff={...f.tariff,model:'new-model',modelHash:P.hash('new-model')},encode=s=>[...Buffer.from(s)],adapter={...tariff,render:JSON.stringify,encode,input:m=>encode(JSON.stringify(m)).length,output:s=>encode(s).length};
 const full=new Meter([{tariff:f.tariff,adapter:{...f.meter.entry('fixture',1),...f.tariff}},{tariff,adapter}]);return new AdditiveMeter(f.meter,[{tariff,adapter}],full.policyHash);}
test('additive catalog keeps durable credit identity, previous quotes, balances and recovery across restart',async t=>{
 const f=fixture(t);f.purchase();const before=f.ledger.reserve(f.request('old')),ready=await f.complete(before.id);f.ledger.acknowledge(ready.id,f.owner,ready.receiptHash);
 const spent=f.ledger.balance(f.owner).spent,identity=f.ledger.db.prepare('SELECT data FROM identity').get().data;
 const meter=addition(f);f.options.meter=meter;f.restart();
 assert.equal(f.ledger.db.prepare('SELECT data FROM identity').get().data,identity);assert.equal(f.ledger.balance(f.owner).spent,spent);
 assert.deepEqual(f.ledger.job(before.id).quote,before.quote);assert.equal(f.ledger.decrypt(before.id,f.ledger.job(before.id).answer),'Private answer');
 assert.deepEqual(meter.quote(f.target.domain,'fixture',1,[{role:'user',content:'hi'}],16,10000),f.meter.quote(f.target.domain,'fixture',1,[{role:'user',content:'hi'}],16,10000));
 const j=f.ledger.reserve({...f.request('new'),model:'new-model'}),d=f.ledger.dispatch(j.id,f.provider),output='New answer';
 assert.equal(d.quote.policyHash,meter.catalogPolicyHash);assert.equal(f.ledger.jobTarget(d).policyHash,meter.catalogPolicyHash);
 const hash=require('../lib/koin-network/funded-protocol').fundedResultHash;
 assert.throws(()=>f.ledger.complete(j.id,{output,signature:'invalid'},true));
 const r=f.ledger.complete(j.id,{output,signature:Buffer.from(await f.worker.signHash(hash(f.ledger.jobTarget(d),d,output))).toString('base64')},true);
 f.ledger.acknowledge(j.id,f.owner,r.receiptHash);f.restart();assert.equal(f.ledger.job(j.id).quote.policyHash,meter.catalogPolicyHash);
 assert.equal(f.ledger.balance(f.owner).spent,String(BigInt(spent)+BigInt(r.receipt.usage.amount)));
});
test('legacy catalog stays exact; only explicit approved negotiation receives new aliases',t=>{const f=fixture(t),meter=addition(f),catalog=hash=>require('../lib/koin-network/model-catalog').modelCatalog({meter,target:f.target,catalogPolicyHash:hash});
 assert.equal(catalog().policyHash,f.target.policyHash);assert.deepEqual(catalog().tariffs,f.meter.tariffs());
 assert.equal(catalog(meter.catalogPolicyHash).tariffs.length,2);assert.equal(catalog(meter.catalogPolicyHash).models[1].available,false);
 assert.throws(()=>catalog(P.hash('unknown')),/Unknown/);assert.throws(()=>meter.measure({...f.meter.quote(f.target.domain,'fixture',1,[{role:'user',content:'hi'}],16,10000),policyHash:meter.catalogPolicyHash},'answer'),/changed/);
 assert.throws(()=>require('../lib/koin-network/model-catalog').modelCatalog({meter,target:{...f.target,policyHash:P.hash('wrong')}}),/differs/);
});
test('reviewed Liquid addition preserves base tariffs, policies and all account settings',()=>{
 const Previous=require('../deploy/koin-mainnet/model-readiness'),scope=Previous.reviewed().review.scope;
 const config={schema:2,mode:scope.mode,schedulerUrl:scope.schedulerUrl,policyHash:scope.policyHash,version:1,accountMode:'public',deployment:{schema:1,decimals:8,rpc:['https://api.koinosai.com','https://api.koinos.io'],...scope.deployment,token:'19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK',tokenHash:'0x1220eb38ea471cf855ff4d336e51bf47df8cfc8a0a9ae49193b0d7e103b890d464d6',admin:'1EZFE7yY9waCFR454BkKmxbehQLUvEDDpK',verifier:'1HdgLvVRbvrwnF547sbEbmSu5USTu7Gy1K',mining:'1G4L15H3TWKUzzg9i3CV5w97exuvQ6vNVz',operations:'1PVLC9iF1rZ1zxEQDLJiniXL973GPateK8'},roles:{settlement:'1P9pLR3fLqBUwT2tuShBdpBBQEaarcFRE1',lifecycle:'1NgDtrzJfPwdaWskKMfWVvjJQmW4dLdvYw',claims:'1NMaeSzHS9rZsAMK9FZTZt2vGMcSzr7pDr'},models:structuredClone(require('../deploy/koin-mainnet/settings.prepaid-usd.models.example.json').settings.models),maxRcPerTransaction:'100000000',maxRcPerDay:'500000000',qualificationPolicies:Previous.reviewed().policies};
 const L=require('../deploy/koin-mainnet/liquid-catalog'),next=L.nextRuntime(Buffer.from(JSON.stringify(config))),changed=JSON.parse(next.bytes);
 assert.equal(next.review.models.length,16);assert.equal(changed.catalogExtension.models[0].tariff.model,'lfm3-1.7b');delete changed.catalogExtension;assert.deepEqual(changed,config);
 assert.equal(L.nextRuntime(next.bytes).already,true);const bad=JSON.parse(next.bytes);bad.catalogExtension.models[0].tariff.model=config.models[0].tariff.model;assert.throws(()=>L.nextRuntime(Buffer.from(JSON.stringify(bad))));
});
