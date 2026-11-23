"use strict";
// Fixed destinations for the workspace, account dashboard and PKCE handoff.
// Shared by the server and browser so old bookmarks and OAuth use one rule.
(function (root) {
  const sections = ["overview", "playground", "billing", "keys", "usage", "wallets", "devices", "security"];
  function destination(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) return "/account";
    let url; try { url = new URL(value, "https://account.invalid"); } catch { return "/account"; }
    if (url.origin === "https://account.invalid" && url.pathname === "/auth/workspace/authorize" &&
        /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state")) && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("challenge")))
      return "/auth/workspace/authorize?" + new URLSearchParams({ state: url.searchParams.get("state"), challenge: url.searchParams.get("challenge") });
    if (url.origin === "https://account.invalid" && ["/app", "/app/", "/workspace/chat"].includes(url.pathname)) return "/workspace/chat";
    if (url.origin !== "https://account.invalid" || !["/account", "/account/", "/platform", "/platform/", "/link"].includes(url.pathname)) return "/account";
    if (url.hash === "#playground") return "/workspace/chat";
    const code = url.searchParams.get("code"), section = url.hash.slice(1);
    if (code && /^[A-Za-z0-9-]{4,32}$/.test(code)) return "/account?code=" + encodeURIComponent(code) + "#devices";
    return "/account" + (url.pathname === "/link" ? "#devices" : sections.includes(section) ? "#" + section : "");
  }
  const routes = { sections, destination };
  if (typeof module !== "undefined" && module.exports) module.exports = routes;
  else root.KaiAccountRoutes = routes;
})(typeof window === "undefined" ? globalThis : window);
