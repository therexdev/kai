"use strict";
const fs = require("node:fs"), path = require("node:path"), express = require("express");
const WEBSITE = "https://koinosai.com";
const WEBSITE_PATHS = new Set(["/", "/dashboard", "/network", "/testers", "/app", "/docs", "/docs/", "/updates", "/privacy"]);
function handles(pathname) {
  return WEBSITE_PATHS.has(pathname) || /^\/(auth|account|i18n)(\/|$)/.test(pathname) || pathname === "/link" || /^\/redesign\/(brand-mark|kai-companion)\.svg$/.test(pathname);
}
function createCreditAccountWeb(router) {
  const publicDir = path.join(__dirname, "../public"), source = fs.readFileSync(path.join(publicDir, "account.html"), "utf8");
  if (!source.includes("<body>")) throw Error("Account page service marker missing");
  const html = source.replace("<body>", '<body data-account-service="credits">');
  const app = express(); app.disable("x-powered-by"); app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (["GET", "HEAD"].includes(req.method) && WEBSITE_PATHS.has(req.path)) {
      // Fixed destinations only. Never forward a credit cookie, device code,
      // bearer, or caller-provided redirect query to the website service.
      res.setHeader("Referrer-Policy", "no-referrer");
      return res.redirect(302, WEBSITE + req.path);
    }
    next();
  });
  app.use(router);
  app.get(["/account", "/link"], (_req, res) => res.type("html").send(html));
  app.use("/i18n", express.static(path.join(publicDir, "i18n")));
  for (const asset of ["brand-mark.svg", "kai-companion.svg"]) app.get("/redesign/" + asset, (_req, res) => res.sendFile(path.join(publicDir, "redesign", asset)));
  app.use((_req, res) => res.status(404).json({ error: "Unknown account route" }));
  return app;
}
module.exports = { createCreditAccountWeb, handles, WEBSITE };
