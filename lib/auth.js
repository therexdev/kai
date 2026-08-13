"use strict";

/*
 * Admin authentication primitives — Node's built-in crypto only, no deps.
 *
 * Passwords: scrypt with a per-password random salt, stored as a single
 * self-describing string so parameters can change without breaking old hashes.
 * Sessions: stateless HMAC-signed tokens, so a restart doesn't log you out
 * (as long as SESSION_SECRET is set) and there's no session store to leak.
 */

const crypto = require("crypto");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
// scrypt needs ~128 * N * r bytes; give it headroom over the 32MB default.
const MAXMEM = 64 * 1024 * 1024;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (!N || !r || !p || !salt.length || !expected.length) return false;
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Constant-time compare for the plaintext-password fallback. */
function verifyPlaintext(password, expected) {
  const a = Buffer.from(String(password));
  const b = Buffer.from(String(expected));
  // Compare a fixed-length digest so differing lengths don't throw or leak length.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function randomSecret() {
  return crypto.randomBytes(32).toString("base64");
}

function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(token, secret) {
  if (typeof token !== "string" || token.indexOf(".") < 0) return null;
  const idx = token.lastIndexOf(".");
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Minimal cookie header parser — avoids pulling in cookie-parser. */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || out[k] !== undefined) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyPlaintext,
  randomSecret,
  signSession,
  verifySession,
  parseCookies,
};
