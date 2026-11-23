"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{service}=require("./helpers/credit-gateway-fixture"),{CreditVault}=require("../lib/credit-vault");
async function setup(t){
 const s=await service(t),alice=await s.signup("vault-alice@example.test"),bob=await s.signup("vault-bob@example.test");
 const session={sessionId:"fixture-session",secret:"secret-for-fixture-connection",expiresAt:Date.now()+600000};
 const address=s.f.buyer.getAddress();let requests=0,uncertain=false,connected=true,origin=s.auth.service.siteOrigin;
 const fetcher=async(url,options)=>{
  assert.equal(options.headers.Origin,s.auth.service.siteOrigin);assert.equal(options.redirect,"error");
  const path=url.pathname;let value;
  if(path==="/api/config") value={ok:true,network:"mainnet",features:{openDappConnections:true,dappReviewVersion:1}};
  if(path==="/api/dapp/create")value={ok:true,...session,uri:`https://koinvault.app/?connect=${session.sessionId}&secret=${session.secret}`};
  if(path==="/api/dapp/status")value={ok:true,id:session.sessionId,origin,expiresAt:session.expiresAt,connected,address:connected?address:null};
  if(path==="/api/dapp/request") {requests++;const body=JSON.parse(options.body);assert.equal(body.mana,"wallet");assert.deepEqual(body.operations,[{call_contract:{contract_id:"credits",entry_point:1,args:"AA"}}]);if(uncertain)throw Error("socket closed");value={ok:true,requestId:"purchase-request"};}
  if(path==="/api/dapp/request-status")value={ok:true,status:"approved",txid:"0x1220"+"a".repeat(64)};
  assert.ok(value);return{ok:true,text:async()=>JSON.stringify(value)};
 };
 const vault=new CreditVault(s.auth.service,{fetcher});
 return{...s,alice,bob,vault,session,address,requests:()=>requests,setUncertain:()=>{uncertain=true;},setOrigin:()=>{origin="https://evil.invalid";},setConnected:v=>{connected=v;}};
}
test("device sign-in shares website credits, supports native chat, and logout revokes",async t=>{
 const s=await service(t),user=await s.signup("device@example.test");
 const start=(await s.call("/auth/device/start",{})).value;
 assert.equal((await s.call("/auth/device/poll",start)).value.pending,true);
 assert.equal((await s.call("/auth/device/approve",{userCode:start.userCode},{cookie:user.cookie})).status,200);
 const session=(await s.call("/auth/device/poll",start)).value;const headers={authorization:"Bearer "+session.token};
 const overview=await s.call("/platform/api/overview",undefined,headers);assert.equal(overview.value.account.id,user.account.id);assert.ok(overview.value.models[0].contextTokens>0);
 const pending=s.call("/platform/api/chat",{model:"fixture",messages:[{role:"user",content:"Hi"}],max_tokens:16,creditWallet:null,freeOnly:true},headers);
 const job=await s.dispatch();await s.result(job);assert.equal((await pending).value.choices[0].message.content,"Hello");
 assert.equal((await s.call("/platform/api/overview",undefined,headers)).value.credits.free.available,(await s.call("/platform/api/overview",undefined,{cookie:user.cookie})).value.credits.free.available);
 await s.call("/auth/logout",{},headers);assert.equal((await s.call("/platform/api/overview",undefined,headers)).status,401);
});
test("Vault ownership is server verified and bound to the initiating account",async t=>{
 const s=await setup(t);await s.vault.connect(s.alice.account);
 assert.ok(!JSON.stringify(s.auth.service.db.prepare("SELECT * FROM credit_vault_links").all()).includes(s.session.secret));
 await assert.rejects(()=>s.vault.status(s.bob.account,s.session),/Reconnect/);
 s.setConnected(false);assert.equal((await s.vault.status(s.alice.account,s.session)).connected,false);assert.equal(s.auth.service.accountView(s.alice.account).wallets.length,0);
 s.setConnected(true);assert.equal((await s.vault.status(s.alice.account,s.session)).address,s.address);
 assert.equal(s.auth.service.accountView(s.alice.account).wallets[0].address,s.address);
 s.auth.service.unlinkWallet(s.alice.account,s.address);await assert.rejects(()=>s.vault.status(s.alice.account,s.session),/unlinked/);
});
test("Vault rejects origin mismatch and never accepts client supplied ownership",async t=>{
 const s=await setup(t);await s.vault.connect(s.alice.account);s.setOrigin();
 await assert.rejects(()=>s.vault.status(s.alice.account,{...s.session,address:s.address}),/matches/);
 assert.equal(s.auth.service.accountView(s.alice.account).wallets.length,0);
});
test("Vault cannot take over another account's wallet without existing Core credit consent",async t=>{
 const s=await setup(t);await s.link(s.bob);await s.vault.connect(s.alice.account);
 await assert.rejects(()=>s.vault.status(s.alice.account,s.session),/credit access from Core/);
 assert.equal(s.auth.service.accountView(s.alice.account).wallets.length,0);
 assert.equal(s.auth.service.accountView(s.bob.account).wallets[0].address,s.address);
 assert.equal(s.requests(),0);
});
test("Core-linked Vault purchases preserve the original owner and revocation blocks new requests",async t=>{
 const s=await setup(t);await s.link(s.bob);
 const ts=Date.now(),hash=require("node:crypto").createHash("sha256").update(require("../lib/credit-wallet-links").message(s.base,s.address,s.alice.account.id,ts)).digest();
 s.auth.service.creditLinks.link(s.alice.account,{address:s.address,ts,signature:Buffer.from(await s.f.buyer.signHash(hash)).toString("base64")});
 await s.vault.connect(s.alice.account);
 const input={...s.session,quoteId:quote(s).vaultQuoteId};
 await s.vault.request(s.alice.account,input);await s.vault.request(s.alice.account,input);assert.equal(s.requests(),1);
 assert.equal(s.auth.service.accountView(s.alice.account).wallets.length,0);
 assert.equal(s.auth.service.creditAccountView(s.alice.account).wallets[0].creditAccountId,s.bob.account.id);
 assert.equal(s.auth.service.accountView(s.bob.account).wallets[0].address,s.address);
 const next={...s.session,quoteId:quote(s).vaultQuoteId};
 s.auth.service.creditLinks.unlink(s.alice.account,s.address);
 await assert.rejects(()=>s.vault.request(s.alice.account,next),/unlinked/);
 await assert.rejects(()=>s.vault.request(s.alice.account,input),/unlinked/);assert.equal(s.requests(),1);
 assert.equal(s.auth.service.creditAccountView(s.alice.account).wallets.length,0);
 assert.equal(s.auth.service.accountView(s.bob.account).wallets[0].address,s.address);
});
test("Vault cannot reassign a removed Core wallet's remembered funding identity",async t=>{
 const s=await setup(t);s.auth.service.configureWalletCredits({target:s.f.target,schedulerUrl:s.base+"/scheduler"});
 await s.link(s.bob);s.auth.service.unlinkWallet(s.bob.account,s.address);
 await s.vault.connect(s.alice.account);await assert.rejects(()=>s.vault.status(s.alice.account,s.session),/original account link/);
 assert.equal(s.auth.service.accountView(s.alice.account).wallets.length,0);
 assert.equal(s.auth.service.db.prepare("SELECT account_id FROM wallet_credit_identities WHERE address=?").get(s.address).account_id,s.bob.account.id);
});
function quote(s){return s.vault.rememberQuote(s.alice.account,{signerAddress:s.address,expiresAt:Date.now()+600000,transaction:{operations:[{call_contract:{contract_id:"credits",entry_point:1,args:"AA"}}]}});}
test("Vault requests use reviewed server operations and duplicate reads do not submit twice",async t=>{
 const s=await setup(t);await s.vault.connect(s.alice.account);const q=quote(s),input={...s.session,quoteId:q.vaultQuoteId,operations:["injected"]};
 const r=await s.vault.request(s.alice.account,input);assert.equal(r.requestId,"purchase-request");await s.vault.request(s.alice.account,input);assert.equal(s.requests(),1);
 const result=await s.vault.result(s.alice.account,{...s.session,requestId:r.requestId});assert.equal(result.status,"approved");assert.equal(result.wallet,s.address);
 await assert.rejects(()=>s.vault.result(s.bob.account,{...s.session,requestId:r.requestId}),/Reconnect/);
});
test("ambiguous wallet request persists across restart and cannot be replayed",async t=>{
 const s=await setup(t);await s.vault.connect(s.alice.account);const q=quote(s);s.setUncertain();
 const input={...s.session,quoteId:q.vaultQuoteId};await assert.rejects(()=>s.vault.request(s.alice.account,input),/unknown/);
 await assert.rejects(()=>s.vault.request(s.alice.account,input),/uncertain/);assert.equal(s.requests(),1);
 assert.equal(s.auth.service.db.prepare("SELECT state FROM credit_vault_quotes WHERE id=?").get(q.vaultQuoteId).state,"submitting");
});
