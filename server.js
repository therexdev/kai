"use strict";

/*
 * kai — Koinos AI production website.
 * Serves the self-contained landing page from /public, records waitlist
 * signups to data/waitlist.jsonl, and exposes a password-protected admin
 * area at /admin for viewing and exporting the lists.
 * Designed for Hostinger Node.js hosting: no build step, no database.
 */

// Operational flags travel with the repo (deploy/app.env) because production
// deploys are git-pull only; the real environment (systemd's kai.env) always
// wins. Loaded before EVERYTHING else — several modules read env at require
// time (scheduler: KAI_REF_USD / KAI_PRICE_SOURCES / KAI_STORE).
{
  const { loadEnvFile } = require("./lib/env-file");
  const r = loadEnvFile(require("path").join(__dirname, "deploy", "app.env"));
  if (r.applied.length) console.log(`[env] deploy/app.env applied: ${r.applied.join(", ")}`);
  if (r.skipped.length) console.log(`[env] deploy/app.env skipped (real env wins): ${r.skipped.join(", ")}`);
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const auth = require("./lib/auth");
const store = require("./lib/store");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const VIEWS_DIR = path.join(__dirname, "views");
// Persistent state lives OUTSIDE the application root. Hostinger's Git
// deploy replaces the app directory's contents, which deletes untracked
// files — waitlist signups and scheduler state were wiped on every
// redeploy while they lived here (field finding). The hosting account's
// home directory survives deploys.
const STATE_ROOT = process.env.KAI_STATE_DIR || path.join(os.homedir(), ".koinos-ai");
const DATA_DIR = path.join(STATE_ROOT, "website");
const WAITLIST_FILE = path.join(DATA_DIR, "waitlist.jsonl");
const SCHEDULER_DATA = process.env.SCHEDULER_DATA || path.join(STATE_ROOT, "scheduler");

// One-time migration: carry whatever survives in the legacy in-root
// locations over to the durable state dir. Merge, never clobber — the
// legacy copy may be stale (post-wipe) while the new dir is live, or the
// only copy of pre-wipe data. Legacy files are left in place; the next
// redeploy removes them.
function migrateLegacyState() {
  try {
    const legacyWaitlist = path.join(__dirname, "data", "waitlist.jsonl");
    if (fs.existsSync(legacyWaitlist)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      let have = new Set();
      try {
        have = new Set(fs.readFileSync(WAITLIST_FILE, "utf8").split("\n").filter(Boolean));
      } catch { /* no durable file yet */ }
      const add = fs.readFileSync(legacyWaitlist, "utf8").split("\n").filter((l) => l.trim() && !have.has(l));
      if (add.length) fs.appendFileSync(WAITLIST_FILE, add.join("\n") + "\n");
      console.log(`[migrate] waitlist: ${add.length} legacy signup(s) merged into ${WAITLIST_FILE}`);
    }
    const legacySched = path.join(__dirname, ".data", "scheduler");
    if (fs.existsSync(legacySched)) {
      fs.mkdirSync(SCHEDULER_DATA, { recursive: true });
      let copied = 0;
      for (const f of fs.readdirSync(legacySched)) {
        // Epoch records are append-only — backfill any the durable dir
        // lacks. Live ledgers (credits, oracle) copy only when absent:
        // the durable copy, if present, is newer than the legacy one.
        const dest = path.join(SCHEDULER_DATA, f);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(legacySched, f), dest);
          copied++;
        }
      }
      if (copied) console.log(`[migrate] scheduler: ${copied} legacy file(s) copied into ${SCHEDULER_DATA}`);
    }
  } catch (err) {
    console.error("[migrate] legacy state migration failed:", err.message);
  }
}
migrateLegacyState();

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
// Koinos AI earning scheduler (M2 alpha) — mounted BEFORE the body parsers
// because it reads its own request streams. Workers connect outbound from
// the desktop app; operator endpoints stay closed unless a secret is set.
const { Scheduler, startAutoOps } = require("./lib/scheduler");
const { startBackups, snapshotOnce, latestBackupPath } = require("./lib/state-backup");
const { startRuntimeLog } = require("./lib/runtime-log");
const { computeTrends } = require("./lib/shadow-trends");
// Restart forensics: bumps a boot counter and captures WHY the previous
// process exited (host signal vs code crash) so a mystery restart becomes
// evidence on the next boot. Surfaced on /api/health.
const runtime = startRuntimeLog(SCHEDULER_DATA, (m) => console.log(`[runtime] ${m}`));
// With KAI_OPERATOR_WIF set, every closed epoch settles itself on-chain
// (submit_root + per-worker claims) and /scheduler/balance serves KAI
// balances to the app's Earn tab. Without it, epochs still close and
// persist — settlement can be run later via /scheduler/operator/settle.
let settlement = null;
if (process.env.KAI_OPERATOR_WIF) {
  const { makeSettlement } = require("./lib/chain");
  settlement = makeSettlement({
    wif: process.env.KAI_OPERATOR_WIF,
    contractId: process.env.KAI_CONTRACT || "149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz",
    abiPath: path.join(__dirname, "lib", "kai-abi.json"),
  });
  console.log("[scheduler] on-chain settlement enabled");
}
const scheduler = new Scheduler({
  dataDir: SCHEDULER_DATA,
  operatorSecret: process.env.KAI_OPERATOR_SECRET || null,
  settlement,
  onEvent: (e) => console.log(`[scheduler] ${e.type}`, e.worker ?? e.root ?? ""),
});
startAutoOps(scheduler);
startBackups(SCHEDULER_DATA, (m) => console.log(`[backup] ${m}`), () => scheduler.store?.exportViews?.());
app.use("/scheduler", (req, res) => {
  scheduler.handle(req, res).catch((err) => {
    try { res.status(500).json({ ok: false, error: String(err.message) }); } catch { /* gone */ }
  });
});

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

/* ------------------------------------------------------- admin credentials */
// Simple path: set ADMIN_EMAIL + ADMIN_PASSWORD and you're done.
// Optional hardening: ADMIN_PASSWORD_HASH (npm run hash-password) takes
// precedence when it is present and valid.
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PLAIN = process.env.ADMIN_PASSWORD || "";
const ADMIN_HASH = auth.normalizeHash(process.env.ADMIN_PASSWORD_HASH);

// A malformed hash can never match any password. Fall back to the plaintext
// password if one is set, so a stale broken hash can't lock you out.
const HASH_CHECK = ADMIN_HASH ? auth.describeHash(ADMIN_HASH) : { ok: false, reason: "empty" };
const HASH_BROKEN = Boolean(ADMIN_HASH) && !HASH_CHECK.ok;
const USE_HASH = Boolean(ADMIN_HASH) && HASH_CHECK.ok;
const ADMIN_ENABLED = USE_HASH || Boolean(ADMIN_PLAIN);
const SESSION_SECRET = process.env.SESSION_SECRET || auth.randomSecret();
const SESSION_COOKIE = "kai_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

if (HASH_BROKEN) {
  console.error(
    `\n*** ADMIN_PASSWORD_HASH is malformed (${HASH_CHECK.reason}) — ignoring it. ***\n` +
      (ADMIN_PLAIN
        ? "    Falling back to ADMIN_PASSWORD. Delete ADMIN_PASSWORD_HASH to silence this.\n"
        : "    Set ADMIN_PASSWORD to a plain password, or re-copy the whole hash.\n")
  );
}
if (!ADMIN_ENABLED) {
  console.warn(
    "admin area DISABLED: set ADMIN_EMAIL and ADMIN_PASSWORD to enable /admin"
  );
} else {
  // Print exactly what login will expect, so a missed restart is obvious.
  console.log(
    `admin credentials: ${ADMIN_EMAIL ? `email "${ADMIN_EMAIL}" + password` : "password only"}` +
      ` (${USE_HASH ? "hashed" : "plaintext ADMIN_PASSWORD"})`
  );
  if (!ADMIN_EMAIL) {
    console.log("  tip: set ADMIN_EMAIL to sign in with an email as well as a password");
  }
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
const feedbackLimit = makeLimiter({ windowMs: 10 * 60 * 1000, max: 6 });
const FEEDBACK_FILE = path.join(DATA_DIR, "feedback.jsonl");
const loginLimit = makeLimiter({ windowMs: 15 * 60 * 1000, max: 8 });

/* ------------------------------------- outbound mail (nodemailer, shared) */
// One transport, two consumers: waitlist signup notifications (needs
// SMTP_TO as the destination) and account sign-in codes (sent to the user,
// so SMTP_HOST alone enables them). No SMTP_HOST -> both quietly off, and
// the auth endpoint says so with a 503 instead of pretending.
let mailer = null;
if (process.env.SMTP_HOST) {
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
  if (process.env.SMTP_TO) console.log(`signup notifications enabled -> ${process.env.SMTP_TO}`);
}

function notifySignup(entry) {
  if (!mailer || !process.env.SMTP_TO) return;
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

/* --------------------------------- accounts + cross-device auth (task #49) */
// Email-code / passkey / Google sign-in with device-link for the desktop app
// and signed wallet attachment. Its own sqlite DB under STATE_ROOT/accounts.
// If sqlite is unavailable the whole surface answers 503 LOUDLY — an identity
// system must never silently degrade.
let accounts = null;
try {
  const { createAccounts } = require("./lib/accounts");
  accounts = createAccounts({
    stateDir: STATE_ROOT,
    sendMail: mailer
      ? (m) => mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, ...m })
      : null,
    siteOrigin: process.env.KAI_SITE_ORIGIN || "https://koinosai.com",
    google:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
        : null,
    onEvent: (e) => console.log(`[accounts] ${e.type}`, e.account ?? e.address ?? e.id ?? ""),
  });
  app.use(accounts.router);
  /*
   * Hand the scheduler the account service so a session + spend grant can
   * resolve, in this process, to the address its ledger already keys on.
   * Assigned AFTER construction rather than passed in, because the scheduler
   * is built earlier in this file and reordering that to satisfy one optional
   * dependency would be the tail wagging the dog. The scheduler treats a
   * missing service as "no session lane" and says so.
   */
  scheduler.accounts = accounts.service;
  console.log(
    `[accounts] enabled — passkeys on, email ${mailer ? "on" : "OFF (set SMTP_HOST)"}, ` +
      `google ${process.env.GOOGLE_CLIENT_ID ? "on" : "OFF (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)"}`
  );
} catch (e) {
  console.error(`[accounts] DISABLED: ${e.message}`);
  app.use(["/auth", "/account"], (_req, res) =>
    res.status(503).json({ ok: false, error: "accounts are unavailable on this server right now" })
  );
}
// One page serves sign-in, the account view, and device-link approval; the
// /link deep-link is what the desktop app shows next to its code.
app.get(["/account", "/link"], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "account.html")));

/* ----------------------------------------- tester docs (docs.koinosai.com) */
// The docs SITE lives in public/docs — no build step, markdown rendered
// client-side by the same safe renderer the app uses for chat. Served two
// ways: koinosai.com/docs works the moment this deploys, and the
// docs.koinosai.com hostname works once the owner adds (1) a DNS A record
// for `docs` pointing at this box and (2) one Caddyfile block:
//
//     docs.koinosai.com {
//         reverse_proxy 127.0.0.1:3000
//     }
//
// Caddy handles TLS for the subdomain automatically; this middleware routes
// by Host header (trust proxy is on, so req.hostname is the real one).
const DOCS_DIR = path.join(PUBLIC_DIR, "docs");
const docsStatic = express.static(DOCS_DIR);
app.use((req, res, next) => {
  if (!/^docs\./i.test(req.hostname || "")) return next();
  if (req.path === "/") return res.sendFile(path.join(DOCS_DIR, "index.html"));
  return docsStatic(req, res, () => res.status(404).type("text/plain").send("Not found"));
});
// Without the trailing slash the page's relative assets (md.js, content/)
// would resolve against the site root — redirect so they resolve under
// /docs/. NOTE express matches "/docs" for BOTH spellings (strict routing
// is off), so the handler must branch on the exact path or it redirect-loops.
app.get("/docs", (req, res) => {
  if (req.path === "/docs") return res.redirect("/docs/");
  return res.sendFile(path.join(DOCS_DIR, "index.html"));
});

/* --------------------------------------------------------- public routes */
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
// Clean URL for the tester quickstart (the static middleware only serves it
// as /testers.html).
app.get("/testers", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "testers.html")));
// Public live-network page: the app's Network tab, for the open web. Reads
// only the public truncated-address status feed.
app.get("/network", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "network.html")));
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    runtime: runtime.summary(),
    // Store truth from the process itself: which ledger backend actually
    // engaged (a KAI_STORE flip that didn't take shows `degraded` here),
    // plus the node runtime — both needed to operate the git-driven env
    // channel (deploy/app.env) from outside the box.
    store: { mode: scheduler.store?.mode || "json", ...(scheduler.store?.degraded ? { degraded: scheduler.store.degraded } : {}) },
    node: process.version,
  })
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// In-app tester feedback (alpha): one honest box in the desktop app posts
// here. Appended durably; readable in /admin; optionally mailed like
// signups. logTail is the app's event log — no chat content, no keys.
app.post("/api/feedback", async (req, res) => {
  try {
    if (feedbackLimit(req.ip || "unknown")) {
      return res.status(429).json({ ok: false, error: "Too many messages — try again in a few minutes." });
    }
    const b = req.body || {};
    const message = typeof b.message === "string" ? b.message.trim().slice(0, 4000) : "";
    if (!message) return res.status(400).json({ ok: false, error: "Feedback needs a message." });
    const entry = {
      ts: new Date().toISOString(),
      message,
      email: typeof b.email === "string" ? b.email.trim().slice(0, 200) : null,
      appVersion: typeof b.appVersion === "string" ? b.appVersion.slice(0, 40) : null,
      platform: typeof b.platform === "string" ? b.platform.slice(0, 60) : null,
      logTail: typeof b.logTail === "string" ? b.logTail.slice(0, 20000) : null,
    };
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.appendFile(FEEDBACK_FILE, JSON.stringify(entry) + "\n", "utf8");
    if (mailer) {
      mailer
        .sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: process.env.SMTP_TO,
          subject: `KAI feedback: ${message.slice(0, 60)}${message.length > 60 ? "…" : ""}`,
          text: `App feedback\n\nversion:  ${entry.appVersion}\nplatform: ${entry.platform}\nemail:    ${entry.email || "(none)"}\ntime:     ${entry.ts}\n\n${message}\n${entry.logTail ? `\n--- diagnostic log tail ---\n${entry.logTail}\n` : ""}`,
        })
        .catch(() => {});
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("feedback error:", err);
    return res.status(500).json({ ok: false, error: "Server error — please try again." });
  }
});

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

// The login form mirrors the credentials the server actually loaded: if you
// set ADMIN_EMAIL but still see no email field, the app didn't restart.
let LOGIN_PAGE = "";
function loginPage() {
  if (!LOGIN_PAGE) {
    LOGIN_PAGE = fs
      .readFileSync(path.join(VIEWS_DIR, "login.html"), "utf8")
      .replace("__EMAIL_MODE__", ADMIN_EMAIL ? "true" : "false");
  }
  return LOGIN_PAGE;
}

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
      .send(
        HASH_BROKEN
          ? "Admin area is misconfigured: ADMIN_PASSWORD_HASH is malformed and no ADMIN_PASSWORD is set. Delete the hash, set ADMIN_PASSWORD, and restart."
          : "Admin area is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD, then restart the app."
      );
  }
  if (currentSession(req)) return res.sendFile(path.join(VIEWS_DIR, "admin.html"));
  return res.type("html").send(loginPage());
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

  const body = req.body || {};
  const password = typeof body.password === "string" ? body.password : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const okEmail = !ADMIN_EMAIL || (Boolean(email) && auth.verifyPlaintext(email, ADMIN_EMAIL));
  const okPassword =
    Boolean(password) &&
    (USE_HASH ? auth.verifyPassword(password, ADMIN_HASH) : auth.verifyPlaintext(password, ADMIN_PLAIN));

  if (!okEmail || !okPassword) {
    // Log which half failed so the app log can settle it; the response stays
    // deliberately vague so a stranger learns nothing.
    const why = !okEmail ? (email ? "email mismatch" : "email missing") : "password mismatch";
    console.warn(`failed admin login from ${req.ip} (${why})`);
    return res.status(401).json({
      ok: false,
      error: ADMIN_EMAIL ? "Incorrect email or password." : "Incorrect password.",
    });
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

app.get("/admin/api/feedback", requireAuth, async (_req, res, next) => {
  try {
    let entries = [];
    try {
      entries = (await fs.promises.readFile(FEEDBACK_FILE, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { /* none yet */ }
    return res.json({ ok: true, total: entries.length, recent: entries.slice(-100).reverse() });
  } catch (err) {
    return next(err);
  }
});

// Live network shape for the admin dashboard — connected computers and
// which model classes they serve. Will graduate to a public page once the
// numbers are worth bragging about.
app.get("/admin/api/network", requireAuth, (_req, res) => {
  res.json({ ok: true, ...scheduler.statsPublic({ detail: true }) });
});

/*
 * YOUR nodes — the account page's answer to "what is my machine actually
 * doing on the network?"
 *
 * Owner, after linking a wallet: "It would be good if you can see your models
 * and other node details." Until now a linked wallet was an address and a
 * timestamp, and everything the network measured about that machine was
 * visible only in the desktop app on the machine itself — useless the moment
 * you are away from it, which is exactly when you want to check.
 *
 * ZERO new plumbing, because the join is free: the accounts DB and the
 * Scheduler are the same process (see `new Scheduler` and `accounts.router`
 * above), and the address a wallet links with is byte-identical to the one
 * its worker registers with — the desktop signs the link proof with the same
 * wallet the worker uses. So a plain === joins an account row to a worker row.
 *
 * The join runs SERVER-SIDE against untruncated rows and is filtered to the
 * caller's own wallets. That is deliberate: the public /network/status
 * truncates provider addresses on purpose, and the cheap client-side version
 * of this would have had to match on that truncated form — which can collide
 * across two addresses. Showing you your OWN full address on your OWN account
 * page does not breach that policy; shipping the full worker list to a browser
 * would.
 */
app.get("/account/api/nodes", (req, res) => {
  const account = accounts?.requireAccount?.(req, res);
  if (!account) return; // requireAccount already answered 401/403
  let live = [];
  try {
    live = scheduler.statsPublic({ detail: true }).workers || [];
  } catch {
    live = [];
  }
  const wallets = accounts.service.accountView(account).wallets || [];
  const nodes = wallets.map((w) => {
    const on = live.find((x) => x.address === w.address) || null;
    if (on) {
      const cap = on.capabilities || {};
      return {
        address: w.address,
        linkedAt: w.linkedAt,
        online: true,
        busy: on.busy === true,
        lastSeenSecs: on.lastSeenSecs ?? null,
        models: on.models || [],
        ramGb: on.ram ?? null,
        // The booleans DO reach the server; the GPU's name and VRAM never do
        // (the client sends capabilities + rounded RAM and nothing else), so
        // this says whether the machine is accelerated, never which card.
        accelerated: cap.cudaEligible === true || cap.vulkanEligible === true,
        jobsThisEpoch: on.jobsThisEpoch ?? 0,
        perf: on.perf || null,
        reputation: on.reputation || null,
      };
    }
    /*
     * Offline is a real answer, and statsPublic cannot give it — its detail
     * block maps over LIVE workers only, and the `recentOffline` list drops
     * anything older than an hour and truncates the address. The roster
     * itself is persisted and survives restarts, so read it directly: "last
     * seen three days ago" is the single most useful thing to tell someone
     * whose node stopped earning.
     */
    let known = null;
    try {
      for (const x of scheduler.workers.values()) if (x.address === w.address) known = x;
    } catch { /* roster unavailable — fall through to never-seen */ }
    return {
      address: w.address,
      linkedAt: w.linkedAt,
      online: false,
      lastSeenAt: known?.lastSeen ?? null,
      models: known?.models || [],
      ramGb: Number(known?.capabilities?.ramGb) || null,
      accelerated: known ? known.capabilities?.cudaEligible === true || known.capabilities?.vulkanEligible === true : null,
      // Reputation is computed from an address, so it answers even for a
      // machine that is currently off — age and trust do not evaporate
      // because someone closed their laptop.
      reputation: known ? (() => { try { return scheduler._reputation(w.address, Date.now(), known); } catch { return null; } })() : null,
      neverSeen: !known,
    };
  });
  res.json({ ok: true, nodes });
});

/* ------------------------------------------------------- the web app (/app)
 *
 * The browser build of Koinos AI. It lives in views/, NOT public/, and that
 * is the whole security design in one sentence: `express.static(PUBLIC_DIR)`
 * near the bottom of this file serves that entire tree to anyone, so a gated
 * page cannot exist inside it. Putting the shell here means exactly one route
 * can hand it out, and that route asks who you are first.
 *
 * The gate is `accounts.requireAccount` — the same function the account API
 * uses, imported rather than re-derived, because a second hand-rolled copy of
 * a session check is a second place for it to drift wrong. It answers JSON
 * 401 for API callers; a browser asking for a page deserves a door instead,
 * so this route redirects to /account, which is where signing in happens.
 *
 * Nothing here is a substitute for the real boundary. The page can render
 * whatever it likes; it still cannot spend a satoshi without a signed grant
 * the scheduler re-checks on every request (lib/accounts.js spendableGrant).
 * The gate is for coherence, not for containment.
 */
const APP_SHELL = path.join(VIEWS_DIR, "app.html");
const APP_CLIENT = path.join(VIEWS_DIR, "app.js");

// Locked down harder than the marketing site: the shell has no inline script
// (its logic is app.js, loaded same-origin), so script-src can be strict with
// no 'unsafe-inline' escape hatch. Styles stay inline-permitted — one <style>
// block in a single-file shell is not the attack surface scripts are.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function appHeaders(res) {
  res.setHeader("Content-Security-Policy", APP_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  // Never let a signed-in shell sit in a shared cache, or in the back/forward
  // cache of a browser someone has since signed out of.
  res.setHeader("Cache-Control", "no-store, private");
}

app.get("/app", (req, res) => {
  if (!accounts) {
    return res.status(503).type("text/plain").send("Accounts are not configured on this server.");
  }
  // A browser gets a place to go, not a JSON error it cannot read. That is
  // why this asks `accountOf` (resolve, don't answer) instead of the JSON
  // gate. `?next` is a literal this server wrote, never anything from the
  // request, so there is no open-redirect to be had here.
  if (!accounts.accountOf(req)) return res.redirect("/account?next=/app");
  appHeaders(res);
  return res.sendFile(APP_SHELL);
});

/*
 * The client script is served ungated ON PURPOSE. It holds no secrets — it is
 * the same code every visitor would receive — and gating it buys nothing while
 * costing a real failure mode: a page left open past its session would fetch
 * a 401 or an HTML redirect where a script belongs and fail silently, leaving
 * a blank app with no explanation. Served from views/ so it is still exactly
 * one route, with the content type set rather than sniffed.
 */
app.get("/app/app.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-cache");
  return res.sendFile(APP_CLIENT);
});

// Mainnet-readiness: rotating snapshots of the scheduler's ledgers (see
// lib/state-backup.js) plus an offsite pull. The bundle holds worker
// tokens and balances, so it is gated: an admin session, or the operator
// secret for an owner-run cron on any other machine —
//   curl -H "x-operator-secret: $SECRET" https://koinosai.com/admin/api/state-export -o kai-state.json.gz
function timingSafeEq(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  // Length leak is unavoidable via timing; compare into a fixed buffer so
  // the byte comparison itself is constant-time and never throws on length.
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function exportAuth(req, res, next) {
  const secret = process.env.KAI_OPERATOR_SECRET;
  if (secret && timingSafeEq(req.headers["x-operator-secret"], secret)) return next();
  return requireAuth(req, res, next);
}
app.get("/admin/api/state-export", exportAuth, async (req, res, next) => {
  try {
    // Always snapshot on export: an offsite cron must pull CURRENT ledgers,
    // not a rotation file up to KAI_BACKUP_EVERY_MS (6h) stale — that gap is
    // exactly the data that matters after an incident. ?cached=1 opts into
    // the last rotation instead (cheap health poll).
    let p = null;
    if (req.query.cached === "1") p = latestBackupPath(SCHEDULER_DATA);
    if (!p) {
      // In sqlite mode the DB is the authority — refresh the derived JSON
      // views first so the snapshot bundles CURRENT ledgers, not the last
      // epoch-close export.
      try { scheduler.store?.exportViews?.(); } catch { /* best-effort */ }
      await snapshotOnce(SCHEDULER_DATA);
      p = latestBackupPath(SCHEDULER_DATA);
    }
    if (!p) return res.status(404).json({ ok: false, error: "no snapshot yet" });
    res.setHeader("content-type", "application/gzip");
    res.setHeader("content-disposition", `attachment; filename="${path.basename(p)}"`);
    const stream = fs.createReadStream(p);
    // pipe() does not forward source errors and Express can't catch an async
    // 'error' event — without this handler a mid-read failure crashes the
    // whole process (review finding).
    stream.on("error", (e) => {
      if (!res.headersSent) res.status(500).json({ ok: false, error: "snapshot read failed" });
      else res.destroy(e);
    });
    stream.pipe(res);
  } catch (e) {
    return next(e);
  }
});

// §7.4 shadow-data trends: reputation + §17 challenge history over recent
// epochs, plus the flat-vs-gated pool-share preview. The evidence view for
// arming the anti-Sybil gate / shadow tiers. Read-only; same operator-or-admin
// gate as the state export (full addresses appear — never a public surface).
//   curl -H "x-operator-secret: $SECRET" https://koinosai.com/admin/api/shadow-trends?epochs=96
app.get("/admin/api/shadow-trends", exportAuth, (req, res) => {
  const epochs = Math.max(1, Math.min(500, Number(req.query.epochs) || 96));
  return res.json(computeTrends(SCHEDULER_DATA, { maxEpochs: epochs }));
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
