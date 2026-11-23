"use strict";
window.addEventListener("message", event => {
  if (event.origin !== "https://credits.koinosai.com" || event.source !== document.getElementById("chat-workspace").contentWindow) return;
  if (event.data?.type === "kai-workspace-login") location.assign("/login");
});
