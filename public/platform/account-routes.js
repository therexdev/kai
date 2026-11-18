"use strict";
// The only post-login destinations are sections of the account dashboard.
// Shared by the server and browser so old bookmarks and OAuth use one rule.
(function (root) {
  const sections = ["overview", "playground", "billing", "keys", "usage", "wallets", "devices", "security"];
  function destination(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) return "/account";
    let url; try { url = new URL(value, "https://account.invalid"); } catch { return "/account"; }
    if (url.origin !== "https://account.invalid" || !["/account", "/account/", "/platform", "/platform/", "/link"].includes(url.pathname)) return "/account";
    const code = url.searchParams.get("code"), section = url.hash.slice(1);
    if (code && /^[A-Za-z0-9-]{4,32}$/.test(code)) return "/account?code=" + encodeURIComponent(code) + "#devices";
    return "/account" + (url.pathname === "/link" ? "#devices" : sections.includes(section) ? "#" + section : "");
  }
  const routes = { sections, destination };
  if (typeof module !== "undefined" && module.exports) module.exports = routes;
  else root.KaiAccountRoutes = routes;
})(typeof window === "undefined" ? globalThis : window);
