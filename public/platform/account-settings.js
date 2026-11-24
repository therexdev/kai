"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const make = (tag, text, cls) => { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; };
  const notice = (text, error = false) => { $("notice").textContent = text; $("notice").hidden = !text; $("notice").classList.toggle("error", error); };
  let currentAccountId;
  async function api(url, body, method = body ? "POST" : "GET") {
    const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(currentAccountId ? { "x-kai-account": currentAccountId } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) { if (response.status === 401) { if (new URLSearchParams(location.search).get("embed") === "workspace") window.parent.postMessage({ type: "kai-workspace-login" }, "https://koinosai.com"); else location.assign("/login?next=" + encodeURIComponent(window.KaiAccountRoutes.destination(location.pathname + location.search + location.hash))); } throw Error(data.error?.message || data.error || "Please try again."); }
    return data;
  }
  function action(button, fn) {
    button.onclick = async () => { button.disabled = true; try { await fn(); } catch (e) { notice(e.message, true); } finally { button.disabled = false; } };
  }
  async function refreshAccount() {
    const { account } = await api("/account/api");
    currentAccountId = account.id;
    $("email").textContent = account.email || "Your KAI account";
    $("profile-email").textContent = account.email || "No email address";
    $("profile-methods").textContent = [account.email && "Email", account.google && "Google", account.passkeys?.length && "Passkey"].filter(Boolean).join(" · ");
    $("account-wallets").replaceChildren();
    for (const wallet of account.wallets || []) {
      const row = make("div", "", "key-row"), info = make("div", "", "wallet-info"), unlink = make("button", "Unlink", "danger");
      info.append(make("strong", wallet.address, "wallet-address"));
      if (wallet.creditAccessOnly) { info.append(make("p", "Linked Core credits · original balance and daily allowance")); unlink.textContent = "Remove credit access"; }
      const primary = make("button", account.primaryCreditWallet === wallet.address ? "Primary account" : "Make primary", "secondary");
      primary.disabled = account.primaryCreditWallet === wallet.address;
      action(primary, async () => { await api("/account/credit-primary", { address: wallet.address }); await refreshAccount(); document.dispatchEvent(new CustomEvent("kai-credit-primary-changed", { detail: wallet.address })); });
      info.append(primary);
      row.append(info, unlink);
      action(unlink, async () => {
        if (!confirm("Unlink " + wallet.address + "? Its purchased balance stays with the wallet. " + (wallet.creditAccessOnly ? "This website account loses credit access and its API keys for this wallet are revoked. Core keeps its original wallet connection." : "Wallet-bound API keys cannot use it while it is unlinked."))) return;
        await api((wallet.creditAccessOnly ? "/account/credit-wallets/" : "/account/wallets/") + encodeURIComponent(wallet.address), undefined, "DELETE");
        await refreshAccount(); document.dispatchEvent(new CustomEvent("kai-wallet-unlinked", { detail: wallet.address }));
      });
      $("account-wallets").append(row);
    }
    if (!account.wallets?.length) $("account-wallets").append(make("p", "No wallets connected yet. Your daily free allowance is available without one."));
    if (account.primaryCreditWallet) {
      const reset = make("button", "Use order added", "quiet");
      action(reset, async () => { await api("/account/credit-primary", { address: null }); await refreshAccount(); document.dispatchEvent(new CustomEvent("kai-credit-primary-changed", { detail: account.wallets[0]?.address || "" })); });
      $("account-wallets").append(reset);
    }
    $("account-passkeys").replaceChildren();
    for (const passkey of account.passkeys || []) $("account-passkeys").append(make("p", passkey.label || "Saved passkey"));
    if (!account.passkeys?.length) $("account-passkeys").append(make("p", "No passkeys added yet."));
  }
  async function sessions() {
    const data = await api("/account/sessions"); $("account-sessions").replaceChildren();
    for (const session of data.sessions || []) {
      const row = make("div", "", "key-row"), info = make("div", "", "session-info");
      info.append(make("strong", (session.label || "Device") + (session.current ? " · This browser" : "")), make("p", "Last used " + new Date(session.lastUsedAt).toLocaleString())); row.append(info);
      if (!session.current) { const revoke = make("button", "Sign out", "danger"); action(revoke, async () => { await api("/account/sessions/" + encodeURIComponent(session.id), undefined, "DELETE"); await sessions(); }); row.append(revoke); }
      $("account-sessions").append(row);
    }
    if (!data.sessions?.length) $("account-sessions").append(make("p", "No active sessions."));
  }
  $("settings-connect").onclick = () => $("connect").click();
  let approving = false;
  const code = new URLSearchParams(location.search).get("code");
  if (code && /^[A-Za-z0-9-]{4,32}$/.test(code)) $("device-code").value = code;
  $("device-form").onsubmit = async event => {
    event.preventDefault(); if (approving) return; approving = true; const button = $("device-form").querySelector("button"); button.disabled = true;
    try {
      await api("/auth/device/approve", { userCode: $("device-code").value.trim() });
      $("device-status").textContent = "Device approved. KAI Core will finish signing in shortly."; $("device-code").value = "";
      window.history.replaceState(null, "", "/account#devices"); await sessions();
    } catch (e) { $("device-status").textContent = e.message; } finally { approving = false; button.disabled = false; }
  };
  const decode = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const encode = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  action($("add-passkey"), async () => {
    if (!navigator.credentials) throw Error("Passkeys are not available in this browser.");
    const options = await api("/auth/passkey/register/options", {}), pk = options.publicKey;
    pk.challenge = decode(pk.challenge); pk.user.id = decode(pk.user.id); pk.excludeCredentials = (pk.excludeCredentials || []).map(c => ({ ...c, id: decode(c.id) }));
    const credential = await navigator.credentials.create({ publicKey: pk }); if (!credential) throw Error("Passkey registration was cancelled.");
    await api("/auth/passkey/register/verify", { challengeId: options.challengeId, attestationObject: encode(credential.response.attestationObject), clientDataJSON: encode(credential.response.clientDataJSON), label: navigator.platform || "Passkey" });
    await refreshAccount(); notice("Passkey added. You can use it next time you log in.");
  });
  action($("signout-all"), async () => {
    if (!confirm("Sign out all browsers and connected devices for this network account? You will need to log in again. API keys remain active until revoked separately.")) return;
    await api("/account/sessions/revoke-all", {}); location.assign("/login");
  });
  document.addEventListener("kai-account-tab", event => { if (["security", "wallets"].includes(event.detail)) refreshAccount().catch(e => notice(e.message, true)); if (event.detail === "devices") sessions().catch(e => notice(e.message, true)); });
  document.addEventListener("kai-wallet-linked", () => refreshAccount().catch(e => notice(e.message, true)));
  refreshAccount().catch(e => notice(e.message, true));
  if (location.hash === "#devices" || code) sessions().catch(e => notice(e.message, true));
})();
