"use strict";
// Public, read-only mainnet observation. Never proxy cookies or private credit sessions.
const ORIGIN = "https://credits.koinosai.com";
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const count = n => Number.isSafeInteger(n) && n >= 0;
const label = s => typeof s === "string" && s.length > 0 && s.length <= 128 && !/[\x00-\x1f\x7f]/.test(s);
function snapshot(d, health, at) {
  if (health?.chainId !== CHAIN || health?.mainnetPaymentsEnabled !== true || health?.product !== "prepaid-usd-v1") throw Error("Mainnet identity unavailable");
  if (d?.ok !== true || !count(d.workersOnline) || !count(d.queueDepth) || !count(d.pendingJobs) || !Array.isArray(d.models) || d.models.length > 256 || !Array.isArray(d.workers) || d.workers.length > 5000) throw Error("Invalid network status");
  const models = d.models.map(m => { if (!label(m?.model) || !count(m.providers)) throw Error("Invalid model status"); return {model:m.model,providers:m.providers}; });
  const workers = d.workers.slice(0,256).map(w => {
    if (!label(w?.address) || typeof w.busy !== "boolean" || !count(w.lastSeenSecs) || !Array.isArray(w.models) || w.models.length>256 || w.models.some(m=>!label(m))) throw Error("Invalid provider status");
    // Redact defensively even if an upstream changes its public address format.
    const address = w.address.includes("…") ? w.address : w.address.slice(0,6)+"…"+w.address.slice(-4);
    return {address,models:w.models,busy:w.busy,lastSeenSecs:w.lastSeenSecs};
  });
  return {ok:true,network:"mainnet",product:"prepaid-usd-v1",source:ORIGIN,observedAt:at,validUntil:at+15000,workersOnline:d.workersOnline,queueDepth:d.queueDepth,pendingJobs:d.pendingJobs,models,workers,workersTruncated:d.workers.length>256};
}
function createReader({fetchImpl=fetch,now=Date.now}={}) {
  let cached, pending;
  async function json(path) {
    const r = await fetchImpl(ORIGIN+path,{headers:{accept:"application/json"},credentials:"omit",redirect:"error",signal:AbortSignal.timeout(5000)});
    if(!r.ok || !(r.headers.get("content-type")||"").includes("application/json")) throw Error("Status unavailable");
    let size=0;const chunks=[];
    for await(const chunk of r.body){size+=chunk.length;if(size>2*1024*1024)throw Error("Status too large");chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return async function read() {
    if(cached && now()-cached.observedAt<10000)return cached;
    if(!pending) pending=Promise.all([json('/scheduler/network/status'),json('/health')]).then(([d,h])=>cached=snapshot(d,h,now())).finally(()=>{pending=null;});
    return pending;
  };
}
function mount(app) {
  const read=createReader();
  app.get('/api/network/mainnet',async(_req,res)=>{
    res.setHeader('Cache-Control','no-store');
    try {res.json(await read());} catch {res.status(503).json({ok:false,network:'mainnet',error:'Mainnet network status is temporarily unavailable. Retrying shortly.'});}
  });
}
module.exports={mount,snapshot,createReader};
