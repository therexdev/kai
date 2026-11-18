"use strict";
(() => {
  const $ = id => document.getElementById(id), routes = window.KaiAccountRoutes;
  const next = routes.destination(new URLSearchParams(location.search).get("next"));
  const say = (text, error = false) => { $("login-status").textContent = text; $("login-status").hidden = !text; $("login-status").classList.toggle("error", error); };
  const remember = () => { try { sessionStorage.setItem("kai-website-return", JSON.stringify({ path: next, expires: Date.now() + 10 * 60 * 1000 })); } catch {} };
  const finish = () => { try { sessionStorage.removeItem("kai-website-return"); } catch {} location.replace("/website-login?next=" + encodeURIComponent(next)); };
  async function api(url, body) {
    const response = await fetch(url, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); if (!response.ok) throw Error(data.error?.message || data.error || "Sign-in is temporarily unavailable. Please try again."); return data;
  }
  async function methods() {
    $("retry-login").hidden = true;
    try {
      const data = await api("/auth/methods");
      if (!data.signin) throw Error("Sign-in is temporarily unavailable. Please try again.");
      $("email-form").hidden = !data.signin.email; $("google-method").hidden = !data.signin.google; $("passkey-method").hidden = !data.signin.passkey;
      document.querySelector(".login-divider").hidden = !data.signin.email;
      say(data.canCreateAccount === false ? "New account creation is currently unavailable. Existing accounts can use a saved passkey." : "");
    } catch (e) { say(e.message, true); $("retry-login").hidden = false; }
  }
  $("retry-login").onclick = methods;
  $("google-login").onclick = remember;
  $("change-email").onclick = () => { $("email-code-step").hidden = true; $("login-email").readOnly = false; $("login-code").required = false; $("login-code").value = ""; $("change-email").hidden = true; $("email-submit").textContent = "Continue with email"; say(""); $("login-email").focus(); };
  let pending = false;
  $("email-form").onsubmit = async event => {
    event.preventDefault(); if (pending) return; pending = true; $("email-submit").disabled = true;
    try {
      const email = $("login-email").value.trim();
      if ($("email-code-step").hidden) {
        await api("/auth/email/start", { email });
        $("login-email").readOnly = true; $("email-code-step").hidden = false; $("login-code").required = true; $("change-email").hidden = false; $("email-submit").textContent = "Log in";
        say("Code sent. Check your inbox and spam folder."); $("login-code").focus();
      } else { await api("/auth/email/verify", { email, code: $("login-code").value.trim() }); finish(); }
    } catch (e) { say(e.message, true); } finally { pending = false; $("email-submit").disabled = false; }
  };
  const decode = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const encode = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  $("passkey-login").onclick = async () => {
    $("passkey-login").disabled = true;
    try {
      if (!navigator.credentials) throw Error("Passkeys are not available in this browser. Use email or Google instead.");
      const options = await api("/auth/passkey/login/options", { email: $("login-email").value.trim() || undefined }), pk = options.publicKey;
      pk.challenge = decode(pk.challenge); pk.allowCredentials = (pk.allowCredentials || []).map(c => ({ ...c, id: decode(c.id) }));
      const credential = await navigator.credentials.get({ publicKey: pk }); if (!credential) throw Error("Passkey sign-in was cancelled.");
      await api("/auth/passkey/login/verify", { challengeId: options.challengeId, credentialId: encode(credential.rawId), authenticatorData: encode(credential.response.authenticatorData), clientDataJSON: encode(credential.response.clientDataJSON), signature: encode(credential.response.signature) }); finish();
    } catch (e) { say(e.name === "NotAllowedError" ? "Passkey sign-in was cancelled. You can try again or use email or Google." : e.message, true); } finally { $("passkey-login").disabled = false; }
  };
  methods();
})();
