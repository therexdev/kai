"use strict";
// Local real-model evidence only. Does not register a provider, change live
// configuration, transfer funds, or edit any credit/provider database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),net=require('node:net');
const {spawn}=require('node:child_process');
const candidate=require('../deploy/koin-mainnet/candidates/liquid-lfm3-1.7b.json');
const G=require('../lib/koin-network/gguf-tokenizer'),R=require('../lib/koin-network/runtime-readiness');
const {loadTokenizer}=require('../lib/koin-network/tokenizer');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fileHash(file){const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
async function main(){
 const [model,binary,output]=process.argv.slice(2);
 if(!model||!binary||!output)throw Error('Usage: node scripts/measure-koin-lfm3-readiness.js <pinned.gguf> <pinned-linux-x64-llama-server> <new-output-directory>');
 assert.equal(fs.statSync(model).size,candidate.tokenizer.artifactSource.modelSize);assert.equal(await fileHash(model),candidate.tariff.modelHash,'Full model hash');
 assert.equal(await fileHash(binary),candidate.runtime.binarySha256,'Pinned Linux x64 runtime hash');
 fs.mkdirSync(output,{recursive:false});
 const prefix=Buffer.alloc(candidate.tokenizer.artifactSource.prefixBytes),fd=fs.openSync(model,'r');
 try{assert.equal(fs.readSync(fd,prefix,0,prefix.length,0),prefix.length);}finally{fs.closeSync(fd);}
 const artifacts=G.derive(prefix,candidate.tokenizer.artifactSource);
 for(const [name,data]of Object.entries(artifacts))fs.writeFileSync(path.join(output,name),data,{flag:'wx'});
 const adapter=loadTokenizer(output,candidate.tokenizer);
 const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const args=['-m',path.resolve(model),'--host','127.0.0.1','--port',String(port),'-ngl','0','-c','4096','-t','4','-np','1','--no-context-shift'];
 const child=spawn(path.resolve(binary),args);let logs='',spawnError;child.once('error',e=>spawnError=e);for(const stream of[child.stdout,child.stderr])stream.on('data',data=>logs=(logs+data).slice(-100000));
 const started=Date.now(),report={schema:1,kind:'local-runtime-readiness-measurement',model:candidate.tariff.model,modelHash:candidate.tariff.modelHash,fullModelSha256Verified:true,runtime:{...candidate.runtime,cpuOnly:true,threads:4},templateMode:candidate.templateMode,tokenizerHash:adapter.tokenizerHash,templateHash:adapter.templateHash,productionApproved:false,providerRegistered:false,syntheticResponses:false,startedAt:new Date(started).toISOString(),vectors:[],results:[]};
 const stop=new AbortController(),timer=setTimeout(()=>stop.abort(Error('Readiness measurement exceeded five minutes')),300000);
 const request=async(route,body)=>{const res=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([stop.signal,AbortSignal.timeout(30000)])});assert.equal(res.status,200);return res.json();};
 try{
  let ready=false;while(Date.now()-started<60000){if(spawnError)throw spawnError;if(child.exitCode!==null)throw Error('Native runtime exited before readiness');try{const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}assert.ok(ready,'Runtime did not become ready');
  for(const [i,v]of candidate.tokenizer.vectors.entries()){
   const text=v.messages?adapter.render(v.messages,v.at):v.text,ids=(await request('/tokenize',{content:text,add_special:false,parse_special:true})).tokens;
   assert.deepEqual(ids,adapter.encode(text));assert.equal(hash(JSON.stringify(ids)),v.idsHash);assert.equal(ids.length,v.count);report.vectors.push({index:i,count:ids.length,idsHash:v.idsHash,passed:true});
  }
  for(let round=1;round<=5;round++)for(const c of R.CASES){
   const challenge=R.challenge(c.id),prompt=adapter.render(challenge.messages),ids=(await request('/tokenize',{content:prompt,add_special:false,parse_special:true})).tokens;
   assert.deepEqual(ids,adapter.encode(prompt));const at=Date.now();
   // Exact generation request used by Core's metered shadow-worker.
   const result=await request('/completion',{prompt:ids,n_predict:c.maxOutput,temperature:0,stream:false,cache_prompt:false});
   const elapsedMs=Date.now()-at,passed=R.answer(result.content,challenge.nonce)&&result.stop===true&&result.stop_type==='eos'&&result.stopped_limit!==true&&elapsedMs<30000;
   report.results.push({round,id:c.id,nonce:challenge.nonce,promptHash:hash(prompt),inputIdsHash:hash(JSON.stringify(ids)),inputTokens:ids.length,output:result.content,outputTokens:adapter.output(result.content),elapsedMs,stop:result.stop_type,passed});
   assert.ok(passed,'Native runtime-readiness failed: '+c.id);console.log('PASS',round,c.id,elapsedMs+' ms');
  }
  report.status='passed';
 }catch(error){report.status='failed';report.error=error.message;throw error;}
 finally{
  clearTimeout(timer);stop.abort();child.kill('SIGTERM');
  if(child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>{const t=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);t.unref();})]);
  report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');fs.writeFileSync(path.join(output,'runtime.log'),logs);
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
