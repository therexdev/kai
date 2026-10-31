const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const {snapshot,createReader}=require('../lib/beta-network');
const health={chainId:'EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==',mainnetPaymentsEnabled:true,product:'prepaid-usd-v1'};
const data={ok:true,workersOnline:1,queueDepth:0,pendingJobs:0,models:[{model:'a',providers:1}],workers:[{address:'1LongPrivateWalletAddress',models:['a'],busy:false,lastSeenSecs:2,secrets:'not public'}]};
test('mainnet observations require identity and redact wallet details',()=>{
 const n=snapshot(data,health,100);assert.equal(n.validUntil,15100);assert.equal(n.workers[0].address,'1LongP…ress');assert.equal(n.workers[0].secrets,undefined);assert.equal(n.models[0].providers,1);
 for(const bad of [{...health,mainnetPaymentsEnabled:false},{...health,chainId:'testnet'},{}])assert.throws(()=>snapshot(data,bad,100));
 assert.throws(()=>snapshot({...data,queueDepth:-1},health,100));
});
test('reader coalesces calls, preserves observation age, fails closed after expiry',async()=>{
 let calls=0,time=100,fail=false;
 const read=createReader({now:()=>time,fetchImpl:async(url,opts)=>{calls++;assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'error');assert.deepEqual(opts.headers,{accept:'application/json'});if(fail)throw Error('offline');return new Response(JSON.stringify(url.endsWith('/health')?health:data),{headers:{'content-type':'application/json'}});}});
 const [a,b]=await Promise.all([read(),read()]);assert.deepEqual(a,b);assert.equal(calls,2);time=500;assert.equal((await read()).observedAt,100);time=11000;fail=true;await assert.rejects(read());
});
test('HTML upstream and malformed JSON never become zero stats',async()=>{
 for(const [body,type] of [['<!doctype html>','text/html'],['bad','application/json']]){const read=createReader({fetchImpl:async()=>new Response(body,{headers:{'content-type':type}})});await assert.rejects(read());}
});
test('website launch routes, links and mascot stay consistent',()=>{
 const {JSDOM}=require('jsdom');for(const file of ['index','testers','network','account','dashboard']){
 const source=fs.readFileSync(`public/${file}.html`,'utf8'),d=new JSDOM(source).window.document;
 assert.ok(d.querySelector('[src="/redesign/kai-companion.svg"],.kai-character'));
 for(const a of d.querySelectorAll('a[href]'))assert.ok(!/kaiapp\/releases/.test(a.href));
 for(const s of d.querySelectorAll('script:not([src])'))new Function(s.textContent);
 }
 const server=fs.readFileSync('server.js','utf8');assert.match(server,/app.get\("\/beta"/);assert.match(server,/"\/alpha", "\/alpha.html", "\/testers", "\/testers.html"/);
 const home=fs.readFileSync('public/index.html','utf8');assert.match(home,/KAI CORE BETA IS LIVE/);assert.doesNotMatch(home,/earn KAI for useful compute|Alpha available|Paid in KAI/);
});
test('network page rejects failures and expires successful observations',async()=>{
 const {JSDOM}=require('jsdom');const html=fs.readFileSync('public/network.html','utf8');let t=100000,interval,timeout,fail=false;
 const d=new JSDOM(html,{url:'https://kai.test/network',runScripts:'outside-only',pretendToBeVisual:true});const w=d.window;
 w.Date.now=()=>t;w.AbortSignal={timeout:()=>undefined};w.setInterval=f=>{interval=f};w.setTimeout=f=>{timeout=f};w.clearTimeout=()=>{};
 w.fetch=async()=>({ok:!fail,json:async()=>snapshot(data,health,t)});
 w.eval(fs.readFileSync('public/network.js','utf8'));await new Promise(r=>setImmediate(r));
 assert.equal(w.document.getElementById('tWorkers').textContent,'1');t+=16000;interval();assert.match(w.document.getElementById('network-state').textContent,/unconfirmed/);assert.match(w.document.getElementById('cards').textContent,/stale/);
 fail=true;await timeout();assert.equal(w.document.getElementById('tWorkers').textContent,'1');assert.match(w.document.getElementById('err').textContent,/Cannot refresh/);d.window.close();
});
