"use strict";
(()=>{
 const $=id=>document.getElementById(id);let last=null,pending=false,timer,error="";
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const count=n=>Number.isSafeInteger(n)&&n>=0;
 function validate(d){
  if(d?.ok!==true||d.network!=='mainnet'||!count(d.observedAt)||!count(d.validUntil)||d.observedAt>Date.now()+5000||d.validUntil<=Date.now()||d.validUntil>d.observedAt+15000||!count(d.workersOnline)||!count(d.queueDepth)||!count(d.pendingJobs)||!Array.isArray(d.models)||!Array.isArray(d.workers))throw Error('Invalid network observation');
  if(d.models.some(m=>typeof m.model!=='string'||!count(m.providers))||d.workers.some(w=>typeof w.address!=='string'||!Array.isArray(w.models)||w.models.some(m=>typeof m!=='string')||typeof w.busy!=='boolean'||!count(w.lastSeenSecs)))throw Error('Invalid network detail');return d;
 }
 const html=(id,value)=>{if($(id).innerHTML!==value)$(id).innerHTML=value;};
 function paint(){
  const fresh=last&&Date.now()<last.validUntil;
  $('tAge').textContent=last?Math.max(0,Math.round((Date.now()-last.observedAt)/1000))+'s ago':'—';
  $('network-state').textContent=fresh?'Mainnet provider presence':'Mainnet status unconfirmed';
  if(!last)return;
  $('tWorkers').textContent=last.workersOnline;$('tModels').textContent=last.models.filter(m=>m.providers>0).length;$('tJobs').textContent=last.queueDepth+last.pendingJobs;
  $('tWorkersSub').textContent=fresh?'recently observed computers':'last known count';
  html('modelsBody',last.models.length?last.models.map(m=>`<tr><td>${esc(m.model)}</td><td class="num">${m.providers}${fresh?'':' · last known'}</td></tr>`).join(''):'<tr><td colspan="2">No models reported.</td></tr>');
  html('cards',last.workers.map(w=>`<div class="card"><div class="top"><span class="addr">${esc(w.address)}</span><span class="status ${fresh?'online':''}">${fresh?(w.busy?'Serving':'Online'):'Status stale'}</span></div><p class="meta">Last contact at observation: ${w.lastSeenSecs}s ago</p><div class="models">${w.models.map(m=>`<span class="chip">${esc(m)}</span>`).join('')}</div></div>`).join(''));
  $('emptyState').style.display=last.workers.length?'none':'block';
  if(!fresh){$('err').textContent=error||'Current availability is unconfirmed. Showing the last verified mainnet observation.';$('err').style.display='block';}
 }
 async function refresh(){
  if(pending||document.hidden)return;pending=true;
  try{const r=await fetch('/api/network/mainnet',{cache:'no-store',headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error();last=validate(await r.json());error='';$('err').style.display='none';}
  catch{error=last?'Cannot refresh mainnet status. Last known data is shown with its observation time.':'Mainnet status is temporarily unavailable. No verified data yet.';$('err').textContent=error;$('err').style.display='block';if(last)last={...last,validUntil:0};}
  finally{pending=false;paint();clearTimeout(timer);if(!document.hidden)timer=setTimeout(refresh,10000);}
 }
 document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden){paint();refresh();}});
 refresh();setInterval(paint,1000);
})();
