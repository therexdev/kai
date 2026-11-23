"use strict";
const crypto = require("node:crypto"), express = require("express");
const { destination } = require("../public/account-ui/account-routes");
const ISSUER = "https://credits.koinosai.com", COOKIE = "kai_workspace_state", ENTRY = "kai_workspace_entry";
const hash = value => crypto.createHash("sha256").update(value).digest("base64url");
const valid = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
function workspaceSso({ accounts, fetchImpl = fetch, clock = Date.now }) {
  const router = express.Router(), svc = accounts.service, db = svc.db;
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_logins (state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL,
    destination TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_identities (subject TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS workspace_entries (digest TEXT PRIMARY KEY, account_id TEXT NOT NULL, destination TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
  const cookieOptions = { httpOnly: true, secure: svc.siteOrigin.startsWith("https:"), sameSite: "lax", path: "/auth/workspace" };
  function start(req, res, nextPath) {
    db.prepare("DELETE FROM workspace_logins WHERE expires_at <= ?").run(clock());
    if (db.prepare("SELECT COUNT(*) AS n FROM workspace_logins").get().n >= 10000)
      return res.status(503).send("Sign-in is busy. Please try again shortly.");
    const state = crypto.randomBytes(32).toString("base64url"), verifier = crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO workspace_logins VALUES (?,?,?,?)").run(hash(state), verifier, destination(nextPath), clock() + 600000);
    res.cookie(COOKIE, state, { ...cookieOptions, maxAge: 600000 });
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.redirect(ISSUER + "/auth/workspace/authorize?" + new URLSearchParams({ state, challenge: hash(verifier) }));
  }
  function enter(req, res, nextPath) {
    const account = accounts.accountOf(req), cookie = String(req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(ENTRY + "="))?.slice(ENTRY.length + 1);
    db.prepare("DELETE FROM workspace_entries WHERE expires_at <= ?").run(clock());
    if (account && valid(cookie) && db.prepare("DELETE FROM workspace_entries WHERE digest=? AND account_id=? AND destination=? AND expires_at>?").run(hash(cookie), account.id, destination(nextPath), clock()).changes === 1) {
      res.clearCookie(ENTRY, { ...cookieOptions, path: "/" }); return true;
    }
    start(req, res, nextPath); return false;
  }
  router.get("/auth/workspace/start", (req, res) => start(req, res, req.query.next));
  router.get("/auth/workspace/callback", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      const state = String(req.query.state || ""), code = String(req.query.code || "");
      const cookie = String(req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
      if (!valid(state) || !valid(code) || cookie !== state) throw Error("The sign-in did not match this browser. Start again.");
      const row = db.prepare("SELECT * FROM workspace_logins WHERE state_hash = ? AND expires_at > ?").get(hash(state), clock());
      if (!row) throw Error("Workspace sign-in expired. Start again.");
      // Consume before the remote call; a failed exchange is restarted, never replayed.
      if (db.prepare("DELETE FROM workspace_logins WHERE state_hash = ?").run(hash(state)).changes !== 1) throw Error("Sign-in already completed.");
      const response = await fetchImpl(ISSUER + "/auth/workspace/exchange", { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/json" }, body: JSON.stringify({ code, verifier: row.verifier }) });
      if (!response.ok) throw Error("Could not complete sign-in. Please start again.");
      const text = await response.text(); if (text.length > 4096) throw Error("Invalid sign-in response.");
      const identity = JSON.parse(text);
      if (identity.issuer !== ISSUER || !/^acc_[a-f0-9]{16}$/.test(identity.subject) ||
          (identity.email !== null && (identity.emailVerified !== true || typeof identity.email !== "string" || identity.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email)))) throw Error("Invalid sign-in identity.");
      db.exec("BEGIN IMMEDIATE");
      let account;
      try {
        const mapping = db.prepare("SELECT account_id FROM workspace_identities WHERE subject = ?").get(identity.subject);
        account = mapping ? svc.getAccount(mapping.account_id) : identity.email ? svc._accountByEmail(identity.email.toLowerCase()) : null;
        if (mapping && !account) throw Error("Your saved workspace account needs recovery.");
        if (!mapping) {
          account ||= svc._newAccount({ email: identity.email?.toLowerCase() || null });
          db.prepare("INSERT INTO workspace_identities VALUES (?,?)").run(identity.subject, account.id);
        }
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      res.clearCookie(COOKIE, cookieOptions);
      if (accounts.accountOf(req)?.id !== account.id)
        res.cookie("kai_session", svc._issueSession(account.id, "KAI workspace"), { httpOnly: true, secure: cookieOptions.secure, sameSite: "lax", path: "/", maxAge: 30 * 86400000 });
      const entry = crypto.randomBytes(32).toString("base64url");
      db.prepare("DELETE FROM workspace_entries WHERE expires_at<=?").run(clock());
      db.prepare("INSERT INTO workspace_entries VALUES(?,?,?,?)").run(hash(entry), account.id, row.destination, clock() + 60000);
      res.cookie(ENTRY, entry, { ...cookieOptions, path: "/", maxAge: 60000 });
      res.redirect(row.destination);
    } catch {
      res.status(401).type("html").send('<p>We could not complete your sign-in. Your saved data is unchanged.</p><a href="/website-login">Try again</a>');
    }
  });
  return { router, start, enter };
}
module.exports = { workspaceSso };
