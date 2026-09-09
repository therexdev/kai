"use strict";
// Real HTTP routes + account authentication, with synthetic Composio upstream.
const assert=require("assert/strict"),fs=require("fs"),os=require("os"),path=require("path"),express=require("express");
const {ConnectionSettings,mountConnections}=require("../lib/connections");
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"kai-connections-probe-")),key="synthetic-server-composio-key",secret="synthetic-persistent-session-secret",calls=[];
 const settings=new ConnectionSettings({stateDir:dir,secret,env:{}});assert.equal(settings.status().available,false);settings.save({enabled:true,key});assert.equal(settings.status().available,true);assert.ok(!fs.readFileSync(settings.file,"utf8").includes(key));assert.ok(!JSON.stringify(settings.status()).includes(key));assert.equal(new ConnectionSettings({stateDir:dir,secret,env:{}}).config().key,key);const locked=new ConnectionSettings({stateDir:dir,secret:"wrong",env:{}});assert.equal(locked.status().available,false);assert.throws(()=>locked.save({enabled:false}),/locked/);
 const fetchImpl=async(url,init={})=>{
  calls.push({url,init});assert.equal(init.headers["x-api-key"],key);const u=new URL(url),p=u.pathname.replace("/api/v3.1","");let data;
  if(p==="/toolkits")data={items:[]};
  else if(p==="/toolkits/categories")data={items:[]};
  else if(p==="/connected_accounts")data={items:[{id:"ca_alice",user_id:"kai:alice",toolkit:{slug:"github"},status:"ACTIVE",state:{access_token:"provider-secret"}},{id:"ca_bob",user_id:"kai:bob",toolkit:{slug:"github"},status:"ACTIVE"}]};
  else if(p.startsWith("/connected_accounts/"))data={id:"ca_alice",user_id:"kai:alice",toolkit:{slug:"github"},status:"ACTIVE",state:{access_token:"provider-secret"}};
  else if(p==="/tools/GITHUB_LIST_ISSUES")data={slug:"GITHUB_LIST_ISSUES",toolkit:{slug:"github"},version:"20260901_00",tags:["readOnlyHint"],input_parameters:{type:"object",properties:{}}};
  else if(p==="/tools/execute/GITHUB_LIST_ISSUES"){const b=JSON.parse(init.body);assert.equal(b.user_id,"kai:alice");data={successful:true,data:{items:["Issue"]}};}
  else throw new Error("Unexpected upstream route "+p);
  return new Response(JSON.stringify(data));
 };
 const app=express();app.use(express.json({limit:"24kb"}));
 const accounts={requireAccount(req,res){const token=req.headers.authorization;if(!["Bearer alice-token","Bearer bob-token"].includes(token)){res.status(401).json({ok:false});return null;}return{id:token.includes("alice")?"alice":"bob"};}};
 const requireAdmin=(req,res,next)=>req.headers.authorization==="Bearer admin-token"?next():res.status(401).json({ok:false});
 mountConnections({app,accounts,requireAdmin,stateDir:dir,secret,siteOrigin:"https://kai.example",env:{},fetchImpl});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));const base="http://127.0.0.1:"+server.address().port;
 const request=async(route,token,body,origin)=>{const r=await fetch(base+route,{method:body?"POST":"GET",headers:{...(token?{authorization:"Bearer "+token}:{}),"content-type":"application/json",...(origin?{origin}: {})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json()};};
 try{
  let r=await request("/connections/status");assert.equal(r.data.available,true);assert.ok(!JSON.stringify(r.data).includes(key));const generation=r.data.generation;
  r=await request("/connections/api/accounts",null,{});assert.equal(r.status,401);assert.equal(calls.length,0);
  r=await request("/admin/api/connections",null);assert.equal(r.status,401);
  r=await request("/admin/api/connections","admin-token",{enabled:false},"https://evil.example");assert.equal(r.status,403);
  r=await request("/connections/api/accounts","alice-token",{userId:"kai:bob",user_id:"kai:bob",generation});assert.deepEqual(r.data.result.accounts.map(a=>a.id),["ca_alice"]);assert.ok(!JSON.stringify(r.data).includes("provider-secret"));assert.match(calls.at(-1).url,/user_ids=kai%3Aalice/);
  for(const action of ["disconnect","execute"]){r=await request("/connections/api/"+action,"bob-token",{id:"ca_alice",tool:"GITHUB_LIST_ISSUES",arguments:{},generation});assert.equal(r.status,403);}
  assert.ok(!calls.some(c=>c.init.method==="DELETE"||c.url.includes("/execute/")));
  r=await request("/connections/api/execute","alice-token",{id:"ca_alice",tool:"GITHUB_LIST_ISSUES",version:"20260901_00",arguments:{},userId:"kai:bob",generation});assert.equal(r.status,200);assert.match(r.data.result,/Issue/);
  r=await request("/connections/api/accounts","alice-token",{generation:"stale-project"});assert.equal(r.status,409);
  r=await request("/connections/api/proxy","alice-token",{url:"https://elsewhere"});assert.equal(r.status,404);
  r=await request("/admin/api/connections","admin-token",{enabled:false},"https://kai.example");assert.equal(r.status,200);assert.equal(r.data.available,false);
  const n=calls.length;r=await request("/connections/api/accounts","alice-token",{});assert.equal(r.status,503);assert.equal(calls.length,n);
  const source=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");assert.match(source,/mountConnections\(\{ app, accounts, requireAdmin: requireAuth/);assert.match(source,/app.use\("\/connections\/api", express.json/);
  console.log("PASS: encrypted server settings; admin authentication/CSRF; disabled mode; account isolation; credential stripping; bounded action routes; project changes; actual server wiring");
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
