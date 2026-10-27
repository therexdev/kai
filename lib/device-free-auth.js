"use strict";
// A non-spending installation identity. It is never an ordinary account or a
// wallet session, and its key cannot authorize KOIN, purchases or provider work.
const crypto = require("node:crypto"), { utils } = require("koilib");
const CHALLENGE_TTL_MS = 300000, SESSION_TTL_MS = 86400000, HEX = /^[a-f0-9]{64}$/;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message, status = 400) => Object.assign(Error(message), { status });
function targetValue(value) {
  if (!value || Object.keys(value).sort().join() !== "chainId,credits,creditsHash,domain,policyHash" ||
      typeof value.chainId !== "string" || !value.chainId || value.chainId.length > 100 || !utils.isChecksumAddress(value.credits) ||
      !/^0x1220[a-f0-9]{64}$/.test(value.creditsHash) || typeof value.domain !== "string" || !value.domain || value.domain.length > 300 || !HEX.test(value.policyHash)) throw fail("Invalid free-device deployment");
  return { chainId: value.chainId, credits: value.credits, creditsHash: value.creditsHash, domain: value.domain, policyHash: value.policyHash };
}
function serviceUrl(value, originOnly = false) {
  const u = new URL(value);
  if ((u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname))) || u.username || u.password || u.search || u.hash || (originOnly && u.pathname !== "/")) throw fail("Invalid free-device service");
  return originOnly ? u.origin : u.href.replace(/\/$/, "");
}
function publicKey(value) {
  if (typeof value !== "string" || value.length !== 60) throw fail("Canonical Ed25519 public key required");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 44 || bytes.toString("base64") !== value || bytes.subarray(0, 12).toString("hex") !== "302a300506032b6570032100") throw fail("Canonical Ed25519 public key required");
  const key = crypto.createPublicKey({ key: bytes, type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") throw fail("Ed25519 public key required");
  return key;
}
function challengeHash(c) {
  if (!c || Object.keys(c).sort().join() !== "expiresAt,issuedAt,nonce,publicKey,purpose,schedulerUrl,schema,serviceOrigin,sessionExpiresAt,target" ||
      c.schema !== 1 || c.purpose !== "device-free-session" || !HEX.test(c.nonce) || !Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0 ||
      c.expiresAt !== c.issuedAt + CHALLENGE_TTL_MS || c.sessionExpiresAt !== c.issuedAt + SESSION_TTL_MS) throw fail("Invalid free-device challenge");
  publicKey(c.publicKey); const t = targetValue(c.target);
  if (serviceUrl(c.serviceOrigin, true) !== c.serviceOrigin || serviceUrl(c.schedulerUrl) !== c.schedulerUrl || new URL(c.schedulerUrl).origin !== c.serviceOrigin) throw fail("Free-device origin mismatch");
  return Buffer.from(digest(JSON.stringify(["KAI-DEVICE-FREE-SESSION-V1", c.schema, c.purpose, c.serviceOrigin, c.schedulerUrl,
    t.chainId, t.credits, t.creditsHash, t.domain, t.policyHash, c.publicKey, c.nonce, c.issuedAt, c.expiresAt, c.sessionExpiresAt])), "hex");
}
class DeviceFreeAuth {
  constructor({ accounts, target, schedulerUrl, clock = Date.now }) {
    this.db = accounts.db; this.clock = clock; this.serviceOrigin = serviceUrl(accounts.siteOrigin, true); this.schedulerUrl = serviceUrl(schedulerUrl);
    if (new URL(this.schedulerUrl).origin !== this.serviceOrigin) throw fail("Free-device service origin mismatch");
    this.target = Object.freeze(targetValue(target)); this.targetHash = digest(JSON.stringify([this.serviceOrigin, this.schedulerUrl, this.target]));
    this.db.exec(`CREATE TABLE IF NOT EXISTS device_free_challenges(nonce TEXT PRIMARY KEY,public_key TEXT NOT NULL,origin_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_device_free_challenge_key ON device_free_challenges(public_key);
      CREATE INDEX IF NOT EXISTS idx_device_free_challenge_origin ON device_free_challenges(origin_hash);
      CREATE TABLE IF NOT EXISTS device_free_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,public_key TEXT NOT NULL,target_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_device_free_session_key ON device_free_sessions(public_key,target_hash);`);
  }
  capabilities() { return { deviceFreeCredits: 1, scope: "device-free", freeOnly: true, algorithm: "Ed25519", serviceOrigin: this.serviceOrigin,
    schedulerUrl: this.schedulerUrl, target: { ...this.target }, challengeTtlMs: CHALLENGE_TTL_MS, sessionTtlMs: SESSION_TTL_MS }; }
  identity(key) { publicKey(key); return "guest_" + digest(JSON.stringify(["KAI-DEVICE-FREE-IDENTITY-V1", this.targetHash, key])); }
  challenge(input, remoteAddress = "unknown") {
    if (!input || Object.keys(input).join() !== "publicKey") throw fail("Exact free-device public key required");
    publicKey(input.publicKey);
    const now = this.clock(), origin = digest(String(remoteAddress).slice(0, 100));
    this.db.prepare("DELETE FROM device_free_challenges WHERE expires_at<=?").run(now);
    if (this.db.prepare("SELECT COUNT(*) AS n FROM device_free_challenges").get().n >= 10000 ||
        this.db.prepare("SELECT COUNT(*) AS n FROM device_free_challenges WHERE public_key=?").get(input.publicKey).n >= 10 ||
        this.db.prepare("SELECT COUNT(*) AS n FROM device_free_challenges WHERE origin_hash=?").get(origin).n >= 60) throw fail("Free connection is busy. Try again shortly.", 429);
    const challenge = { schema: 1, purpose: "device-free-session", serviceOrigin: this.serviceOrigin, schedulerUrl: this.schedulerUrl, target: { ...this.target },
      publicKey: input.publicKey, nonce: crypto.randomBytes(32).toString("hex"), issuedAt: now, expiresAt: now + CHALLENGE_TTL_MS, sessionExpiresAt: now + SESSION_TTL_MS };
    challengeHash(challenge);
    this.db.prepare("INSERT INTO device_free_challenges VALUES(?,?,?,?,?,?,NULL)").run(challenge.nonce, challenge.publicKey, origin, JSON.stringify(challenge), now, challenge.expiresAt);
    return challenge;
  }
  verify(input) {
    if (!input || Object.keys(input).sort().join() !== "challengeId,signature" || !HEX.test(input.challengeId) || typeof input.signature !== "string" || input.signature.length !== 88 ||
        Buffer.from(input.signature, "base64").length !== 64 || Buffer.from(input.signature, "base64").toString("base64") !== input.signature) throw fail("Invalid free-device proof", 401);
    const now = this.clock(), row = this.db.prepare("SELECT * FROM device_free_challenges WHERE nonce=?").get(input.challengeId);
    if (!row || row.consumed_at !== null || row.expires_at <= now || row.created_at > now) throw fail("Free-device challenge expired or already used", 401);
    const c = JSON.parse(row.payload);
    if (c.nonce !== input.challengeId || c.issuedAt !== row.created_at || c.expiresAt !== row.expires_at || c.expiresAt <= now || c.issuedAt > now) throw fail("Free-device challenge record changed", 401);
    if (digest(JSON.stringify([c.serviceOrigin, c.schedulerUrl, targetValue(c.target)])) !== this.targetHash || c.publicKey !== row.public_key) throw fail("Free-device deployment changed", 401);
    if (!crypto.verify(null, challengeHash(c), publicKey(c.publicKey), Buffer.from(input.signature, "base64"))) throw fail("Free-device signature does not match", 401);
    const token = "df_" + crypto.randomBytes(32).toString("base64url"), accountId = this.identity(c.publicKey);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.db.prepare("UPDATE device_free_challenges SET consumed_at=? WHERE nonce=? AND consumed_at IS NULL AND expires_at>?").run(now, c.nonce, now);
      if (consumed.changes !== 1) throw fail("Free-device challenge expired or already used", 401);
      this.db.prepare("DELETE FROM device_free_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL").run(now);
      this.db.prepare("DELETE FROM device_free_sessions WHERE public_key=? AND target_hash=?").run(c.publicKey, this.targetHash);
      if (this.db.prepare("SELECT COUNT(*) AS n FROM device_free_sessions").get().n >= 10000) throw fail("Free connection capacity is temporarily full", 429);
      this.db.prepare("INSERT INTO device_free_sessions VALUES(?,?,?,?,?,?,NULL)").run(digest(token), accountId, c.publicKey, this.targetHash, now, c.sessionExpiresAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { token, scope: "device-free", freeOnly: true, expiresAt: c.sessionExpiresAt, account: this.view(this.sessionAccount(token)) };
  }
  sessionAccount(token) {
    if (typeof token !== "string" || !/^df_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = this.clock(), row = this.db.prepare("SELECT * FROM device_free_sessions WHERE token_hash=? AND target_hash=? AND revoked_at IS NULL AND expires_at>? AND created_at<=?").get(digest(token), this.targetHash, now, now);
    if (!row || row.account_id !== this.identity(row.public_key)) return null;
    return { id: row.account_id, creditScope: "device-free", creditWallet: null, creditFreeOnly: true, creditExpiresAt: row.expires_at };
  }
  view(account) {
    if (account?.creditScope !== "device-free" || account.creditFreeOnly !== true || account.creditWallet !== null || !/^guest_[a-f0-9]{64}$/.test(account.id)) throw fail("Free-device session required", 401);
    return { id: account.id, scope: "device-free", freeOnly: true, wallets: [], expiresAt: account.creditExpiresAt };
  }
  revoke(token) { if (typeof token === "string" && /^df_[A-Za-z0-9_-]{43}$/.test(token)) this.db.prepare("UPDATE device_free_sessions SET revoked_at=? WHERE token_hash=?").run(this.clock(), digest(token)); }
}
module.exports = { DeviceFreeAuth, challengeHash, publicKey, CHALLENGE_TTL_MS, SESSION_TTL_MS };
