"use strict";

/*
 * kai — Koinos AI production website.
 * Serves the self-contained landing page from /public and records waitlist
 * signups to data/waitlist.jsonl. Designed for Hostinger Node.js hosting:
 * no build step, no database, PORT injected by the platform.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const WAITLIST_FILE = path.join(DATA_DIR, "waitlist.jsonl");

app.disable("x-powered-by");
// Hostinger fronts Node apps with a reverse proxy — trust the first hop so
// req.ip is the real client address (the rate limiter depends on it).
app.set("trust proxy", 1);

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

/* ---------------------------------------------------------- rate limiting */
// Sliding window, in memory, per IP. Plenty for a waitlist form; state
// resets on restart by design.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map(); // ip -> [epoch ms of recent requests]

function rateLimited(ip) {
  const cutoff = Date.now() - WINDOW_MS;
  const recent = (hits.get(ip) || []).filter((t) => t > cutoff);
  const limited = recent.length >= MAX_PER_WINDOW;
  if (!limited) recent.push(Date.now());
  hits.set(ip, recent);
  return limited;
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, times] of hits) {
    const recent = times.filter((t) => t > cutoff);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}, WINDOW_MS).unref();

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

/* ------------------------------------------------------------------ routes */
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post("/api/waitlist", async (req, res) => {
  try {
    if (rateLimited(req.ip || "unknown")) {
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
    if (segment !== "people" && segment !== "dev") {
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

/* --------------------------------------------------------------- fallbacks */
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
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
});
