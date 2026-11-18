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
      if (response.status === 401) location.assign("/account?next=/platform");
      throw Error(value.error?.message || value.error || "Request failed. Please try again.");
    }
    return value;
  }
  function action(id, fn) {
    $(id).onclick = async () => { $(id).disabled = true; notice(""); try { await fn(); } catch (e) { notice(e.message, true); } finally { $(id).disabled = false; } };
  }
  function form(id, fn) { $(id).onsubmit = async e => { e.preventDefault(); notice(""); try { await fn(); } catch (err) { notice(err.message, true); } }; }
  function tab(id) {
    document.querySelectorAll(".tab").forEach(n => { n.hidden = n.id !== id; });
    document.querySelectorAll(".nav[data-tab]").forEach(n => n.classList.toggle("active", n.dataset.tab === id));
    if (id === "keys") loadKeys().catch(e => notice(e.message, true));
  }
  document.querySelectorAll("[data-tab]").forEach(n => { n.onclick = () => tab(n.dataset.tab); });
  function selected() { return wallet || null; }
  async function refresh() {
    const data = await api("/platform/api/overview?wallet=" + encodeURIComponent(wallet)); overview = data;
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
  action("logout", async () => { await api("/auth/logout", {}); location.assign("/account"); });
  action("connect", async () => {
    if (!overview || !window.kondor) throw Error("Wait for the page to load and enable the Kondor browser wallet.");
    const addresses = await kondor.getAccounts();
    if (!addresses?.length) throw Error("Choose an account in Kondor.");
    const address = addresses[0].address, ts = Date.now(), input = new TextEncoder().encode(`link|${address}|${overview.account.id}|${ts}`);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    const raw = await kondor.getSigner(address).signHash(hash), signature = btoa(String.fromCharCode(...new Uint8Array(Object.values(raw))));
    await api("/account/wallets", { address, ts, signature }); wallet = address; await refresh(); notice("Wallet connected. Select it whenever you want to use its purchased credits.");
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
  refresh().catch(e => notice(e.message, true));
})();
