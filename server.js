"use strict";

/*
 * kai — Koinos AI production website.
 * Serves the self-contained landing page from /public, records waitlist
 * signups to data/waitlist.jsonl, and exposes a password-protected admin
 * area at /admin for viewing and exporting the lists.
 * Designed for Hostinger Node.js hosting: no build step, no database.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const auth = require("./lib/auth");
const store = require("./lib/store");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const VIEWS_DIR = path.join(__dirname, "views");
const DATA_DIR = path.join(__dirname, "data");
const WAITLIST_FILE = path.join(DATA_DIR, "waitlist.jsonl");

app.disable("x-powered-by");
// Hostinger fronts Node apps with a reverse proxy — trust the first hop so
// req.ip is the real client address (the rate limiters depend on it) and
// req.secure reflects the browser's HTTPS connection (the cookie does too).
app.set("trust proxy", 1);

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

/* ------------------------------------------------------- admin credentials */
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const ADMIN_PLAIN = process.env.ADMIN_PASSWORD || "";
const ADMIN_ENABLED = Boolean(ADMIN_HASH || ADMIN_PLAIN);
const SESSION_SECRET = process.env.SESSION_SECRET || auth.randomSecret();
const SESSION_COOKIE = "kai_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

if (!ADMIN_ENABLED) {
  console.warn(
    "admin area DISABLED: set ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD) to enable /admin"
  );
} else if (!ADMIN_HASH) {
  console.warn(
    "admin using plaintext ADMIN_PASSWORD — prefer ADMIN_PASSWORD_HASH (npm run hash-password)"
  );
}
if (!process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET not set — using a random one; admin sessions end on restart");
}

/* ---------------------------------------------------------- rate limiting */
// Sliding window, in memory, per IP. Plenty at this scale; state resets on
// restart by design.
function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
    }
  }, windowMs);
  timer.unref();

  return function limit(key) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => t > now - windowMs);
    const limited = recent.length >= max;
    if (!limited) recent.push(now);
    hits.set(key, recent);
    return limited;
  };
}

const waitlistLimit = makeLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
const loginLimit = makeLimiter({ windowMs: 15 * 60 * 1000, max: 8 });

/* -------------------------- optional signup notifications (nodemailer) --- */
// Off by default: enabled only when SMTP_HOST and SMTP_TO are both set.
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_TO) {
  const nodemailer = require("nodemailer");
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: smtpPort,
    secure: process.env.SMTP_SECURE
      ? /^(1|true|yes)$/i.test(process.env.SMTP_SECURE)
      : smtpPort === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  console.log(`signup notifications enabled -> ${process.env.SMTP_TO}`);
}

function notifySignup(entry) {
  if (!mailer) return;
  // Fire and forget — a mail failure must never fail the signup.
  mailer
    .sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.SMTP_TO,
      subject: `KAI waitlist signup: ${entry.email} (${entry.segment})`,
      text: `New waitlist signup\n\nemail:   ${entry.email}\nsegment: ${entry.segment}\ntime:    ${entry.ts}\n`,
    })
    .catch((err) => console.error("signup notification failed:", err.message));
}

/* --------------------------------------------------------- public routes */
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post("/api/waitlist", async (req, res) => {
  try {
    if (waitlistLimit(req.ip || "unknown")) {
      return res
        .status(429)
        .json({ ok: false, error: "Too many requests — try again in a few minutes." });
    }

    const body = req.body || {};

    // Honeypot: humans never see the "website" field. Answer ok so bots
    // can't tell they were filtered, but record nothing.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return res.json({ ok: true });
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: "Enter a valid email address." });
    }

    const segment = body.segment === undefined ? "people" : body.segment;
    if (!store.SEGMENTS.includes(segment)) {
      return res.status(400).json({ ok: false, error: "Invalid segment." });
    }

    const entry = { ts: new Date().toISOString(), email, segment };
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.appendFile(WAITLIST_FILE, JSON.stringify(entry) + "\n", "utf8");

    notifySignup(entry);

    return res.json({ ok: true });
  } catch (err) {
    console.error("waitlist error:", err);
    return res.status(500).json({ ok: false, error: "Server error — please try again." });
  }
});

/* ----------------------------------------------------------- admin area */
// Never cache or index anything under /admin — it renders personal data.
app.use("/admin", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

function currentSession(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return auth.verifySession(token, SESSION_SECRET);
}

/** Gate for everything that returns list data. Fails closed. */
function requireAuth(req, res, next) {
  if (!ADMIN_ENABLED) {
    return res.status(503).json({ ok: false, error: "Admin area is not configured." });
  }
  if (!currentSession(req)) {
    return res.status(401).json({ ok: false, error: "Not signed in." });
  }
  return next();
}

app.get("/admin", (req, res) => {
  if (!ADMIN_ENABLED) {
    return res
      .status(503)
      .type("text/plain")
      .send("Admin area is not configured. Set ADMIN_PASSWORD_HASH and restart.");
  }
  const page = currentSession(req) ? "admin.html" : "login.html";
  return res.sendFile(path.join(VIEWS_DIR, page));
});

app.post("/admin/login", (req, res) => {
  if (!ADMIN_ENABLED) {
    return res.status(503).json({ ok: false, error: "Admin area is not configured." });
  }
  if (loginLimit(req.ip || "unknown")) {
    return res
      .status(429)
      .json({ ok: false, error: "Too many attempts — wait 15 minutes and try again." });
  }

  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  const okPassword = ADMIN_HASH
    ? auth.verifyPassword(password, ADMIN_HASH)
    : auth.verifyPlaintext(password, ADMIN_PLAIN);

  if (!password || !okPassword) {
    console.warn(`failed admin login from ${req.ip}`);
    return res.status(401).json({ ok: false, error: "Incorrect password." });
  }

  const now = Date.now();
  const token = auth.signSession({ iat: now, exp: now + SESSION_TTL_MS }, SESSION_SECRET);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure, // set automatically once served over HTTPS
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return res.json({ ok: true });
});

app.post("/admin/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/" });
  return res.json({ ok: true });
});

app.get("/admin/api/summary", requireAuth, async (_req, res, next) => {
  try {
    const all = await store.readEntries(WAITLIST_FILE);
    const unique = store.dedupe(all);
    return res.json({
      ok: true,
      counts: store.summarize(unique),
      duplicates: all.length - unique.length,
      recent: unique.slice(-200).reverse(),
    });
  } catch (err) {
    return next(err);
  }
});

function requestedSegment(req) {
  const raw = typeof req.query.segment === "string" ? req.query.segment : "all";
  return raw === "all" || store.SEGMENTS.includes(raw) ? raw : null;
}

function exportName(segment, ext) {
  const day = new Date().toISOString().slice(0, 10);
  return `koinos-waitlist-${segment}-${day}.${ext}`;
}

app.get("/admin/export.csv", requireAuth, async (req, res, next) => {
  try {
    const segment = requestedSegment(req);
    if (!segment) return res.status(400).json({ ok: false, error: "Unknown segment." });
    const rows = store.bySegment(store.dedupe(await store.readEntries(WAITLIST_FILE)), segment);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${exportName(segment, "csv")}"`);
    return res.send(store.toCsv(rows));
  } catch (err) {
    return next(err);
  }
});

app.get("/admin/export.json", requireAuth, async (req, res, next) => {
  try {
    const segment = requestedSegment(req);
    if (!segment) return res.status(400).json({ ok: false, error: "Unknown segment." });
    const rows = store.bySegment(store.dedupe(await store.readEntries(WAITLIST_FILE)), segment);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${exportName(segment, "json")}"`);
    return res.send(JSON.stringify({ segment, count: rows.length, entries: rows }, null, 2));
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------- static assets + fallbacks */
app.use(express.static(PUBLIC_DIR));

app.use((req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/admin/")) {
    return res.status(404).json({ ok: false, error: "Not found." });
  }
  return res.status(404).type("text/plain").send("Not found");
});

// Malformed JSON bodies etc. — answer JSON instead of Express's HTML error page.
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ ok: false, error: status < 500 ? "Invalid request." : "Server error." });
});

app.listen(PORT, () => {
  console.log(`kai listening on http://localhost:${PORT}`);
  console.log(`admin: ${ADMIN_ENABLED ? "enabled at /admin" : "disabled"}`);
});
