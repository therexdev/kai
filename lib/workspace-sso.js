"use strict";
// One sign-in for the workspace and billing, without sharing browser cookies
// or passing a reusable session through a URL. Fixed client, S256 PKCE, one use.
const crypto = require("node:crypto"), express = require("express");
const CALLBACK = "https://koinosai.com/auth/workspace/callback";
const hash = value => crypto.createHash("sha256").update(value).digest("base64url");
const valid = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
function authorizePath(value) {
  let url; try { url = new URL(value, "https://credits.koinosai.com"); } catch { return null; }
  if (url.origin !== "https://credits.koinosai.com" || url.pathname !== "/auth/workspace/authorize" ||
      !valid(url.searchParams.get("state")) || !valid(url.searchParams.get("challenge"))) return null;
  return "/auth/workspace/authorize?" + new URLSearchParams({ state: url.searchParams.get("state"), challenge: url.searchParams.get("challenge") });
}
function workspaceSso(accounts, clock = Date.now) {
  const router = express.Router(), db = accounts.service.db;
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_codes (digest TEXT PRIMARY KEY, account_id TEXT NOT NULL,
    challenge TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  router.use((req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); next(); });
  router.get("/auth/workspace/authorize", (req, res) => {
    const target = authorizePath(req.originalUrl);
    if (!target) return res.status(400).send("Invalid workspace sign-in. Open Chat or Build and sign in again.");
    const account = accounts.accountOf(req);
    if (!account) return res.redirect("/login?next=" + encodeURIComponent(target));
    db.prepare("DELETE FROM workspace_codes WHERE expires_at <= ?").run(clock());
    // Bound active authorization requests for a signed-in account.
    if (db.prepare("SELECT COUNT(*) AS n FROM workspace_codes WHERE account_id = ?").get(account.id).n >= 20)
      return res.status(429).send("Too many sign-in attempts. Wait two minutes and try again.");
    const code = crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO workspace_codes VALUES (?,?,?,?)").run(hash(code), account.id, req.query.challenge, clock() + 120000);
    res.redirect(CALLBACK + "?" + new URLSearchParams({ code, state: req.query.state }));
  });
  router.post("/auth/workspace/exchange", express.json({ limit: "2kb" }), (req, res) => {
    const { code, verifier } = req.body || {};
    if (!valid(code) || !valid(verifier)) return res.status(400).json({ error: "Invalid workspace sign-in" });
    const row = db.prepare("SELECT * FROM workspace_codes WHERE digest = ? AND expires_at > ?").get(hash(code), clock());
    if (!row || row.challenge !== hash(verifier)) return res.status(401).json({ error: "Workspace sign-in expired. Start again." });
    const account = accounts.service.getAccount(row.account_id);
    if (!account || db.prepare("DELETE FROM workspace_codes WHERE digest = ?").run(hash(code)).changes !== 1)
      return res.status(401).json({ error: "Workspace sign-in expired. Start again." });
    res.json({ issuer: "https://credits.koinosai.com", subject: account.id, email: account.email || null, emailVerified: !!account.email });
  });
  return router;
}
module.exports = { workspaceSso, authorizePath };
