"use strict";
const express = require("express"), path = require("node:path");
const { destination } = require("../public/account-ui/account-routes");
const HOST = "https://credits.koinosai.com", RETURN_COOKIE = "kai_website_return";
function webAccountEntry({ accounts, publicDir = path.join(__dirname, "../public"), fetchImpl = fetch, clock = Date.now } = {}) {
  const router = express.Router(); let ready = false, checkedAt = -Infinity, checking;
  async function activated() {
    if (clock() - checkedAt < 20000) return ready;
    if (!checking) checking = (async () => {
      try {
        const response = await fetchImpl(HOST + "/health", { signal: AbortSignal.timeout(4000), redirect: "error" });
        if (response.ok) { const health = await response.json(); ready = health.webApiVersion === 1 && health.accountUiVersion === 1; }
      } catch { /* Keep the last verified routing capability on transient failure. */ }
      finally { checkedAt = clock(); checking = null; }
      return ready;
    })();
    return checking;
  }
  router.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer"); next(); });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const returnCookie = req => {
    const raw = String(req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith(RETURN_COOKIE + "="));
    if (!raw) return null; try { return destination(decodeURIComponent(raw.slice(RETURN_COOKIE.length + 1))); } catch { return null; }
  };
  const cookieOptions = req => ({ httpOnly: true, secure: req.secure, sameSite: "lax", path: "/" });
  router.get(["/login", "/login/"], wrap(async (_req, res) => res.redirect(HOST + (await activated() ? "/login" : "/account?next=/platform"))));
  router.get(["/platform", "/platform/"], wrap(async (_req, res) => res.redirect(HOST + (await activated() ? "/account" : "/platform"))));
  router.get("/platform/docs", (_req, res) => res.redirect(HOST + "/platform/docs"));
  router.get(["/account", "/account/"], wrap(async (req, res, next) => {
    // Old gated tools and their Google callback keep their website identity.
    const returning = returnCookie(req);
    if (returning && accounts?.accountOf(req)) { res.clearCookie(RETURN_COOKIE, cookieOptions(req)); return res.redirect(returning); }
    if (req.query.next && ["/dashboard", "/app", "/build", "/link", "/account/website"].includes(String(req.query.next).split("?")[0])) return res.redirect("/website-login?next=" + encodeURIComponent(destination(req.query.next)));
    if (await activated()) return res.redirect(HOST + "/account");
    next();
  }));
  router.get("/website-login", (req, res) => {
    const target = destination(req.query.next);
    if (accounts?.accountOf(req)) { res.clearCookie(RETURN_COOKIE, cookieOptions(req)); return res.redirect(target); }
    res.cookie(RETURN_COOKIE, target, { ...cookieOptions(req), maxAge: 600000 }); res.sendFile(path.join(publicDir, "website-login.html"));
  });
  router.get("/account/website", (req, res) => {
    if (!accounts?.accountOf(req)) return res.redirect("/website-login?next=%2Faccount%2Fwebsite");
    res.sendFile(path.join(publicDir, "account.html"));
  });
  return router;
}
module.exports = { webAccountEntry };
