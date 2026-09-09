"use strict";
(() => {
  const form = document.getElementById("composio-admin-form"), status = document.getElementById("composio-status");
  if (!form) return;
  const show = s => {
    document.getElementById("composio-enabled").checked = s.enabled;
    document.getElementById("composio-key").placeholder = s.configured ? "Key saved securely · leave blank to keep" : "Paste your project API key";
    status.textContent = s.locked ? "Saved key locked: restore the server's original SESSION_SECRET." : s.available ? "Managed connections are available to signed-in KAI users." : "Managed connections are off. Users can still bring their own Composio key.";
    if (s.keySource === "environment") status.textContent += " The key is set by the server environment.";
    if (!s.writable) status.textContent += " Set a persistent SESSION_SECRET to edit these settings.";
  };
  fetch("/admin/api/connections").then(r => r.json()).then(s => { if (!s.ok) throw new Error(s.error); show(s); }).catch(e => status.textContent = e.message);
  form.addEventListener("submit", async e => {
    e.preventDefault(); const b = form.querySelector("button"); b.disabled = true; status.textContent = "Checking and saving…";
    const key = document.getElementById("composio-key");
    try { const r = await fetch("/admin/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: document.getElementById("composio-enabled").checked, key: key.value.trim() }) }); key.value = ""; const s = await r.json(); if (!r.ok || !s.ok) throw new Error(s.error || "Could not save settings."); show(s); }
    catch (error) { status.textContent = error.message; } finally { key.value = ""; b.disabled = false; }
  });
})();
