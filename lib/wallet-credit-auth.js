"use strict";

// Wallet possession grants access only to this wallet's credit lane. It is
// deliberately not an AccountService session and cannot administer the account,
// its other wallets, passkeys or spending grants.
const crypto = require("node:crypto");
const { Signer, utils } = require("koilib");
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const HEX = /^[a-f0-9]{64}$/;
function targetValue(value) {
  if (!value || Object.keys(value).sort().join() !== "chainId,credits,creditsHash,domain,policyHash" ||
      typeof value.chainId !== "string" || value.chainId.length > 100 || !value.chainId ||
      !utils.isChecksumAddress(value.credits) || !/^0x1220[a-f0-9]{64}$/.test(value.creditsHash) ||
      typeof value.domain !== "string" || !value.domain || value.domain.length > 300 || !HEX.test(value.policyHash))
    throw fail("Invalid wallet credit deployment");
  return { chainId: value.chainId, credits: value.credits, creditsHash: value.creditsHash, domain: value.domain, policyHash: value.policyHash };
}
function serviceUrl(value, originOnly = false) {
  const parsed = new URL(value);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || (originOnly && parsed.pathname !== "/"))
    throw fail("Invalid wallet credit service URL");
  return originOnly ? parsed.origin : parsed.href.replace(/\/$/, "");
}
function challengeHash(c) {
  if (!c || Object.keys(c).sort().join() !== "address,deviceId,expiresAt,freeOnly,issuedAt,nonce,purpose,schedulerUrl,schema,serviceOrigin,sessionExpiresAt,target" ||
      c.schema !== 1 || c.purpose !== "wallet-credit-session" || !utils.isChecksumAddress(c.address) || !HEX.test(c.deviceId) || typeof c.freeOnly !== "boolean" || !HEX.test(c.nonce) ||
      !Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0 || c.expiresAt !== c.issuedAt + CHALLENGE_TTL_MS || c.sessionExpiresAt !== c.issuedAt + SESSION_TTL_MS)
    throw fail("Invalid wallet credit challenge");
  const target = targetValue(c.target);
  if (serviceUrl(c.serviceOrigin, true) !== c.serviceOrigin || serviceUrl(c.schedulerUrl) !== c.schedulerUrl || new URL(c.schedulerUrl).origin !== c.serviceOrigin)
    throw fail("Wallet credit challenge origin mismatch");
  return Buffer.from(digest(JSON.stringify(["KAI-WALLET-CREDIT-SESSION-V1", c.schema, c.purpose, c.serviceOrigin, c.schedulerUrl,
    target.chainId, target.credits, target.creditsHash, target.domain, target.policyHash,
    c.address, c.deviceId, c.freeOnly, c.nonce, c.issuedAt, c.expiresAt, c.sessionExpiresAt])), "hex");
}

class WalletCreditAuth {
  constructor({ accounts, target, schedulerUrl, clock = Date.now }) {
    this.accounts = accounts; this.db = accounts.db; this.clock = clock;
    this.schedulerUrl = serviceUrl(schedulerUrl);
    this.serviceOrigin = serviceUrl(accounts.siteOrigin, true);
    if (new URL(this.schedulerUrl).origin !== this.serviceOrigin) throw fail("Wallet credit service origin mismatch");
    this.target = Object.freeze(targetValue(target));
    this.targetHash = digest(JSON.stringify([this.serviceOrigin, this.schedulerUrl, this.target]));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_credit_challenges (
        nonce TEXT PRIMARY KEY, address TEXT NOT NULL, origin_hash TEXT NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        consumed_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_wallet_credit_challenge_address ON wallet_credit_challenges(address,created_at);
      CREATE INDEX IF NOT EXISTS idx_wallet_credit_challenge_origin ON wallet_credit_challenges(origin_hash,created_at);
      CREATE TABLE IF NOT EXISTS wallet_credit_sessions (
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, address TEXT NOT NULL,
        device_id TEXT NOT NULL, target_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER, free_only INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_wallet_credit_sessions_account ON wallet_credit_sessions(account_id);
      CREATE TABLE IF NOT EXISTS wallet_credit_identities (
        address TEXT PRIMARY KEY, account_id TEXT NOT NULL);
      INSERT OR IGNORE INTO wallet_credit_identities(address,account_id) SELECT address,account_id FROM wallets;
    `);
    if (!this.db.prepare("PRAGMA table_info(wallet_credit_sessions)").all().some(c => c.name === "free_only"))
      this.db.exec("ALTER TABLE wallet_credit_sessions ADD COLUMN free_only INTEGER NOT NULL DEFAULT 0");
  }
  capabilities() {
    return { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", serviceOrigin: this.serviceOrigin, schedulerUrl: this.schedulerUrl,
      target: { ...this.target }, challengeTtlMs: CHALLENGE_TTL_MS, sessionTtlMs: SESSION_TTL_MS };
  }
  challenge(input, remoteAddress = "unknown") {
    if (!input || Object.keys(input).sort().join() !== "address,deviceId,freeOnly" || !utils.isChecksumAddress(input.address) || !HEX.test(input.deviceId) || typeof input.freeOnly !== "boolean")
      throw fail("A wallet and device identity are required");
    const now = this.clock(), origin = digest(String(remoteAddress).slice(0, 100));
    this.db.prepare("DELETE FROM wallet_credit_challenges WHERE expires_at <= ?").run(now);
    if (this.db.prepare("SELECT COUNT(*) AS n FROM wallet_credit_challenges").get().n >= 10000 ||
        this.db.prepare("SELECT COUNT(*) AS n FROM wallet_credit_challenges WHERE address = ?").get(input.address).n >= 10 ||
        this.db.prepare("SELECT COUNT(*) AS n FROM wallet_credit_challenges WHERE origin_hash = ?").get(origin).n >= 60)
      throw fail("Too many connection attempts. Try again shortly.", 429);
    const challenge = { schema: 1, purpose: "wallet-credit-session", serviceOrigin: this.serviceOrigin, schedulerUrl: this.schedulerUrl,
      target: { ...this.target }, address: input.address, deviceId: input.deviceId, freeOnly: input.freeOnly, nonce: crypto.randomBytes(32).toString("hex"),
      issuedAt: now, expiresAt: now + CHALLENGE_TTL_MS, sessionExpiresAt: now + SESSION_TTL_MS };
    challengeHash(challenge);
    this.db.prepare("INSERT INTO wallet_credit_challenges(nonce,address,origin_hash,payload,created_at,expires_at) VALUES(?,?,?,?,?,?)")
      .run(challenge.nonce, challenge.address, origin, JSON.stringify(challenge), now, challenge.expiresAt);
    return challenge;
  }
  verify(input) {
    if (!input || Object.keys(input).sort().join() !== "challengeId,signature" || !HEX.test(input.challengeId) ||
        typeof input.signature !== "string" || input.signature.length > 100 || Buffer.from(input.signature, "base64").length !== 65 ||
        Buffer.from(input.signature, "base64").toString("base64") !== input.signature) throw fail("Invalid wallet connection proof", 401);
    const now = this.clock(), row = this.db.prepare("SELECT * FROM wallet_credit_challenges WHERE nonce = ?").get(input.challengeId);
    if (!row || row.consumed_at !== null || row.expires_at <= now || row.created_at > now) throw fail("Wallet connection challenge expired or already used", 401);
    const challenge = JSON.parse(row.payload);
    if (digest(JSON.stringify([challenge.serviceOrigin, challenge.schedulerUrl, targetValue(challenge.target)])) !== this.targetHash)
      throw fail("Wallet connection belongs to another deployment", 401);
    let signer;
    try { signer = Signer.recoverAddress(challengeHash(challenge), Buffer.from(input.signature, "base64")); }
    catch { throw fail("Invalid wallet connection proof", 401); }
    if (signer !== challenge.address) throw fail("Wallet connection proof does not match this wallet", 401);
    const token = "wc_" + crypto.randomBytes(32).toString("base64url");
    let accountId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.db.prepare("UPDATE wallet_credit_challenges SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL AND expires_at > ?")
        .run(now, challenge.nonce, now);
      if (used.changes !== 1) throw fail("Wallet connection challenge expired or already used", 401);
      const linked = this.db.prepare("SELECT account_id FROM wallets WHERE address = ?").get(challenge.address);
      const known = this.db.prepare("SELECT account_id FROM wallet_credit_identities WHERE address = ?").get(challenge.address);
      if (known && (!linked || linked.account_id !== known.account_id))
        throw fail("This wallet's account link changed. Use the existing account to recover credit access.", 409);
      if (linked) {
        accountId = linked.account_id;
        if (!this.accounts.getAccount(accountId)) throw fail("Wallet account needs recovery", 409);
      } else {
        accountId = "acc_" + crypto.randomBytes(8).toString("hex");
        this.db.prepare("INSERT INTO accounts(id,email,google_sub,created_at,last_seen_at) VALUES(?,NULL,NULL,?,?)").run(accountId, now, now);
        this.db.prepare("INSERT INTO wallets(address,account_id,label,linked_at) VALUES(?,?,NULL,?)").run(challenge.address, accountId, now);
      }
      this.db.prepare("INSERT OR IGNORE INTO wallet_credit_identities(address,account_id) VALUES(?,?)").run(challenge.address, accountId);
      this.db.prepare("DELETE FROM wallet_credit_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
      this.db.prepare("UPDATE wallet_credit_sessions SET revoked_at = ? WHERE address = ? AND device_id = ? AND target_hash = ?")
        .run(now, challenge.address, challenge.deviceId, this.targetHash);
      if (this.db.prepare("SELECT COUNT(*) AS n FROM wallet_credit_sessions WHERE address = ? AND revoked_at IS NULL").get(challenge.address).n >= 64)
        throw fail("This wallet has too many connected devices. Disconnect an existing device first.", 409);
      this.db.prepare("INSERT INTO wallet_credit_sessions(token_hash,account_id,address,device_id,target_hash,created_at,expires_at,free_only) VALUES(?,?,?,?,?,?,?,?)")
        .run(digest(token), accountId, challenge.address, challenge.deviceId, this.targetHash, now, challenge.sessionExpiresAt, challenge.freeOnly ? 1 : 0);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    const account = this.sessionAccount(token);
    return { token, account: this.view(account), expiresAt: challenge.sessionExpiresAt, scope: "wallet-credits", freeOnly: challenge.freeOnly };
  }
  sessionAccount(token) {
    if (typeof token !== "string" || !/^wc_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = this.clock(), row = this.db.prepare(`SELECT s.* FROM wallet_credit_sessions s JOIN wallets w
      ON w.address = s.address AND w.account_id = s.account_id JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.target_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND s.created_at <= ?`)
      .get(digest(token), this.targetHash, now, now);
    if (!row) return null;
    return { id: row.account_id, creditScope: "wallet-credits", creditWallet: row.address, creditDevice: row.device_id, creditExpiresAt: row.expires_at, creditFreeOnly: row.free_only === 1 };
  }
  view(account) {
    if (account?.creditScope !== "wallet-credits") throw fail("Wallet credit session required", 401);
    const linked = this.db.prepare("SELECT linked_at FROM wallets WHERE address = ? AND account_id = ?").get(account.creditWallet, account.id);
    if (!linked) throw fail("Wallet credit session revoked", 401);
    return { id: account.id, scope: "wallet-credits", freeOnly: account.creditFreeOnly === true, wallets: [{ address: account.creditWallet, linkedAt: Number(linked.linked_at) }], expiresAt: account.creditExpiresAt };
  }
  revoke(token) {
    if (typeof token === "string" && /^wc_[A-Za-z0-9_-]{43}$/.test(token))
      this.db.prepare("UPDATE wallet_credit_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(this.clock(), digest(token));
  }
  revokeAccount(id) { this.db.prepare("UPDATE wallet_credit_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").run(this.clock(), id); }
  revokeWallet(id, address) { this.db.prepare("UPDATE wallet_credit_sessions SET revoked_at = ? WHERE account_id = ? AND address = ? AND revoked_at IS NULL").run(this.clock(), id, address); }
  rememberWallet(id, address) { this.db.prepare("INSERT OR IGNORE INTO wallet_credit_identities(address,account_id) VALUES(?,?)").run(address, id); }
}
module.exports = { WalletCreditAuth, challengeHash, CHALLENGE_TTL_MS, SESSION_TTL_MS };
