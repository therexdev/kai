const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.md':'text/plain'};
async function route(route){
 const u=new URL(route.request().url());
 if(u.hostname!=='kai.test')return route.abort();
 const json=x=>route.fulfill({contentType:'application/json',body:JSON.stringify(x)});
 if(u.pathname==='/auth/session'||u.pathname==='/account/api')return json({account:{id:'test',email:'home@example.com',wallets:[],grants:[],passkeys:[]}});
 if(u.pathname==='/auth/methods')return json({signin:{email:true,google:true,passkey:true},canCreateAccount:true});
 if(u.pathname==='/account/sessions')return json({sessions:[]});
 if(u.pathname==='/account/api/nodes')return json({nodes:[]});
 if(u.pathname==='/scheduler/network/status')return json({workersOnline:1,models:[{model:'Home',providers:1}],queueDepth:0,workers:[{address:'1TestAddress',models:['Home'],lastSeenSecs:3,jobsThisEpoch:2}]});
 if(u.pathname.includes('/api/')||u.pathname.startsWith('/auth/')||u.pathname.startsWith('/account/'))return json({ok:true,chats:[],docs:[],tasks:[],memory:[],memories:[],models:[],projects:[],account:{email:'test@example.com'},model:'test-model',aiReady:false,network:'harbinger'});
 const aliases={'/':'public/index.html','/account':'public/account.html','/network':'public/network.html','/testers':'public/testers.html','/privacy':'public/privacy.html','/dashboard':'public/dashboard.html','/updates':'public/updates.html','/docs/':'public/docs/index.html','/app':'views/app.html','/app/app.js':'views/app.js','/build':'views/build/index.html','/build/assets/markdown.js':'public/docs/md.js'};
 const rel=aliases[u.pathname]||(u.pathname.startsWith('/build/assets/')?'views/build/'+u.pathname.split('/').pop():'public'+u.pathname);
 let file=path.join(root,rel);
 if(!fs.existsSync(file))return route.fulfill({status:404,body:'missing'});
 return route.fulfill({contentType:mime[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
}
async function openLanguageMenu(page){
 if(await page.locator('[data-language-select]').isVisible())return;
 const toggle=page.locator('.menu-toggle');
 if(await toggle.count())await toggle.click();
 else await page.locator('.kai-site-menu summary').click();
}
async function checkLanguageLayout(page){
 const select=page.locator('[data-language-select]');
 await openLanguageMenu(page);
 const layout=await select.evaluate(el=>{
  const box=el.getBoundingClientRect(),control=el.parentElement,menu=control.parentElement;
  const lastLink=[...menu.children].filter(child=>child.tagName==='A').at(-1)?.getBoundingClientRect();
  const mobile=menu.matches('.mobile-nav,.kai-site-menu nav');
  const header=el.closest('.site-nav,.kai-site-header');
  return {width:box.width,height:box.height,mobile,inMenu:menu.matches('.nav-links,.kai-site-links,.mobile-nav,.kai-site-menu nav'),
   belowLinks:!lastLink||box.top>=lastLink.bottom,inline:!lastLink||Math.abs((box.top+box.bottom-lastLink.top-lastLink.bottom)/2)<2,
   afterLinks:!lastLink||box.left>=lastLink.right,insideHeader:!header||box.right<=header.getBoundingClientRect().right,
   value:el.value,label:el.selectedOptions[0].textContent,options:[...el.options].map(o=>o.textContent),
   overflow:document.documentElement.scrollWidth>innerWidth+1};
 });
 assert.equal(layout.width,44);assert.equal(layout.height,44);assert.equal(layout.overflow,false);
 assert.equal(layout.label,layout.value.slice(0,2).toUpperCase());
 assert.deepEqual(layout.options,['EN','ES','PT','FR','DE']);
 assert.equal(layout.inMenu,true);assert.equal(layout.insideHeader,true);
 if(layout.mobile)assert.equal(layout.belowLinks,true);else{assert.equal(layout.inline,true);assert.equal(layout.afterLinks,true);}
 return layout;
}
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({locale:'es-MX',viewport:{width:390,height:844}});await context.route('**/*',route);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const reports=[];
 for(const url of ['/','/network','/testers','/privacy','/account','/dashboard','/updates','/docs/','/app','/build']){
  await page.goto('http://kai.test'+url);await page.waitForTimeout(150);
  const report=await page.evaluate(()=>({path:location.pathname,lang:document.documentElement.lang,selector:document.querySelectorAll('[data-language-select]').length,heading:document.querySelector('h1,h2')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth+1}));reports.push(report);assert.equal(report.lang,'es',url);assert.equal(report.selector,1,url);assert.equal(report.overflow,false,url);
  if(url==='/app'){
   assert.equal(await page.locator('#composer-input').getAttribute('placeholder'),'Pregunta lo que quieras…');
   assert.equal(await page.locator('#doc-ai-input').getAttribute('placeholder'),'Pregunta sobre este documento…');
   await page.setViewportSize({width:1440,height:900});
   await page.waitForFunction(()=>document.getElementById('composer-input').placeholder.includes('Mayús+Intro'));
   assert.match(await page.locator('#doc-ai-input').getAttribute('placeholder'),/hazlo más conciso/);
   await page.setViewportSize({width:390,height:844});
  }
 }
 await page.goto('http://kai.test/');await openLanguageMenu(page);await page.selectOption('[data-language-select]','de');await page.locator('#waitlist-email').fill('user@example.com');
 await page.selectOption('[data-language-select]','fr');assert.equal(await page.inputValue('#waitlist-email'),'user@example.com');
 await page.click('[data-feature="brain"]');assert.equal(await page.locator('#tour-title').textContent(),'Une IA qui connaît votre univers.');
 await page.goto('http://kai.test/network');assert.equal(await page.locator('html').getAttribute('lang'),'fr');
 assert.equal(await page.locator('#modelsBody .mono').textContent(),'Home');
 await openLanguageMenu(page);await page.selectOption('[data-language-select]','en');assert.equal(await page.locator('h1').textContent(),'AI, powered by people.');
 await page.evaluate(()=>localStorage.removeItem('kai-website-language'));await page.reload();
 assert.equal(await page.locator('html').getAttribute('lang'),'es');assert.equal(await page.inputValue('[data-language-select]'),'es');
 // Exercise both header styles around their mobile breakpoints, preserving one
 // selector while it moves into/out of the menu, for every supported language.
 for(const url of ['/','/network']){
  await page.goto('http://kai.test'+url);
  for(const lang of ['en','es','pt-BR','fr','de']){
   await page.evaluate(lang=>KaiI18n.setLanguage(lang),lang);
   for(const width of [390,720,721,850,851,1024,1440]){
    await page.setViewportSize({width,height:900});await page.waitForTimeout(50);
    await checkLanguageLayout(page);
   }
  }
 }
 await page.goto('http://kai.test/');await page.screenshot({path:path.join(__dirname,'website-desktop-es.png'),fullPage:false});
 await page.setViewportSize({width:390,height:844});await checkLanguageLayout(page);
 await page.screenshot({path:path.join(__dirname,'website-mobile-es.png'),fullPage:false});
 const english=await browser.newContext({locale:'en-US',viewport:{width:1440,height:900}});await english.route('**/*',route);
 const firstVisit=await english.newPage();await firstVisit.goto('http://kai.test/');
 assert.equal(await firstVisit.inputValue('[data-language-select]'),'en');
 assert.equal(await firstVisit.locator('[data-language-select] option:checked').textContent(),'EN');
 assert.equal(await firstVisit.evaluate(()=>localStorage.getItem('kai-website-language')),null);
 await english.close();
 console.log(JSON.stringify({reports,errors},null,2));await browser.close();if(errors.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
