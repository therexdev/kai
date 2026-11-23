"use strict";
(() => {
  const $ = id => document.getElementById(id), credits = atoms => (Number(atoms || 0) / 100000).toLocaleString(undefined, { maximumFractionDigits: 5 });
  const make = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const canonical = value => JSON.stringify(value, function (key, item) { return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item; });
  let overview, wallet = "", history = [], controller, draft, quotePending = false;
  const notice = (message, error = false) => { $("notice").textContent = message; $("notice").hidden = !message; $("notice").classList.toggle("error", error); };
  async function api(url, body, method = body ? "POST" : "GET") {
    const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 401) location.assign("/login?next=" + encodeURIComponent(window.KaiAccountRoutes.destination(location.pathname + location.search + location.hash)));
      throw Error(value.error?.message || value.error || "Request failed. Please try again.");
    }
    return value;
  }
  function action(id, fn) {
    $(id).onclick = async () => { $(id).disabled = true; notice(""); try { await fn(); } catch (e) { notice(e.message, true); } finally { $(id).disabled = false; } };
  }
  function form(id, fn) { $(id).onsubmit = async e => { e.preventDefault(); notice(""); try { await fn(); } catch (err) { notice(err.message, true); } }; }
  const titles = { overview: "Your account", playground: "Chat", billing: "Credits & billing", keys: "API keys", usage: "Usage", wallets: "Wallets", devices: "Devices", security: "Account & security" };
  function tab(id, updateUrl = true) {
    if (!Object.hasOwn(titles, id)) id = "overview";
    document.querySelectorAll(".tab").forEach(n => { n.hidden = n.id !== id; });
    document.querySelectorAll(".nav[data-tab]").forEach(n => { n.classList.toggle("active", n.dataset.tab === id); if (n.dataset.tab === id) n.setAttribute("aria-current", "page"); else n.removeAttribute("aria-current"); });
    $("page-title").textContent = titles[id]; document.title = titles[id] + " — Koinos AI";
    document.querySelector(".wallet-bar").hidden = ["wallets", "devices", "security"].includes(id);
    if (updateUrl) window.history.pushState(null, "", "/account" + (id === "overview" ? "" : "#" + id));
    if (id === "keys") loadKeys().catch(e => notice(e.message, true));
    document.dispatchEvent(new CustomEvent("kai-account-tab", { detail: id }));
  }
  document.querySelectorAll("[data-tab]").forEach(n => { n.onclick = () => tab(n.dataset.tab); });
  window.addEventListener("popstate", () => tab(location.hash.slice(1), false));
  window.addEventListener("hashchange", () => tab(location.hash.slice(1), false));
  try {
    const pending = JSON.parse(sessionStorage.getItem("kai-login-return") || "null"); sessionStorage.removeItem("kai-login-return");
    if (pending?.expires > Date.now() && !location.hash && !location.search) window.history.replaceState(null, "", window.KaiAccountRoutes.destination(pending.path));
  } catch {}
  tab(new URLSearchParams(location.search).has("code") ? "devices" : location.hash.slice(1), false);
  let vaultSession = null, vaultRequest = null, vaultPolling = false, vaultAccount = "";
  function saveVault() {
    if (!overview) return;
    try { sessionStorage.setItem("kai-vault-" + overview.account.id, JSON.stringify({ session: vaultSession, request: vaultRequest })); } catch { notice("Keep this page open until the wallet request is resolved."); }
  }
  function restoreVault() {
    if (!overview || vaultAccount === overview.account.id) return;
    vaultAccount = overview.account.id; vaultSession = null; vaultRequest = null;
    try { const saved=JSON.parse(sessionStorage.getItem("kai-vault-"+vaultAccount)||"null"); if(saved?.session?.expiresAt>Date.now()){vaultSession=saved.session;vaultRequest=saved.request;} } catch {}
    if(vaultRequest) $("vault-payment-open").hidden=false;
    if(vaultSession) checkVault().catch(e=>notice(e.message,true));
  }
  function vaultCredentials() { return { sessionId:vaultSession.sessionId, secret:vaultSession.secret }; }
  function walletLink(uri) {
    const url=new URL(uri); if(url.origin!=="https://koinvault.app" || url.pathname!=="/")throw Error("Invalid wallet destination");
    const link=$("vault-open"); link.href=url.href;link.hidden=false;link.rel="noopener noreferrer";link.referrerPolicy="no-referrer";
  }
  action("vault-connect", async()=> {
    if(vaultSession) { walletLink("https://koinvault.app/");await checkVault();return; }
    vaultSession=await api("/platform/api/vault/connect",{});saveVault();walletLink(vaultSession.uri);
    $("vault-status").textContent="Open KOIN Vault, approve the connection, then return here.";
  });
  action("vault-check",checkVault);
  async function checkVault() {
    if(!vaultSession || vaultPolling || !overview)return;
    vaultPolling=true;const session=vaultSession,account=overview.account.id;
    try {
      const s=await api("/platform/api/vault/status",vaultCredentials());
      if(session!==vaultSession || account!==overview?.account.id)return;
      if(!s.connected) { $("vault-status").textContent="Waiting for connection approval in KOIN Vault.";return; }
      if(session.address && session.address!==s.address)throw Error("Wallet address changed. Reconnect KOIN Vault.");
      const newlyConnected=!session.address;session.address=s.address;saveVault();walletLink("https://koinvault.app/");
      $("vault-status").textContent="Connected: "+s.address;
      if(newlyConnected){wallet=s.address;await refresh();document.dispatchEvent(new Event("kai-wallet-linked"));}
      if(vaultRequest?.requestId) {
        const result=await api("/platform/api/vault/result",{...vaultCredentials(),requestId:vaultRequest.requestId});
        $("purchase-status").textContent="KOIN Vault: "+result.status+". Submission is verified separately before credits are added.";
        if(result.txid){$("tx").value=result.txid;wallet=result.wallet;localStorage.setItem("kai-web-purchase-"+account,JSON.stringify({txId:result.txid,wallet}));await checkPurchase();}
        if(["approved","rejected"].includes(result.status)){vaultRequest=null;saveVault();await refresh();}
        if(result.status==="failed")notice("Wallet reported failure. Check its transaction history before starting another payment.",true);
      } else if(vaultRequest?.unknown) notice("The wallet request outcome is unknown. Inspect KOIN Vault and use the transaction checker before making another payment.",true);
    } finally {vaultPolling=false;}
  }
  // Only read while visible. Never retry the transaction request or broadcast.
  setInterval(()=>{if(!document.hidden && vaultSession)checkVault().catch(e=>notice(e.message,true));},5000);
  window.addEventListener("focus",()=>{if(vaultSession)checkVault().catch(e=>notice(e.message,true));});
  action("vault-disconnect",()=>{if(vaultRequest)throw Error("Check the pending payment before disconnecting. Its status is preserved.");vaultSession=null;vaultRequest=null;saveVault();$("vault-open").hidden=true;$("vault-status").textContent="Connection removed from this browser. You can also revoke it in KOIN Vault.";});
  function selected() { return wallet || null; }
  async function refresh() {
    const data = await api("/platform/api/overview?wallet=" + encodeURIComponent(wallet)); overview = data; restoreVault();
    $("email").textContent = data.account.email || "Your KAI account";
    $("wallet").replaceChildren(new Option("Account daily allowance", ""));
    for (const w of data.account.wallets) $("wallet").add(new Option(w.address, w.address));
    $("wallet").value = wallet;
    $("free").textContent = data.credits.free.state === "unavailable" ? "Unavailable" : credits(data.credits.free.available);
    $("paid").textContent = credits(data.credits.purchased.available);
    $("reset").textContent = data.credits.free.state === "unavailable" ? "Free network capacity is temporarily unavailable." : "Daily allowance: " + credits(data.freePolicy?.accountDaily) + " credits. Refreshes " + new Date(data.credits.free.resetAt).toLocaleString() + ".";
    const models = data.models.filter(m => m.available), prior = $("model").value;
    $("model-count").textContent = String(models.length); $("model").replaceChildren();
    for (const m of models) $("model").add(new Option(m.label + (m.freeEligible ? " · free eligible" : ""), m.model));
    if (models.some(m => m.model === prior)) $("model").value = prior;
    $("send").disabled = !models.length || !!controller; modelLimit();
    $("base-url").textContent = data.apiBase;
    $("usage-rows").replaceChildren();
    for (const u of data.usage || []) { const tr = make("tr"); [new Date(u.at).toLocaleString(), u.model, credits(u.free), credits(u.purchased)].forEach(x => tr.append(make("td", x))); $("usage-rows").append(tr); }
    if (!data.usage?.length) { const tr = make("tr"), td = make("td", "No completed requests for this balance yet."); td.colSpan = 4; tr.append(td); $("usage-rows").append(tr); }
    $("purchase-list").replaceChildren();
    for (const p of data.purchases || []) { const row = make("div", undefined, "key-row"), info = make("div"); info.append(make("strong", p.state), make("p", p.id)); row.append(info); $("purchase-list").append(row); }
    if (!data.purchases?.length) $("purchase-list").append(make("p", "No purchases for this balance yet."));
    if (!wallet) { $("chat-free").checked = true; $("key-free").checked = true; $("key-purchase").checked = false; }
    $("chat-free").disabled = !wallet; $("key-free").disabled = !wallet; $("key-purchase").disabled = !wallet;
    try { const pending = JSON.parse(localStorage.getItem("kai-web-purchase-" + data.account.id) || "null"); if (pending) { $("tx").value = pending.txId; $("purchase-status").textContent = "Payment " + pending.txId + " needs confirmation. Select wallet " + pending.wallet + " and check the transaction before making another payment."; } } catch { /* Storage may be disabled. */ }
  }
  function modelLimit() { const model = overview?.models.find(m => m.model === $("model").value); if (model) { $("tokens").max = model.maxOutput; if (Number($("tokens").value) > model.maxOutput) $("tokens").value = model.maxOutput; } }
  $("model").onchange = modelLimit;
  $("wallet").onchange = async () => { wallet = $("wallet").value; try { await refresh(); } catch (e) { notice(e.message, true); } };
  action("refresh", refresh);
  action("logout", async () => { await api("/auth/logout", {}); location.assign("/login"); });
  action("connect", async () => {
    if (!overview || !window.kondor) throw Error("Wait for the page to load and enable the Kondor browser wallet.");
    const addresses = await kondor.getAccounts();
    if (!addresses?.length) throw Error("Choose an account in Kondor.");
    const address = addresses[0].address, ts = Date.now(), input = new TextEncoder().encode(`link|${address}|${overview.account.id}|${ts}`);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    const raw = await kondor.getSigner(address).signHash(hash), signature = btoa(String.fromCharCode(...new Uint8Array(Object.values(raw))));
    await api("/account/wallets", { address, ts, signature }); wallet = address; await refresh(); notice("Wallet connected. Select it whenever you want to use its purchased credits."); document.dispatchEvent(new Event("kai-wallet-linked"));
  });
  async function loadKeys() {
    const data = await api("/platform/api/keys"); $("key-list").replaceChildren();
    for (const key of data.keys) {
      const row = make("div", undefined, "key-row"), info = make("div");
      info.append(make("strong", key.name), make("p", key.prefix + "… · " + (key.freeOnly ? "Free only" : "Free + purchased") + " · " + credits(key.dailyLimitAtoms) + " credits/day"), make("p", "Expires " + new Date(key.expiresAt).toLocaleDateString() + " · " + (key.wallet || "Account daily allowance")));
      const dead = key.revokedAt !== null || key.expiresAt <= Date.now();
      const revoke = make("button", dead ? "Inactive" : "Revoke", "danger"); revoke.disabled = dead;
      revoke.onclick = async () => { try { await api("/platform/api/keys/" + key.id, undefined, "DELETE"); await loadKeys(); } catch (e) { notice(e.message, true); } };
      row.append(info, revoke); $("key-list").append(row);
    }
    if (!data.keys.length) $("key-list").append(make("p", "No API keys yet. Create one for your first application."));
  }
  function creditAtoms(input) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,5})?$/.test(input)) throw Error("Use a positive credit amount with up to five decimal places.");
    const [whole, part = ""] = input.split("."); return String(BigInt(whole) * 100000n + BigInt(part.padEnd(5, "0")));
  }
  let creating = false;
  form("key-form", async () => {
    if (creating) return; creating = true;
    try {
      const data = await api("/platform/api/keys", { name: $("key-name").value, wallet: selected(), scopes: ["inference", "billing:read", ...($("key-purchase").checked ? ["billing:purchase"] : [])], freeOnly: $("key-free").checked, dailyLimitAtoms: creditAtoms($("key-limit").value), expiresInDays: Number($("key-days").value) });
      $("secret").value = data.secret; $("new-key").hidden = false; await loadKeys();
    } finally { creating = false; }
  });
  action("copy-key", async () => { await navigator.clipboard.writeText($("secret").value); notice("API key copied."); });
  action("hide-key", () => { $("secret").value = ""; $("new-key").hidden = true; });
  function message(role, text) {
    $("messages").querySelector(".empty")?.remove();
    const div = make("div", undefined, "message " + role), content = make("span", text); div.append(make("strong", role === "user" ? "YOU" : "KOINOS AI"), content); $("messages").append(div); return content;
  }
  form("chat", async () => {
    if (controller) return;
    const text = $("prompt").value.trim(); if (!text) return;
    const outgoing = [...history, { role: "user", content: text }]; message("user", text); const answer = message("assistant", "Connecting to a provider…");
    controller = new AbortController(); $("send").disabled = true; $("stop").hidden = false; $("prompt").value = ""; let content = "", done = false;
    try {
      const response = await fetch("/platform/api/chat", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, signal: controller.signal,
        body: JSON.stringify({ model: $("model").value, messages: outgoing, max_tokens: Number($("tokens").value), stream: true, creditWallet: selected(), freeOnly: $("chat-free").checked }) });
      if (!response.ok) { const data = await response.json(); throw Error(data.error?.message || "Request failed"); }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true });
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          if (!frame.startsWith("data: ")) continue;
          const value = frame.slice(6); if (value === "[DONE]") { done = true; continue; }
          const data = JSON.parse(value); if (data.error) throw Error(data.error.message);
          content += data.choices?.[0]?.delta?.content || ""; answer.textContent = content || "Waiting for the model…"; $("messages").scrollTop = $("messages").scrollHeight;
        }
      }
      if (!done) throw Error("Connection ended before the reply finished.");
      history = [...outgoing, { role: "assistant", content }];
    } catch (e) {
      const reason = e.name === "AbortError" ? "Stopped. Only verified delivered usage is charged." : e.message;
      if (!content) answer.textContent = reason; else { history = [...outgoing, { role: "assistant", content }]; notice(reason, true); }
      throw e.name === "AbortError" ? Error(reason) : e;
    } finally { controller = null; $("stop").hidden = true; $("send").disabled = false; await refresh().catch(() => {}); }
  });
  action("stop", () => controller?.abort());
  action("clear", () => { if (controller) throw Error("Stop the current reply first."); history = []; $("messages").replaceChildren(make("p", "What would you like to work on?", "empty")); });
  form("buy", async () => {
    if (quotePending) return; if (vaultRequest) throw Error("Resolve the pending KOIN Vault request before starting another purchase."); if (!wallet) throw Error("Connect and select your payment wallet first.");
    if ($("tx").value) throw Error("Check the previous transaction before starting another purchase.");
    quotePending = true;
    try {
      draft = await api("/platform/api/purchase-quote", { dollars: $("dollars").value, creditWallet: selected() });
      $("purchase-review").textContent = `Pay ${draft.koin} KOIN for ${draft.credits} credits. Wallet: ${draft.signerAddress}. Quote expires ${new Date(draft.expiresAt).toLocaleTimeString()}.`;
      $("approve-purchase").textContent = vaultSession?.address === draft.signerAddress ? "Approve in KOIN Vault" : "Approve in Kondor";
      $("purchase-dialog").showModal();
    } finally { quotePending = false; }
  });
  action("cancel-purchase", () => { draft = null; $("purchase-dialog").close(); });
  action("approve-purchase", async () => {
    if (!draft || draft.expiresAt <= Date.now()) throw Error("Quote expired. Request a fresh quote.");
    const reviewed = draft; draft = null; $("purchase-dialog").close();
    if(vaultSession?.address===reviewed.signerAddress) {
      vaultRequest={unknown:true};saveVault();
      const result=await api("/platform/api/vault/request",{...vaultCredentials(),quoteId:reviewed.vaultQuoteId});
      vaultRequest={requestId:result.requestId};saveVault();walletLink("https://koinvault.app/");$("vault-payment-open").hidden=false;
      $("purchase-status").textContent="Open KOIN Vault to approve this payment, then return here. Do not repeat the purchase while it is pending.";
      return;
    }
    const provider = kondor.getProvider("mainnet");
    if (await provider.getChainId() !== reviewed.chainId) throw Error("Select Koinos mainnet in Kondor.");
    const signed = await kondor.getSigner(reviewed.signerAddress).signTransaction(structuredClone(reviewed.transaction), reviewed.abis);
    if (signed.id !== reviewed.transaction.id || canonical(signed.header) !== canonical(reviewed.transaction.header) || canonical(signed.operations) !== canonical(reviewed.transaction.operations) || !signed.signatures?.length) throw Error("Wallet returned a transaction different from the reviewed purchase.");
    $("tx").value = signed.id;
    try { localStorage.setItem("kai-web-purchase-" + overview.account.id, JSON.stringify({ txId: signed.id, wallet: reviewed.signerAddress })); } catch { /* ID remains visible for recovery. */ }
    $("purchase-status").textContent = "Sending payment. Keep this transaction ID: " + signed.id;
    try { await provider.sendTransaction(signed, true); } catch { notice("Payment broadcast is unconfirmed. Check this transaction before making another payment.", true); }
    wallet = reviewed.signerAddress; await checkPurchase(); await refresh();
  });
  async function checkPurchase() {
    if (!wallet) throw Error("Select the wallet used for this purchase.");
    const data = await api("/platform/api/purchases", { creditWallet: selected(), txId: $("tx").value.trim() });
    $("purchase-status").textContent = "Payment status: " + data.purchase.state + ".";
    if (data.purchase.state === "confirmed") { vaultRequest=null;saveVault();$("vault-payment-open").hidden=true; try { localStorage.removeItem("kai-web-purchase-" + overview.account.id); } catch {} $("tx").value = ""; }
  }
  form("recover", async () => { await checkPurchase(); await refresh(); });
  document.addEventListener("kai-wallet-unlinked", event => { if (wallet === event.detail) wallet = ""; refresh().catch(e => notice(e.message, true)); });
  refresh().catch(e => notice(e.message, true));
})();
