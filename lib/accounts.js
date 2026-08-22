"use strict";

/*
 * Accounts + cross-device auth for koinosai.com (task #49, phase 1 —
 * scheduler side). One person <-> one account <-> N wallets/devices.
 *
 * Sign-in methods, each optional and independently degradable:
 *   - Email code:  6 digits over SMTP. Needs SMTP_HOST (the same transport
 *                  the waitlist notifications already use). Not configured
 *                  -> a clear 503, never a silent no-op.
 *   - Passkey:     WebAuthn on koinosai.com (lib/webauthn.js — no deps, no
 *                  secrets, works today). Registration requires an existing
 *                  session; login is discoverable-credential or by email.
 *   - Google:      OAuth authorization-code, server side. Needs
 *                  GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET. Not configured
 *                  -> 503 with the env NAMES (never values) to set.
 *
 * The desktop app NEVER runs a browser auth flow itself. It uses the
 * device-link flow (RFC 8628 shaped): the app asks for a short code, the
 * person approves it at koinosai.com/link on any signed-in browser, the app
 * polls and receives its own session token. One flow covers all three
 * methods and whatever we add later.
 *
 * Wallets attach with the same proof the scheduler already trusts
 * (§17-style): a base64 secp256k1 signature over
 * sha256(`link|${address}|${accountId}|${ts}`), recovered with koilib and
 * compared to the claimed address. The accountId inside the message means a
 * leaked signature can never link the wallet to someone ELSE's account; the
 * ±5 min ts window kills replays.
 *
 * Secrets at rest: none. Session tokens, email codes and device secrets are
 * stored as sha256 hashes; passkey rows hold public keys.
 *
 * Storage is its own sqlite DB (node:sqlite, WAL) under STATE_ROOT/accounts —
 * NOT the scheduler's store: accounts outlive scheduler experiments and
 * nothing here participates in epoch-close transactions. If sqlite is
 * unavailable the router serves 503 LOUDLY (mirrors the store's posture:
 * never silently degrade an identity system).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Signer } = require("koilib");
const webauthn = require("./webauthn");

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days, sliding
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_SEND_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_SENDS_PER_WINDOW = 3; // per address
const IP_SENDS_PER_HOUR = 10;
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LINK_SIG_WINDOW_MS = 5 * 60 * 1000;
// A grant is a standing authorization, so it gets ceilings a person would
// have chosen anyway: no unbounded caps, no perpetual grants.
const MAX_GRANT_MICRO = 500 * 1e6; // $500
const MAX_GRANT_MS = 365 * 24 * 3600 * 1000; // a year
const ADDR_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = () => Date.now();

class AccountService {
  constructor({ stateDir, sendMail = null, siteOrigin = "https://koinosai.com", google = null, onEvent = () => {} }) {
    this.sendMail = sendMail; // async ({to, subject, text}) or null when SMTP is absent
    this.siteOrigin = siteOrigin.replace(/\/$/, "");
    this.rpId = new URL(this.siteOrigin).hostname;
    this.google = google; // {clientId, clientSecret} or null
    this.onEvent = onEvent;
    this.challenges = new Map(); // id -> {challenge, accountId|null, expiresAt}
    this.oauthStates = new Map(); // state -> expiresAt
    this.ipSends = new Map(); // ip -> {count, windowStart}
    const dir = path.join(stateDir, "accounts");
    fs.mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(path.join(dir, "accounts.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT UNIQUE, google_sub TEXT UNIQUE,
        created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, label TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS passkeys (
        cred_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, alg INTEGER NOT NULL,
        jwk TEXT NOT NULL, sign_count INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wallets (
        address TEXT PRIMARY KEY, account_id TEXT NOT NULL, label TEXT, linked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS email_codes (
        email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, sends INTEGER NOT NULL DEFAULT 1, window_start INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_codes (
        user_code TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, account_id TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spend_grants (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, address TEXT NOT NULL,
        max_micro INTEGER NOT NULL, spent_micro INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_grants_account ON spend_grants(account_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
      CREATE INDEX IF NOT EXISTS idx_passkeys_account ON passkeys(account_id);
      CREATE INDEX IF NOT EXISTS idx_wallets_account ON wallets(account_id);
    `);
  }

  /* ------------------------------------------------------------ accounts */
  _newAccount({ email = null, googleSub = null }) {
    const id = "acc_" + crypto.randomBytes(8).toString("hex");
    const t = now();
    this.db.prepare("INSERT INTO accounts (id, email, google_sub, created_at, last_seen_at) VALUES (?,?,?,?,?)")
      .run(id, email, googleSub, t, t);
    this.onEvent({ type: "account:created", id, via: googleSub ? "google" : "email" });
    return this.getAccount(id);
  }

  getAccount(id) {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) || null;
  }

  _accountByEmail(email) {
    return this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) || null;
  }

  /* ------------------------------------------------------------ sessions */
  _issueSession(accountId, label) {
    const token = "sk_" + crypto.randomBytes(32).toString("base64url");
    const t = now();
    this.db.prepare("INSERT INTO sessions (token_hash, account_id, label, created_at, expires_at, last_used_at) VALUES (?,?,?,?,?,?)")
      .run(sha256hex(token), accountId, label || null, t, t + SESSION_TTL_MS, t);
    this.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ?").run(t, accountId);
    return token;
  }

  /** Token -> account row, sliding the expiry. Null on miss/expiry. */
  sessionAccount(token) {
    if (!token || !token.startsWith("sk_")) return null;
    const h = sha256hex(token);
    const s = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(h);
    if (!s) return null;
    const t = now();
    if (Number(s.expires_at) < t) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(h);
      return null;
    }
    this.db.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?")
      .run(t, t + SESSION_TTL_MS, h);
    return this.getAccount(s.account_id);
  }

  revokeSession(token) {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256hex(token));
  }

  /* ---------------------------------------------------------- email code */
  async startEmailCode(email, ip) {
    if (!this.sendMail) {
      const err = new Error("email sign-in is not configured on this server (SMTP_HOST unset)");
      err.status = 503;
      throw err;
    }
    email = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      const err = new Error("that does not look like an email address");
      err.status = 400;
      throw err;
    }
    const t = now();
    // Per-IP window (in-memory: resets on restart, which only ever loosens).
    const ipRow = this.ipSends.get(ip) || { count: 0, windowStart: t };
    if (t - ipRow.windowStart > 3600 * 1000) { ipRow.count = 0; ipRow.windowStart = t; }
    if (ipRow.count >= IP_SENDS_PER_HOUR) {
      const err = new Error("too many sign-in emails from this network — try again later");
      err.status = 429;
      throw err;
    }
    // Per-address window (durable).
    const prev = this.db.prepare("SELECT * FROM email_codes WHERE email = ?").get(email);
    let sends = 1;
    let windowStart = t;
    if (prev && t - Number(prev.window_start) < EMAIL_SEND_WINDOW_MS) {
      if (Number(prev.sends) >= EMAIL_SENDS_PER_WINDOW) {
        const err = new Error("too many sign-in emails for this address — try again in a few minutes");
        err.status = 429;
        throw err;
      }
      sends = Number(prev.sends) + 1;
      windowStart = Number(prev.window_start);
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    this.db.prepare(`
      INSERT INTO email_codes (email, code_hash, expires_at, attempts, sends, window_start)
      VALUES (?,?,?,0,?,?)
      ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at,
        attempts=0, sends=excluded.sends, window_start=excluded.window_start
    `).run(email, sha256hex(`${email}|${code}`), t + EMAIL_CODE_TTL_MS, sends, windowStart);
    ipRow.count += 1;
    this.ipSends.set(ip, ipRow);
    await this.sendMail({
      to: email,
      subject: `${code} is your Koinos AI sign-in code`,
      text: `Your Koinos AI sign-in code is: ${code}\n\nIt expires in 10 minutes. If you didn't request it, ignore this email.`,
    });
    this.onEvent({ type: "auth:email-code-sent", email });
  }

  verifyEmailCode(email, code) {
    email = String(email || "").trim().toLowerCase();
    const row = this.db.prepare("SELECT * FROM email_codes WHERE email = ?").get(email);
    const fail = (msg) => { const e = new Error(msg); e.status = 401; return e; };
    if (!row || Number(row.expires_at) < now()) throw fail("code expired — request a new one");
    if (Number(row.attempts) >= EMAIL_CODE_MAX_ATTEMPTS) throw fail("too many wrong codes — request a new one");
    const ok = crypto.timingSafeEqual(
      Buffer.from(row.code_hash, "hex"),
      Buffer.from(sha256hex(`${email}|${String(code || "").trim()}`), "hex")
    );
    if (!ok) {
      this.db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?").run(email);
      throw fail("wrong code");
    }
    this.db.prepare("DELETE FROM email_codes WHERE email = ?").run(email);
    const account = this._accountByEmail(email) || this._newAccount({ email });
    return account;
  }

  /* -------------------------------------------------------- device link */
  startDeviceLink() {
    // 8 chars from an unambiguous alphabet (no 0/O/1/I), shown to a human.
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let raw = "";
    for (const b of crypto.randomBytes(8)) raw += alphabet[b % alphabet.length];
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const secret = "ds_" + crypto.randomBytes(24).toString("base64url");
    const t = now();
    this.db.prepare("DELETE FROM device_codes WHERE expires_at < ?").run(t);
    this.db.prepare("INSERT INTO device_codes (user_code, secret_hash, account_id, created_at, expires_at) VALUES (?,?,NULL,?,?)")
      .run(userCode, sha256hex(secret), t, t + DEVICE_CODE_TTL_MS);
    return { userCode, deviceSecret: secret, verifyUrl: `${this.siteOrigin}/link`, expiresInSec: DEVICE_CODE_TTL_MS / 1000, pollSec: 3 };
  }

  approveDeviceLink(userCode, accountId) {
    const r = this.db.prepare("UPDATE device_codes SET account_id = ? WHERE user_code = ? AND expires_at > ? AND account_id IS NULL")
      .run(accountId, String(userCode || "").trim().toUpperCase(), now());
    if (!r.changes) {
      const e = new Error("that code is unknown, expired, or already used");
      e.status = 404;
      throw e;
    }
    this.onEvent({ type: "auth:device-approved", accountId });
  }

  /** Poll from the device. Consumes the code when approved (single use). */
  pollDeviceLink(userCode, deviceSecret) {
    const row = this.db.prepare("SELECT * FROM device_codes WHERE user_code = ?").get(String(userCode || "").trim().toUpperCase());
    const fail = (msg, status = 404) => { const e = new Error(msg); e.status = status; return e; };
    if (!row || Number(row.expires_at) < now()) throw fail("code expired — start again");
    const ok = crypto.timingSafeEqual(
      Buffer.from(row.secret_hash, "hex"),
      Buffer.from(sha256hex(String(deviceSecret || "")), "hex")
    );
    if (!ok) throw fail("device secret does not match this code", 401);
    if (!row.account_id) return null; // still pending
    this.db.prepare("DELETE FROM device_codes WHERE user_code = ?").run(row.user_code);
    const token = this._issueSession(row.account_id, "app device link");
    return { token, account: this.getAccount(row.account_id) };
  }

  /* ------------------------------------------------------------ passkeys */
  _newChallenge(accountId) {
    const id = crypto.randomBytes(16).toString("base64url");
    const challenge = crypto.randomBytes(32);
    for (const [k, v] of this.challenges) if (v.expiresAt < now()) this.challenges.delete(k);
    this.challenges.set(id, { challenge, accountId: accountId || null, expiresAt: now() + CHALLENGE_TTL_MS });
    return { id, challenge };
  }

  _takeChallenge(id) {
    const c = this.challenges.get(id);
    this.challenges.delete(id);
    if (!c || c.expiresAt < now()) {
      const e = new Error("challenge expired — try again");
      e.status = 400;
      throw e;
    }
    return c;
  }

  passkeyRegisterOptions(account) {
    const { id, challenge } = this._newChallenge(account.id);
    return {
      challengeId: id,
      publicKey: {
        rp: { id: this.rpId, name: "Koinos AI" },
        user: {
          id: Buffer.from(account.id).toString("base64url"),
          name: account.email || account.id,
          displayName: account.email || "Koinos AI account",
        },
        challenge: challenge.toString("base64url"),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        excludeCredentials: this.db.prepare("SELECT cred_id FROM passkeys WHERE account_id = ?").all(account.id)
          .map((r) => ({ type: "public-key", id: r.cred_id })),
        timeout: 120000,
        attestation: "none",
      },
    };
  }

  passkeyRegisterVerify(account, { challengeId, attestationObject, clientDataJSON, label }) {
    const { challenge } = this._takeChallenge(challengeId);
    const reg = webauthn.verifyRegistration({
      attestationObject: Buffer.from(String(attestationObject), "base64url"),
      clientDataJSON: Buffer.from(String(clientDataJSON), "base64url"),
      challenge,
      origin: this.siteOrigin,
      rpId: this.rpId,
    });
    const credId = reg.credentialId.toString("base64url");
    this.db.prepare("INSERT INTO passkeys (cred_id, account_id, alg, jwk, sign_count, label, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(credId, account.id, reg.alg, JSON.stringify(reg.jwk), reg.signCount, String(label || "").slice(0, 60) || null, now());
    this.onEvent({ type: "auth:passkey-registered", account: account.id });
    return { credId };
  }

  passkeyLoginOptions(email) {
    const { id, challenge } = this._newChallenge(null);
    let allow = [];
    if (email) {
      const acc = this._accountByEmail(String(email).trim().toLowerCase());
      if (acc) {
        allow = this.db.prepare("SELECT cred_id FROM passkeys WHERE account_id = ?").all(acc.id)
          .map((r) => ({ type: "public-key", id: r.cred_id }));
      }
    }
    return {
      challengeId: id,
      publicKey: {
        rpId: this.rpId,
        challenge: challenge.toString("base64url"),
        allowCredentials: allow, // empty -> discoverable credential
        userVerification: "preferred",
        timeout: 120000,
      },
    };
  }

  passkeyLoginVerify({ challengeId, credentialId, authenticatorData, clientDataJSON, signature }) {
    const { challenge } = this._takeChallenge(challengeId);
    const row = this.db.prepare("SELECT * FROM passkeys WHERE cred_id = ?").get(String(credentialId));
    if (!row) {
      const e = new Error("unknown passkey");
      e.status = 401;
      throw e;
    }
    const res = webauthn.verifyAssertion({
      authenticatorData: Buffer.from(String(authenticatorData), "base64url"),
      clientDataJSON: Buffer.from(String(clientDataJSON), "base64url"),
      signature: Buffer.from(String(signature), "base64url"),
      challenge,
      origin: this.siteOrigin,
      rpId: this.rpId,
      jwk: JSON.parse(row.jwk),
      alg: row.alg,
    });
    // Sign-count regression = possible cloned authenticator. Log, don't block:
    // many platform passkeys legitimately report 0 forever.
    if (Number(row.sign_count) > 0 && res.signCount > 0 && res.signCount <= Number(row.sign_count)) {
      this.onEvent({ type: "auth:passkey-signcount-regressed", cred: row.cred_id });
    }
    this.db.prepare("UPDATE passkeys SET sign_count = ? WHERE cred_id = ?").run(res.signCount, row.cred_id);
    return this.getAccount(row.account_id);
  }

  /* -------------------------------------------------------------- google */
  googleAuthUrl(state) {
    this.oauthStates.set(state, now() + CHALLENGE_TTL_MS);
    const q = new URLSearchParams({
      client_id: this.google.clientId,
      redirect_uri: `${this.siteOrigin}/auth/google/callback`,
      response_type: "code",
      scope: "openid email",
      state,
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  async googleCallback(code, state) {
    const exp = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    if (!exp || exp < now()) {
      const e = new Error("sign-in state expired — start again");
      e.status = 400;
      throw e;
    }
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.google.clientId,
        client_secret: this.google.clientSecret,
        redirect_uri: `${this.siteOrigin}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!resp.ok) throw new Error(`google token exchange failed (${resp.status})`);
    const tok = await resp.json();
    // The id_token came straight from Google's token endpoint over TLS, so
    // its signature is redundant here (RFC 6749 §10.12 posture); the claims
    // still get checked.
    const claims = JSON.parse(Buffer.from(String(tok.id_token).split(".")[1], "base64url").toString("utf8"));
    if (claims.aud !== this.google.clientId) throw new Error("google token audience mismatch");
    if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("google token issuer mismatch");
    if (Number(claims.exp) * 1000 < now()) throw new Error("google token expired");
    const sub = String(claims.sub);
    const email = claims.email_verified ? String(claims.email || "").toLowerCase() : null;
    let account = this.db.prepare("SELECT * FROM accounts WHERE google_sub = ?").get(sub) || null;
    if (!account && email) {
      // Same verified email = same person: attach Google to the existing
      // email account instead of splitting their identity in two.
      account = this._accountByEmail(email);
      if (account) this.db.prepare("UPDATE accounts SET google_sub = ? WHERE id = ?").run(sub, account.id);
    }
    if (!account) account = this._newAccount({ email, googleSub: sub });
    return account;
  }

  /* -------------------------------------------------------------- wallets */
  linkWallet(account, { address, ts, signature }) {
    const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
    if (!ADDR_RE.test(String(address || ""))) throw fail("that is not a Koinos address");
    if (Math.abs(now() - Number(ts)) > LINK_SIG_WINDOW_MS) throw fail("stale link signature — check this machine's clock");
    const hash = crypto.createHash("sha256").update(`link|${address}|${account.id}|${ts}`).digest();
    let signer;
    try {
      signer = Signer.recoverAddress(hash, Buffer.from(String(signature), "base64"));
    } catch {
      throw fail("bad link signature");
    }
    if (signer !== address) throw fail("link signature does not match the wallet address");
    const existing = this.db.prepare("SELECT account_id FROM wallets WHERE address = ?").get(address);
    if (existing && existing.account_id !== account.id) {
      throw fail("this wallet is linked to another account — unlink it there first", 409);
    }
    this.db.prepare("INSERT INTO wallets (address, account_id, label, linked_at) VALUES (?,?,NULL,?) ON CONFLICT(address) DO NOTHING")
      .run(address, account.id, now());
    this.onEvent({ type: "account:wallet-linked", account: account.id, address });
  }

  /* ------------------------------------------------------- spend grants */
  /*
   * A SPEND GRANT is not a link. Linking proves you own a wallet ONCE;
   * granting says "this website may draw on it, up to this much, until this
   * date." Those are different questions and the existing `wallets` row
   * answers only the first — it carries no scope, no cap and no expiry, so
   * treating "linked" as "authorized to spend" would be inventing consent
   * nobody gave.
   *
   * Same cryptographic primitive as linkWallet, deliberately: a signature the
   * wallet itself produces, over a message that names the account, so a
   * captured signature cannot be replayed onto someone else's account. The
   * DIFFERENT verb in the message is what stops a link proof from ever being
   * accepted as a spend proof, and vice versa.
   *
   * The cap and the expiry are the point. This is the seam that lets the key
   * live anywhere later — a browser wallet, a desktop keystore, or an
   * account-generated wallet — without the spend path changing.
   */
  grantSpend(account, { address, maxMicro, expiresAt, ts, signature }) {
    const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
    if (!ADDR_RE.test(String(address || ""))) throw fail("that is not a Koinos address");
    const linked = this.db.prepare("SELECT account_id FROM wallets WHERE address = ?").get(address);
    if (!linked || linked.account_id !== account.id) throw fail("link this wallet to your account first", 409);

    const cap = Math.floor(Number(maxMicro));
    if (!Number.isFinite(cap) || cap <= 0) throw fail("give a spending cap above zero");
    if (cap > MAX_GRANT_MICRO) throw fail(`spending cap is too high (max $${MAX_GRANT_MICRO / 1e6})`);
    const exp = Math.floor(Number(expiresAt));
    if (!Number.isFinite(exp) || exp <= now()) throw fail("the expiry must be in the future");
    if (exp > now() + MAX_GRANT_MS) throw fail("that expiry is too far out — grant a shorter window");
    if (Math.abs(now() - Number(ts)) > LINK_SIG_WINDOW_MS) throw fail("stale grant signature — check this machine's clock");

    // The signed message pins EVERY term. Changing the cap or the expiry
    // after the fact would need a new signature, which is the whole idea.
    const hash = crypto.createHash("sha256").update(`spend|${address}|${account.id}|${cap}|${exp}|${ts}`).digest();
    let signer;
    try {
      signer = Signer.recoverAddress(hash, Buffer.from(String(signature), "base64"));
    } catch {
      throw fail("bad grant signature");
    }
    if (signer !== address) throw fail("grant signature does not match the wallet address");

    // One live grant per wallet: a second grant REPLACES the first rather
    // than stacking, so "how much can this site spend?" always has one answer.
    this.db.prepare("UPDATE spend_grants SET revoked_at = ? WHERE address = ? AND revoked_at IS NULL")
      .run(now(), address);
    const id = "grant_" + crypto.randomBytes(8).toString("hex");
    this.db.prepare("INSERT INTO spend_grants (id, account_id, address, max_micro, spent_micro, created_at, expires_at, revoked_at) VALUES (?,?,?,?,0,?,?,NULL)")
      .run(id, account.id, address, cap, now(), exp);
    this.onEvent({ type: "account:spend-granted", account: account.id, address, maxMicro: cap, expiresAt: exp });
    return this.grantView(this.db.prepare("SELECT * FROM spend_grants WHERE id = ?").get(id));
  }

  revokeGrant(account, grantId) {
    const r = this.db.prepare("UPDATE spend_grants SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
      .run(now(), String(grantId || ""), account.id);
    if (!r.changes) throw Object.assign(new Error("no live grant with that id"), { status: 404 });
    this.onEvent({ type: "account:spend-revoked", account: account.id, grant: grantId });
  }

  grantView(g) {
    if (!g) return null;
    const live = !g.revoked_at && Number(g.expires_at) > now() && Number(g.spent_micro) < Number(g.max_micro);
    return {
      id: g.id,
      address: g.address,
      maxUsd: Number(g.max_micro) / 1e6,
      spentUsd: Number(g.spent_micro) / 1e6,
      remainingUsd: Math.max(0, Number(g.max_micro) - Number(g.spent_micro)) / 1e6,
      createdAt: Number(g.created_at),
      expiresAt: Number(g.expires_at),
      revokedAt: g.revoked_at ? Number(g.revoked_at) : null,
      live,
    };
  }

  grants(account) {
    return this.db.prepare("SELECT * FROM spend_grants WHERE account_id = ? ORDER BY created_at DESC").all(account.id)
      .map((g) => this.grantView(g));
  }

  /**
   * Resolve a grant for SPENDING. Returns {grantId, address, remainingMicro}
   * or throws — never returns a half-answer a caller might read as success.
   * Every liveness rule is re-checked here rather than trusted from a cached
   * view, because this is the function money actually flows through.
   */
  spendableGrant(accountId, grantId) {
    const fail = (msg, status = 403) => { const e = new Error(msg); e.status = status; return e; };
    const g = this.db.prepare("SELECT * FROM spend_grants WHERE id = ? AND account_id = ?").get(String(grantId || ""), String(accountId || ""));
    if (!g) throw fail("no such spending grant for this account", 404);
    if (g.revoked_at) throw fail("that spending grant was revoked");
    if (Number(g.expires_at) <= now()) throw fail("that spending grant has expired");
    const remaining = Number(g.max_micro) - Number(g.spent_micro);
    if (remaining <= 0) throw fail("that spending grant is used up");
    return { grantId: g.id, address: g.address, remainingMicro: remaining };
  }

  /** Book spend against a grant. Returns the new spent total.
   *  Guarded in SQL so two concurrent requests cannot both pass the cap. */
  chargeGrant(grantId, micro) {
    const amt = Math.max(0, Math.floor(Number(micro) || 0));
    if (!amt) return;
    const r = this.db.prepare(
      "UPDATE spend_grants SET spent_micro = spent_micro + ? WHERE id = ? AND revoked_at IS NULL AND spent_micro + ? <= max_micro"
    ).run(amt, String(grantId), amt);
    if (!r.changes) {
      // The cap is a real boundary: refuse rather than quietly overshoot.
      throw Object.assign(new Error("this would exceed the spending grant's cap"), { status: 402 });
    }
  }

  unlinkWallet(account, address) {
    // Revoke first: a wallet that is no longer linked must not keep a live
    // spending grant behind it. Order matters — do this before the delete, so
    // a failure leaves the grant revoked rather than orphaned-but-spendable.
    this.db.prepare("UPDATE spend_grants SET revoked_at = ? WHERE address = ? AND account_id = ? AND revoked_at IS NULL")
      .run(now(), String(address || ""), account.id);
    const r = this.db.prepare("DELETE FROM wallets WHERE address = ? AND account_id = ?").run(String(address || ""), account.id);
    if (!r.changes) {
      const e = new Error("that wallet is not linked to this account");
      e.status = 404;
      throw e;
    }
  }

  accountView(account) {
    return {
      id: account.id,
      email: account.email,
      google: Boolean(account.google_sub),
      createdAt: Number(account.created_at),
      wallets: this.db.prepare("SELECT address, linked_at FROM wallets WHERE account_id = ? ORDER BY linked_at").all(account.id)
        .map((w) => ({ address: w.address, linkedAt: Number(w.linked_at) })),
      passkeys: this.db.prepare("SELECT label, created_at FROM passkeys WHERE account_id = ? ORDER BY created_at").all(account.id)
        .map((p) => ({ label: p.label, createdAt: Number(p.created_at) })),
      sessions: this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND expires_at > ?").get(account.id, now()).n,
    };
  }
}

/* ------------------------------------------------------------ the router */

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAccounts(opts) {
  const svc = new AccountService(opts);
  const router = express.Router();
  const COOKIE = "kai_session";
  const secure = svc.siteOrigin.startsWith("https:");

  const setCookie = (res, token) => {
    res.setHeader("Set-Cookie",
      `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`);
  };
  const clearCookie = (res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
  };
  const tokenOf = (req) => {
    const bearer = String(req.headers.authorization || "");
    if (bearer.startsWith("Bearer ")) return bearer.slice(7).trim();
    return parseCookies(req)[COOKIE] || null;
  };
  /** Cookie auth is browser-ambient, so mutating cookie-authed requests must
   *  come from our own pages: any Origin/Referer present has to match. Bearer
   *  requests (the app) skip this — a token can't be sent cross-site. */
  const crossSite = (req) => {
    if (String(req.headers.authorization || "").startsWith("Bearer ")) return false;
    const src = req.headers.origin || req.headers.referer;
    if (!src) return false; // same-origin fetch may omit both; SameSite=Lax already bounds us
    try {
      return new URL(src).origin !== svc.siteOrigin;
    } catch {
      return true;
    }
  };
  const requireAccount = (req, res) => {
    if (req.method !== "GET" && crossSite(req)) {
      res.status(403).json({ ok: false, error: "cross-site request refused" });
      return null;
    }
    const account = svc.sessionAccount(tokenOf(req));
    if (!account) {
      res.status(401).json({ ok: false, error: "sign in first" });
      return null;
    }
    return account;
  };
  const boom = (res, e) => res.status(e.status || 500).json({ ok: false, error: String(e.message) });

  /* ---- email ---- */
  router.post("/auth/email/start", async (req, res) => {
    try {
      await svc.startEmailCode(req.body?.email, req.ip);
      res.json({ ok: true });
    } catch (e) { boom(res, e); }
  });
  router.post("/auth/email/verify", (req, res) => {
    try {
      const account = svc.verifyEmailCode(req.body?.email, req.body?.code);
      const token = svc._issueSession(account.id, "web (email)");
      setCookie(res, token);
      res.json({ ok: true, token, account: svc.accountView(account) });
    } catch (e) { boom(res, e); }
  });

  /* ---- session ---- */
  /*
   * What can someone actually sign in WITH, right now.
   *
   * Without this the page offered all three doors unconditionally and Google
   * answered 503 on click — the owner's question ("what do I need to do to get
   * account creation working?") is one nobody should have to ask a person.
   * The server knows; it should say so.
   *
   * Booleans only. Never the client id, never the SMTP host — which method is
   * configured is not a secret, but nothing about HOW is anyone's business.
   *
   * `signup` is deliberately separate from `signin`: a passkey CANNOT create
   * an account (registration needs a session to attach the key to), so it is
   * a way back IN, never a way to start. Listing it as a signup method is the
   * misreading this field exists to prevent.
   */
  router.get("/auth/methods", (_req, res) => {
    const email = Boolean(svc.sendMail);
    const google = Boolean(svc.google);
    res.json({
      ok: true,
      signin: { email, google, passkey: true },
      signup: { email, google, passkey: false },
      canCreateAccount: email || google,
      // Names, never values — the same contract as every 503 in this file.
      missing: [...(email ? [] : ["SMTP_HOST"]), ...(google ? [] : ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])],
    });
  });

  router.get("/auth/session", (req, res) => {
    const account = svc.sessionAccount(tokenOf(req));
    if (!account) return res.status(401).json({ ok: false });
    res.json({ ok: true, account: svc.accountView(account) });
  });
  router.post("/auth/logout", (req, res) => {
    svc.revokeSession(tokenOf(req));
    clearCookie(res);
    res.json({ ok: true });
  });

  /* ---- passkeys ---- */
  router.post("/auth/passkey/register/options", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json({ ok: true, ...svc.passkeyRegisterOptions(account) });
  });
  router.post("/auth/passkey/register/verify", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    try {
      res.json({ ok: true, ...svc.passkeyRegisterVerify(account, req.body || {}) });
    } catch (e) { boom(res, e); }
  });
  router.post("/auth/passkey/login/options", (req, res) => {
    res.json({ ok: true, ...svc.passkeyLoginOptions(req.body?.email) });
  });
  router.post("/auth/passkey/login/verify", (req, res) => {
    try {
      const account = svc.passkeyLoginVerify(req.body || {});
      const token = svc._issueSession(account.id, "web (passkey)");
      setCookie(res, token);
      res.json({ ok: true, token, account: svc.accountView(account) });
    } catch (e) { boom(res, e); }
  });

  /* ---- google ---- */
  router.get("/auth/google", (req, res) => {
    if (!svc.google) {
      return res.status(503).json({ ok: false, error: "Google sign-in is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)" });
    }
    res.redirect(svc.googleAuthUrl(crypto.randomBytes(16).toString("base64url")));
  });
  router.get("/auth/google/callback", async (req, res) => {
    if (!svc.google) return res.status(503).send("Google sign-in is not configured");
    try {
      const account = await svc.googleCallback(String(req.query.code || ""), String(req.query.state || ""));
      setCookie(res, svc._issueSession(account.id, "web (google)"));
      res.redirect("/account");
    } catch (e) {
      res.status(e.status || 502).send(`Sign-in failed: ${e.message}`);
    }
  });

  /* ---- spend grants ---- */
  router.post("/account/grants", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    try {
      res.json({ ok: true, grant: svc.grantSpend(account, req.body || {}), account: svc.accountView(account) });
    } catch (e) { boom(res, e); }
  });
  router.delete("/account/grants/:id", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    try {
      svc.revokeGrant(account, req.params.id);
      res.json({ ok: true, account: svc.accountView(account) });
    } catch (e) { boom(res, e); }
  });

  /* ---- device link (the desktop app's door) ---- */
  router.post("/auth/device/start", (req, res) => {
    res.json({ ok: true, ...svc.startDeviceLink() });
  });
  router.post("/auth/device/approve", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    try {
      svc.approveDeviceLink(req.body?.userCode, account.id);
      res.json({ ok: true });
    } catch (e) { boom(res, e); }
  });
  router.post("/auth/device/poll", (req, res) => {
    try {
      const r = svc.pollDeviceLink(req.body?.userCode, req.body?.deviceSecret);
      if (!r) return res.json({ ok: true, pending: true });
      res.json({ ok: true, pending: false, token: r.token, account: svc.accountView(r.account) });
    } catch (e) { boom(res, e); }
  });

  /* ---- account + wallets ---- */
  router.get("/account/api", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json({ ok: true, account: svc.accountView(account) });
  });
  router.post("/account/wallets", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    try {
      svc.linkWallet(account, req.body || {});
      res.json({ ok: true, account: svc.accountView(account) });
    } catch (e) { boom(res, e); }
  });
  router.delete("/account/wallets/:address", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    try {
      svc.unlinkWallet(account, req.params.address);
      res.json({ ok: true, account: svc.accountView(account) });
    } catch (e) { boom(res, e); }
  });

  /*
   * `requireAccount` is exported, not just used internally, so anything else
   * in this process gates on the SAME function rather than a lookalike. A
   * hand-rolled second gate is one `crossSite` check away from being a CSRF
   * hole, and the one above is easy to forget because it only fires on
   * non-GET.
   */
  return { router, service: svc, requireAccount };
}

module.exports = { createAccounts, AccountService };
