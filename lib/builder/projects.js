"use strict";
const fs = require("fs"),
  path = require("path"),
  { fail } = require("./store");
const ALLOWED = new Set(["index.html", "app.css", "app.js", "README.md"]);
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const reference = `KAI Build v1 creates browser dapps backed by a separate Koinos App contract for each project.
Editable files: index.html (complete document), app.css, app.js, README.md. CSS and JS are automatically embedded in the preview. Do not import libraries, use external scripts, fetch, localStorage, service workers, server code, secrets, or a package manager. Everything executes in an isolated browser frame with the trusted window.kai bridge installed before your code.
Use plain JavaScript and DOM APIs. Render untrusted chain data with textContent, never innerHTML. All calls are asynchronous. Handle errors visibly.
The only supported wallets are Kondor and KOIN Vault. Never generate MetaMask, Ethereum/EVM, window.ethereum, ethers, web3, WalletConnect, eth_requestAccounts or wallet_switchEthereumChain code or wallet buttons. Never detect or call injected providers. Use only the trusted kai bridge for wallet connections and signing.
await kai.connect() returns {address,wallet}; it opens a choice of Kondor or KOIN Vault on the published app and a labelled sample wallet in preview. Optionally use kai.connect('kondor') or kai.connect('koinvault') for two explicit wallet buttons. KOIN Vault must be on the same network as the app; do not promise mainnet wallets can sign testnet transactions.
await kai.disconnect() disconnects the selected wallet.
await kai.read('get_config', {}) returns {config:{owner,pending_owner,title,count,revision,release_hash}}.
await kai.read('list_records', {offset:0}) returns {records:[{id,author,title,body,options:[],votes:[],closed}],config}. Paginate in steps of 20. IDs start at 1.
await kai.read('get_record', {id:1}) returns {record}.
await kai.call('create_record', {title,body,options:[]}) creates a signed record for the connected wallet. Records can power boards, guestbooks and simple games. To create a poll set 2–8 string options; poll creation requires the connected wallet's signature. A title is 1–160 characters and body <=4000 characters. Each app has up to 10000 records.
await kai.call('edit_record', {id,title,body}) updates a non-poll record; only its author or the owner can do so.
await kai.call('vote', {id,choice:0}) casts one vote per wallet per poll. Options are zero indexed. This is one wallet one vote, NOT one person one vote.
await kai.call('close_poll', {id}) closes a poll with its author's or the app owner's approval.
kai.call returns the transaction id after wallet signing and submission; report pending and refresh to check results. Do not claim finality or success until reads show the change.
Ownership and publication are handled by the workspace outside your app. Never build WIF/password forms. Never simulate wallet signing. Preview state is sample data and never touches the chain. Live state always comes from the chain.
The v1 contract is a versioned platform template. Custom token contracts, swaps, payments, staking, custom AssemblyScript, arbitrary backend code, npm dependencies and custom contract upgrades are outside this version. Explain a requested unsupported capability and do not fake it. You may freely build the frontend and logic that uses the supported contract methods.
Keep the app mobile friendly, polished, accessible and concise. Avoid template slogans. Users should see their app, not platform implementation notes.\n`;
const styles = `:root{font-family:Inter,system-ui,sans-serif;color:#18233c;background:#f5f7fc;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:980px;margin:0 auto;padding:48px 24px}header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:36px}.eyebrow{color:#6556c7;font-size:12px;letter-spacing:.16em;text-transform:uppercase;font-weight:700}h1{font-size:clamp(30px,5vw,46px);letter-spacing:-.05em;line-height:1.15;margin:12px 0}p{color:#6b7589;line-height:1.65}button,input,textarea{font:inherit}button{border:0;background:#6655d8;color:white;border-radius:10px;padding:12px 18px;cursor:pointer;min-height:44px}button:disabled{opacity:.5;cursor:wait}.secondary{background:#eef0f8;color:#384463}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:20px}.card{background:white;border:1px solid #e5e8f1;border-radius:18px;padding:25px;box-shadow:0 8px 30px #27375505}.card h2{font-size:20px;letter-spacing:-.025em;margin:0 0 12px}.option{width:100%;display:flex;justify-content:space-between;margin:8px 0;text-align:left;background:#f3f3fc;color:#3e4161;border:1px solid #e4e3f2}.meta{font-size:12px;color:#7b8395;overflow-wrap:anywhere}form{display:grid;gap:12px;margin:28px 0}input,textarea{width:100%;border:1px solid #dce1ee;border-radius:10px;padding:12px;background:white;color:#18233c}textarea{min-height:90px;resize:vertical}#notice{min-height:24px;color:#6556c7}#more{margin-top:20px}a{color:#6556c7}:focus-visible{outline:3px solid #9b8df5;outline-offset:3px}@media(max-width:600px){main{padding:26px 16px}header{align-items:flex-start;flex-direction:column}.card{padding:20px}}`;
function starter(template, title) {
  const poll = template === "voting",
    blank = template === "blank";
  const heading = escape(title),
    description = poll
      ? "A place for your community to decide what comes next."
      : blank
        ? "An idea starts here. Make it yours."
        : "A little space for ideas, updates, and conversations.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head><body><main><header><div><span class="eyebrow">${poll ? "Community decisions" : "Community space"}</span><h1>${heading}</h1><p>${description}</p></div><button id="connect">Connect wallet</button></header><p id="notice" role="status" aria-live="polite"></p><div id="records" class="grid"></div><button id="more" class="secondary" hidden>Load more</button><form id="create"><h2>${poll ? "Create a poll" : "Add something"}</h2><label>Title<input id="title" maxlength="160" required placeholder="${poll ? "What should we build next?" : "What's on your mind?"}"></label><label>Details<textarea id="body" maxlength="4000" placeholder="A little more context…"></textarea></label>${poll ? '<label>Options, one per line<textarea id="options" required placeholder="A community game\nA voting app\nAn NFT gallery"></textarea></label>' : ""}<button type="submit">${poll ? "Publish poll" : "Post to the community"}</button><span class="meta">${poll ? "Anyone can create a poll. Each wallet gets one vote." : "Posts are public on Koinos and are signed with your wallet."}</span></form></main></body></html>`;
  const script = `const $=id=>document.getElementById(id);let offset=0;const poll=${poll};function notice(s){$('notice').textContent=s}async function connect(){const a=await kai.connect();$('connect').textContent=a.address.slice(0,6)+'…'+a.address.slice(-4);return a}function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n}async function load(reset=true){try{if(reset){offset=0;$('records').replaceChildren()}const data=await kai.read('list_records',{offset});for(const r of data.records||[]){const card=el('article',null,'card');card.append(el('h2',r.title),el('p',r.body||''));if(r.options?.length){r.options.forEach((option,i)=>{const b=el('button',null,'option');b.append(el('span',option),el('strong',String(r.votes?.[i]||0)));b.disabled=!!r.closed;b.onclick=async()=>{b.disabled=true;try{await connect();const tx=await kai.call('vote',{id:r.id,choice:i});notice(tx.preview?'Preview vote saved.':'Vote submitted. Refreshing shortly…');setTimeout(()=>load(true),2500)}catch(e){notice(e.message)}finally{b.disabled=!!r.closed}};card.append(b)});if(r.closed)card.append(el('p','Voting closed','meta'))}else card.append(el('p',r.author?('By '+r.author.slice(0,7)+'…'):'','meta'));$('records').append(card)}offset+=(data.records||[]).length;$('more').hidden=(data.records||[]).length<20;if(!offset)$('records').append(el('p','Nothing here yet. Be the first to add something.'))}catch(e){notice(e.message)}}$('connect').onclick=()=>connect().catch(e=>notice(e.message));$('more').onclick=()=>load(false);$('create').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{await connect();const args={title:$('title').value,body:$('body').value,options:poll?$('options').value.split('\\n').map(s=>s.trim()).filter(Boolean):[]};const tx=await kai.call('create_record',args);notice(tx.preview?'Saved in this preview.':'Transaction submitted. Your post will appear once included.');e.target.reset();setTimeout(()=>load(true),2500)}catch(err){notice(err.message)}finally{b.disabled=false}};load();`;
  return {
    "index.html": html,
    "app.css": styles,
    "app.js": script,
    "README.md": `# ${title}\n\nCreated with KAI Build. Uses the Koinos App v1 contract.\n\n${reference}`,
  };
}
function validate(files) {
  if (!files || typeof files !== "object" || Array.isArray(files))
    throw fail("Invalid project files.");
  let total = 0;
  for (const [name, content] of Object.entries(files)) {
    if (!ALLOWED.has(name)) throw fail("Unsupported file: " + name);
    if (typeof content !== "string" || content.includes("\u0000"))
      throw fail("Files must be text.");
    total += Buffer.byteLength(content);
  }
  if (total > 300000) throw fail("Keep this project under 300 KB.");
  if (
    !files["index.html"] ||
    !/<html[\s>]/i.test(files["index.html"]) ||
    !/<body[\s>]/i.test(files["index.html"])
  )
    throw fail("index.html needs a complete HTML document.");
  if (!/<head[\s>]/i.test(files["index.html"]))
    throw fail("index.html needs a head element.");
  for (const name of ["index.html", "app.js"]) {
    if (
      /metamask|\bethereum\b|eth_requestAccounts|eth_sendTransaction|wallet_switchEthereumChain|wallet_addEthereumChain|walletconnect|\bethers\b|\bweb3\b/i.test(
        files[name] || "",
      )
    )
      throw fail(
        "Use only Kondor and KOIN Vault through kai.connect() and kai.call(). Remove unsupported Ethereum/MetaMask wallet code from " +
          name +
          ".",
      );
  }
  // Parsing only. The application never executes generated JS on the server.
  const vm = require("vm");
  try {
    if (files["app.js"]) new vm.Script(files["app.js"], { filename: "app.js" });
    for (const match of files["index.html"].matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    )) {
      if (
        /\bsrc\s*=|type\s*=\s*["'](?:application\/ld\+json|application\/json)["']/i.test(
          match[1],
        )
      )
        continue;
      new vm.Script(match[2], { filename: "index.html" });
    }
  } catch (e) {
    throw fail("JavaScript syntax error: " + String(e.message).slice(0, 300));
  }
  return {
    ok: true,
    bytes: total,
    checks: [
      "File scope",
      "Project size",
      "HTML document",
      "JavaScript syntax",
    ],
    note: "Syntax checks are not a security audit. Preview your app before publishing.",
  };
}
function html(files) {
  validate(files);
  const runtime = fs.readFileSync(
    path.join(__dirname, "../../views/build/runtime.js"),
    "utf8",
  );
  let doc = files["index.html"]
    .replace(
      /<script\b[^>]*\bsrc\s*=\s*["']\.?\/?app\.js["'][^>]*>\s*<\/script\s*>/gi,
      "",
    )
    .replace(/<link\b[^>]*\bhref\s*=\s*["']\.?\/?app\.css["'][^>]*>/gi, "");
  const safe = (s) => s.replace(/<\/script/gi, "<\\/script"),
    style = (files["app.css"] || "").replace(/<\/style/gi, "<\\/style");
  doc = doc.replace(
    /<head\b[^>]*>/i,
    (m) =>
      m + "<script>" + safe(runtime) + "</script><style>" + style + "</style>",
  );
  if (!/<head[\s>]/i.test(doc)) throw fail("index.html needs a head element.");
  return doc.replace(
    /<\/body\s*>/i,
    "<script>" + safe(files["app.js"] || "") + "</script></body>",
  );
}
module.exports = { starter, validate, html, reference, ALLOWED, escape };
