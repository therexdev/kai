"use strict";
(function (root) {
  // Compatibility for existing website tools. Credentials never cross hosts.
  function destination(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) return "/dashboard";
    let url; try { url = new URL(value, "https://website.invalid"); } catch { return "/dashboard"; }
    if (url.origin !== "https://website.invalid" || !["/dashboard", "/app", "/build", "/link", "/account/website"].includes(url.pathname)) return "/dashboard";
    const code = url.searchParams.get("code");
    return url.pathname + (url.pathname === "/link" && code && /^[A-Za-z0-9-]{4,32}$/.test(code) ? "?code=" + encodeURIComponent(code) : "");
  }
  const routes = { destination };
  if (typeof module !== "undefined" && module.exports) module.exports = routes;
  else root.KaiAccountRoutes = routes;
})(typeof window === "undefined" ? globalThis : window);
