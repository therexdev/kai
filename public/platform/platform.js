"use strict";
(() => {
  const $ = id => document.getElementById(id), credits = atoms => (Number(atoms || 0) / 100000).toLocaleString(undefined, { maximumFractionDigits: 5 });
  const make = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const canonical = value => JSON.stringify(value, function (key, item) { return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item; });
  const workspace = /^\/app\/?$/.test(location.pathname);
  const embedded = workspace && new URLSearchParams(location.search).get("embed") === "workspace";
  const navigate = url => { if (embedded) window.open(new URL(url, location.origin).href, "_top"); else location.assign(url); };
  const login = () => { if (embedded) window.parent.postMessage({ type: "kai-workspace-login" }, "https://koinosai.com"); else location.assign("/login"); };
  if (embedded) document.querySelectorAll("a[href]").forEach(a => { a.target = "_top"; });
  document.body.classList.toggle("workspace", workspace);
  document.querySelectorAll("[data-area]").forEach(node => { node.hidden = node.dataset.area !== (workspace ? "workspace" : "account"); });
  document.querySelectorAll("[data-area-link]").forEach(node => { if (node.dataset.areaLink === (workspace ? "workspace" : "account")) node.setAttribute("aria-current", "page"); });
  if (workspace) {
    document.querySelector(".sidebar > .eyebrow").textContent = "YOUR WORKSPACE";
    const controls = $("playground").querySelector(".controls"), settings = make("details", undefined, "chat-settings"), summary = make("summary", "Chat settings");
    const options = make("div", undefined, "chat-settings-body");
    options.append($("tokens").closest("label"), $("chat-free").closest("label"), document.querySelector(".wallet-bar"), ...$("playground").querySelectorAll(".card > .small"));
    settings.append(summary, options); controls.append(settings);
    $("playground").querySelector(".section-title").hidden = true;
  }
  let overview, wallet = "", history = [], controller, draft, quotePending = false;
  const notice = (message, error = false) => { $("notice").textContent = message; $("notice").hidden = !message; $("notice").classList.toggle("error", error); };
  async function api(url, body, method = body ? "POST" : "GET") {
    const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(overview?.account?.id ? { "x-kai-account": overview.account.id } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 401) login();
      throw Error(value.error?.message || value.error || "Request failed. Please try again.");
    }
    return value;
  }
  function action(id, fn) {
    $(id).onclick = async () => { $(id).disabled = true; notice(""); try { await fn(); } catch (e) { notice(e.message, true); } finally { $(id).disabled = false; } };
  }
  function form(id, fn) { $(id).onsubmit = async e => { e.preventDefault(); notice(""); try { await fn(); } catch (err) { notice(err.message, true); } }; }
  const titles = { overview: "Credits & API", playground: "Chat", billing: "Credits & billing", keys: "API keys", usage: "Usage", wallets: "Wallets", devices: "Devices", security: "Account & security" };
  function tab(id, updateUrl = true) {
    if (id === "chat") id = "playground";
    if (!Object.hasOwn(titles, id)) id = workspace ? "playground" : "overview";
    if (workspace && id !== "playground") { navigate("/account#" + id); return; }
    if (!workspace && id === "playground") { navigate("https://koinosai.com/chat"); return; }
    document.querySelectorAll(".tab").forEach(n => { n.hidden = n.id !== id; });
    document.querySelectorAll(".nav[data-tab]").forEach(n => { n.classList.toggle("active", n.dataset.tab === id); if (n.dataset.tab === id) n.setAttribute("aria-current", "page"); else n.removeAttribute("aria-current"); });
    $("page-title").textContent = titles[id]; document.title = titles[id] + " — Koinos AI";
    document.querySelector(".wallet-bar").hidden = ["wallets", "devices", "security"].includes(id);
    if (updateUrl) window.history.pushState(null, "", (workspace ? "/app" + (embedded ? "?embed=workspace" : "") + "#chat" : "/account" + (id === "overview" ? "" : "#" + id)));
    if (id === "keys") loadKeys().catch(e => notice(e.message, true));
    document.dispatchEvent(new CustomEvent("kai-account-tab", { detail: id }));
  }
  document.querySelectorAll("[data-tab]").forEach(n => { n.onclick = () => tab(n.dataset.tab); });
  window.addEventListener("popstate", () => tab(location.hash.slice(1), false));
  window.addEventListener("hashchange", () => tab(location.hash.slice(1), false));
  try {
    const pending = JSON.parse(sessionStorage.getItem("kai-login-return") || "null"); sessionStorage.removeItem("kai-login-return");
    if (pending?.expires > Date.now() && !location.hash && !location.search) {
      const target = window.KaiAccountRoutes.destination(pending.path);
      if (!embedded && (target.startsWith("/auth/workspace/") || target === "/workspace/chat")) { location.replace(target); return; }
      window.history.replaceState(null, "", target);
    }
  } catch {}
  tab(new URLSearchParams(location.search).has("code") ? "devices" : location.hash.slice(1), false);
  function selected() { return wallet || null; }
  let walletAccount = null;
  function rememberWallet() { try { if (walletAccount) localStorage.setItem("kai-credit-wallet-" + walletAccount, wallet); } catch {} }
  async function refresh() {
    const data = await api("/platform/api/overview?wallet=" + encodeURIComponent(wallet)); overview = data; initHistory(data.account.id);
    if (walletAccount !== data.account.id) {
      walletAccount = data.account.id;
      let saved; try { saved = localStorage.getItem("kai-credit-wallet-" + walletAccount); } catch {}
      const preferred = saved === null || saved === undefined ? (data.account.primaryCreditWallet || data.account.wallets[0]?.address || "") : saved;
      if (preferred && preferred !== wallet && data.account.wallets.some(w => w.address === preferred)) { wallet = preferred; return refresh(); }
    }
    $("email").textContent = data.account.email || "Your KAI account";
    $("wallet").replaceChildren(new Option("Account daily allowance", ""));
    for (const w of data.account.wallets) $("wallet").add(new Option((w.creditAccessOnly ? "Core · " : "") + w.address, w.address));
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
    if (!data.account.wallets.length) $("chat-free").checked = true;
    if (!wallet) { $("key-free").checked = true; $("key-purchase").checked = false; }
    $("chat-free").disabled = !data.account.wallets.length; $("key-free").disabled = !wallet; $("key-purchase").disabled = !wallet;
    try { const pending = JSON.parse(localStorage.getItem("kai-web-purchase-" + data.account.id) || "null"); if (pending) { $("tx").value = pending.txId; $("purchase-status").textContent = "Payment " + pending.txId + " needs confirmation. Select wallet " + pending.wallet + " and check the transaction before making another payment."; } } catch { /* Storage may be disabled. */ }
  }
  function modelLimit() { const model = overview?.models.find(m => m.model === $("model").value); if (model) { $("tokens").max = model.maxOutput; if (Number($("tokens").value) > model.maxOutput) $("tokens").value = model.maxOutput; } }
  $("model").onchange = modelLimit;
  $("wallet").onchange = async () => { wallet = $("wallet").value; rememberWallet(); try { await refresh(); } catch (e) { notice(e.message, true); } };
  action("refresh", refresh);
  action("logout", async () => { await api("/auth/logout", {}); login(); });
  action("connect", async () => {
    if (!overview || !window.kondor) throw Error("Wait for the page to load and enable the Kondor browser wallet.");
    const addresses = await kondor.getAccounts();
    if (!addresses?.length) throw Error("Choose an account in Kondor.");
    const address = addresses[0].address;
    if (!confirm(`Link ${address} to ${overview.account.email || "this KAI account"}? This account will be able to use this wallet's existing credits in Chat and API and view credit usage. Your wallet ownership and balance stay unchanged. KOIN payments still require wallet approval.`)) return;
    const ts = Date.now(), input = new TextEncoder().encode(JSON.stringify(["KAI-CREDIT-WALLET-LINK-V1", location.origin, address, overview.account.id, ts]));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    const raw = await kondor.getSigner(address).signHash(hash), signature = btoa(String.fromCharCode(...new Uint8Array(Object.values(raw))));
    await api("/account/credit-wallets", { address, ts, signature }); wallet = address; rememberWallet(); await refresh(); notice("Wallet connected. Select it whenever you want to use its purchased credits."); document.dispatchEvent(new Event("kai-wallet-linked"));
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
    if (!overview || !$("model").value) throw Error("Models are still loading. Please try again shortly.");
    const text = $("prompt").value.trim(); if (!text) return;
    const outgoing = [...history, { role: "user", content: text }]; message("user", text); const answer = message("assistant", "Connecting to a provider…");
    controller = new AbortController(); $("send").disabled = true; $("stop").hidden = false; $("prompt").value = ""; let content = "", done = false;
    try {
      const response = await fetch("/platform/api/chat", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), "x-kai-account": overview.account.id }, signal: controller.signal,
        body: JSON.stringify({ model: $("model").value, messages: outgoing, max_tokens: Number($("tokens").value), stream: true, freeOnly: $("chat-free").checked }) });
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
      history = [...outgoing, { role: "assistant", content }]; saveHistory();
    } catch (e) {
      const reason = e.name === "AbortError" ? "Stopped. Only verified delivered usage is charged." : e.message;
      if (!content) answer.textContent = reason; else { history = [...outgoing, { role: "assistant", content }]; saveHistory(); notice(reason, true); }
      throw e.name === "AbortError" ? Error(reason) : e;
    } finally { controller = null; $("stop").hidden = true; $("send").disabled = false; await refresh().catch(() => {}); }
  });
  action("stop", () => controller?.abort());
  action("clear", () => { if (controller) throw Error("Stop the current reply first."); history = []; currentChat = null; paintHistory(); $("messages").replaceChildren(make("p", "What would you like to work on?", "empty")); });
  let historyAccount = null, savedChats = [], currentChat = null;
  function initHistory(accountId) {
    if (!workspace || historyAccount === accountId) return;
    if (historyAccount !== null) { controller?.abort(); history = []; currentChat = null; $("messages").replaceChildren(); }
    historyAccount = accountId;
    try {
      const saved = JSON.parse(localStorage.getItem("kai-workspace-chats-" + accountId) || "[]");
      savedChats = Array.isArray(saved) ? saved.filter(c => typeof c.id === "string" && typeof c.title === "string" && Array.isArray(c.messages) && c.messages.length <= 200 && c.messages.every(m => ["user", "assistant"].includes(m.role) && typeof m.content === "string")).slice(0, 40) : [];
    } catch { savedChats = []; notice("Saved chats could not be read. They have not been changed.", true); historyAccount = null; }
    paintHistory();
  }
  function paintHistory() {
    if (!$("chat-history")) return;
    $("chat-history").replaceChildren();
    for (const item of savedChats) {
      const row = make("div", undefined, "saved-chat"), open = make("button", item.title, "nav"), remove = make("button", "×", "quiet");
      open.title = item.title; open.classList.toggle("active", item.id === currentChat); remove.setAttribute("aria-label", "Delete chat: " + item.title);
      open.onclick = () => { if (controller) return notice("Stop the current reply before changing chats.", true); currentChat = item.id; history = item.messages.map(m => ({ ...m })); $("messages").replaceChildren(); history.forEach(m => message(m.role, m.content)); paintHistory(); };
      remove.onclick = () => { if (controller || !confirm("Delete this chat from this browser?")) return; savedChats = savedChats.filter(c => c.id !== item.id); if (currentChat === item.id) $("clear").click(); persistHistory(); paintHistory(); };
      row.append(open, remove); $("chat-history").append(row);
    }
  }
  function persistHistory() {
    if (!historyAccount) return;
    try { localStorage.setItem("kai-workspace-chats-" + historyAccount, JSON.stringify(savedChats)); }
    catch { notice("Browser storage is full or unavailable. This conversation is still open, but could not be saved.", true); }
  }
  function saveHistory() {
    if (!workspace || !historyAccount) return;
    currentChat ||= crypto.randomUUID();
    const entry = { id: currentChat, title: history.find(m => m.role === "user")?.content.slice(0, 60) || "New chat", messages: history.slice(-200) };
    savedChats = [entry, ...savedChats.filter(c => c.id !== currentChat)].slice(0, 40); persistHistory(); paintHistory();
  }
  $("sidebar-new-chat").onclick = () => $("clear").click();
  form("buy", async () => {
    if (quotePending) return; if (!wallet) throw Error("Connect and select your payment wallet first.");
    if ($("tx").value) throw Error("Check the previous transaction before starting another purchase.");
    quotePending = true;
    try {
      draft = await api("/platform/api/purchase-quote", { dollars: $("dollars").value, creditWallet: selected() });
      $("purchase-review").textContent = `Pay ${draft.koin} KOIN for ${draft.credits} credits. Wallet: ${draft.signerAddress}. Quote expires ${new Date(draft.expiresAt).toLocaleTimeString()}.`;
      $("purchase-dialog").showModal();
    } finally { quotePending = false; }
  });
  action("cancel-purchase", () => { draft = null; $("purchase-dialog").close(); });
  action("approve-purchase", async () => {
    if (!draft || draft.expiresAt <= Date.now()) throw Error("Quote expired. Request a fresh quote.");
    const reviewed = draft; draft = null; $("purchase-dialog").close();
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
    if (data.purchase.state === "confirmed") { try { localStorage.removeItem("kai-web-purchase-" + overview.account.id); } catch {} $("tx").value = ""; }
  }
  form("recover", async () => { await checkPurchase(); await refresh(); });
  document.addEventListener("kai-wallet-unlinked", event => { if (wallet === event.detail) wallet = ""; refresh().catch(e => notice(e.message, true)); });
  document.addEventListener("kai-credit-primary-changed", event => { wallet = event.detail || ""; rememberWallet(); refresh().catch(e => notice(e.message, true)); });
  refresh().catch(e => notice(e.message, true));
})();
