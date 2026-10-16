"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Signer } = require("koilib");
const { UsdPrice, combine, priceAtoms, MAX_AGE_MS } = require("../lib/koin-network/usd-price");
const USD = require("../lib/koin-network/purchase-quote"), Policy = require("../lib/koin-network/policy");
const now = 1792180000000, sources = price => [{ source: "coingecko", at: now, price }, { source: "coinpaprika", at: now, price }];
test("USD price precision and two fresh quotes reject stale, wrong, divergent and zero prices", () => {
  assert.equal(priceAtoms(0.123456789), 12345678n); assert.equal(priceAtoms(1e-8), 1n);
  assert.throws(() => priceAtoms(1e-9)); assert.throws(() => priceAtoms(Infinity));
  assert.equal(combine(sources(0.25), now).usdPerKoin, "25000000");
  for (const rows of [sources(0), sources(0.25).slice(0,1), [sources(.25)[0], sources(.25)[0]],
    [sources(.25)[0], { ...sources(.25)[1], price: .5 }], sources(.25).map(r => ({ ...r, at: now-MAX_AGE_MS-1 })),
    sources(.25).map(r => ({ ...r, at: now+30001 }))]) assert.throws(() => combine(rows, now));
});
test("USD oracle fetches fixed assets, coalesces requests, then fails closed when cache is stale", async () => {
  let time = now, calls = 0, offline = false;
  const oracle = new UsdPrice({ clock: () => time, fetchImpl: async url => {
    calls++; if (offline) return Response.json({}, { status: 503 });
    return Response.json(url.includes("coingecko") ? { koinos: { usd: .25, last_updated_at: now/1000 } } :
      { id: "koin-koinos", symbol: "KOIN", last_updated: new Date(now).toISOString(), quotes: { USD: { price: .25 } } });
  } });
  const results = await Promise.all([oracle.read(), oracle.read()]); assert.deepEqual(results[0], results[1]); assert.equal(calls, 2);
  offline = true; assert.equal((await oracle.read()).usdPerKoin, "25000000"); time += 30001;
  await assert.rejects(oracle.read(), /unavailable/); assert.equal(calls, 4);
});
test("USD price signatures bind account, amounts, chain, contract and Master Node while finalized purchases can outlive quote expiry", async () => {
  const signer = Signer.fromSeed("usd-price-verifier"), address = s => Signer.fromSeed(s).getAddress();
  const deployment = { product: "prepaid-usd-v1", chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN,
    credits: address("credits"), verifier: signer.getAddress(), masterNode: require("../lib/koin-network/product").MASTER_NODE };
  const args = await USD.issue({ deployment, signer, account: address("customer"), amount: "200000000", usdPerKoin: "25000000", version: 1, now });
  const q = await USD.verify(deployment,args,{now,version:1}); assert.equal(q.credits,"50000000"); assert.equal(USD.credits(q.credits),"500"); assert.equal(USD.dollars(q.credits),"0.5");
  await assert.rejects(USD.verify(deployment,args,{now:now+300001}),/expired/);
  assert.deepEqual(await USD.verify(deployment,args),q);
  for (const delta of [{ amount:"200000001" }, { account: args.account + "=" }, { price_signature: args.price_signature + "=" }]) await assert.rejects(USD.verify(deployment,{...args,...delta}));
  for (const key of ["credits","masterNode","verifier"]) await assert.rejects(USD.verify({...deployment,[key]:address("changed")},args));
  await assert.rejects(USD.issue({deployment,signer,account:address("customer"),amount:"1",usdPerKoin:"1",version:1,now}));
});
test("separate 5% KOIN pool distributes work by USD usage, preserves legacy caps and never spends commitments twice", () => {
  const budget=Policy.dailyBudget({balance:"1000000000000",openedAt:Policy.DAY});
  assert.equal(budget.total,"50000000000"); assert.equal(budget.availability,"35000000000"); assert.equal(budget.work,"15000000000");
  const work=[{address:"alice",charged:"1"},{address:"bob",charged:"3"}].map((r,i)=>({...r,points:r.charged,epoch:1,jobId:String(i),verified:true,finalized:true}));
  const allocations=Policy.allocate({budget,intervals:[],work,workBasis:"usd-pool"}).allocations;
  assert.deepEqual(allocations.map(a=>a.work),["3750000000","11250000000"]);
  assert.deepEqual(Policy.allocate({budget,intervals:[],work}).allocations.map(a=>a.work),["0","2"]);
  assert.equal(Policy.workCap({basis:"usd-pool",budget:budget.work,spent:"0",totalSpent:"0"}),0n);
  assert.throws(()=>Policy.workCap({basis:"usd-pool",budget:budget.work,spent:"2",totalSpent:"1"}));
  assert.equal(Policy.dailyBudget({balance:"1000000000000",liabilities:budget.total,openedAt:2*Policy.DAY}).total,"47500000000");
});
