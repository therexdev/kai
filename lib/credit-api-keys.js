"use strict";
const crypto = require("node:crypto");
const P = require("./koin-network/job-protocol");
const { uint } = require("./koin-network/policy");
const SCOPES = ["inference", "billing:read", "billing:purchase"];
const fail = (message, status = 400) => Object.assign(Error(message), { status });
// Only trusted in-process code can install this repeatedly checked resolver.
const CREDIT_ACCESS = Symbol("verified credit gateway access");
class CreditApiKeys {
  constructor(accounts, clock = Date.now) {
    this.accounts = accounts; this.db = accounts.db; this.clock = clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS credit_api_keys (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, prefix TEXT NOT NULL, wallet TEXT, scopes TEXT NOT NULL,
      free_only INTEGER NOT NULL, daily_limit TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER);
      CREATE INDEX IF NOT EXISTS credit_api_keys_account ON credit_api_keys(account_id);
      CREATE TABLE IF NOT EXISTS credit_api_rate (account_id TEXT PRIMARY KEY, minute INTEGER NOT NULL, requests INTEGER NOT NULL);`);
  }
  view(r) { return { id: r.id, name: r.name, prefix: r.prefix, wallet: r.wallet, scopes: JSON.parse(r.scopes),
    freeOnly: !!r.free_only, dailyLimitAtoms: r.daily_limit, createdAt: r.created_at, expiresAt: r.expires_at,
    revokedAt: r.revoked_at, lastUsedAt: r.last_used_at }; }
  list(account) { return this.db.prepare("SELECT * FROM credit_api_keys WHERE account_id=? ORDER BY created_at DESC LIMIT 100").all(account.id).map(r => this.view(r)); }
  create(account, input) {
    if (!input || Object.keys(input).some(k => !["name", "wallet", "scopes", "freeOnly", "dailyLimitAtoms", "expiresInDays"].includes(k))) throw fail("Invalid API key settings");
    const { name, wallet = null, scopes = ["inference", "billing:read"], freeOnly = true, dailyLimitAtoms, expiresInDays = 90 } = input;
    if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)) throw fail("Give this key a name (up to 80 characters)");
    if (!Array.isArray(scopes) || !scopes.length || new Set(scopes).size !== scopes.length || scopes.some(s => !SCOPES.includes(s))) throw fail("Choose supported API permissions");
    if (typeof freeOnly !== "boolean" || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) throw fail("Invalid API key lifetime or credit preference");
    if (typeof dailyLimitAtoms !== "string" || !uint(dailyLimitAtoms)) throw fail("Set a positive daily credit limit");
    const wallets = this.accounts.creditAccountView(account).wallets;
    if (wallet !== null && !wallets.some(w => w.address === wallet)) throw fail("Select a wallet linked to your account");
    if (wallet === null && (!freeOnly || scopes.includes("billing:purchase"))) throw fail("Link a payment wallet before enabling purchased credits");
    const now = this.clock();
    if (this.db.prepare("SELECT count(*) AS n FROM credit_api_keys WHERE account_id=? AND revoked_at IS NULL AND expires_at>?").get(account.id, now).n >= 20) throw fail("Revoke an existing key before creating another (20 active keys maximum)");
    const token = "kai_api_" + crypto.randomBytes(32).toString("base64url"), id = crypto.randomBytes(16).toString("hex");
    this.db.prepare("INSERT INTO credit_api_keys VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)").run(id, account.id, P.hash(token), name.trim(), token.slice(0, 16), wallet, JSON.stringify(scopes), Number(freeOnly), dailyLimitAtoms, now, now + expiresInDays * 86400000);
    return { key: this.view(this.db.prepare("SELECT * FROM credit_api_keys WHERE id=?").get(id)), secret: token };
  }
  revoke(account, id) {
    const found = this.db.prepare("SELECT id FROM credit_api_keys WHERE id=? AND account_id=?").get(id, account.id);
    if (!found) throw fail("API key not found", 404);
    this.db.prepare("UPDATE credit_api_keys SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND account_id=?").run(this.clock(), id, account.id);
  }
  resolve(token, scope, touch = false) {
    if (typeof token !== "string" || !/^kai_api_[A-Za-z0-9_-]{43}$/.test(token)) throw fail("A valid KAI API key is required", 401);
    const row = this.db.prepare("SELECT * FROM credit_api_keys WHERE token_hash=?").get(P.hash(token)), now = this.clock();
    if (!row || row.revoked_at !== null || row.expires_at <= now) throw fail("API key is invalid, expired or revoked", 401);
    if (!JSON.parse(row.scopes).includes(scope)) throw fail("This API key does not have the required permission", 403);
    const account = this.accounts.accountById(row.account_id);
    if (!account || (row.wallet && !this.accounts.creditAccountView(account).wallets.some(w => w.address === row.wallet))) throw fail("API key account or linked wallet is unavailable", 401);
    if (touch) this.db.prepare("UPDATE credit_api_keys SET last_used_at=? WHERE id=?").run(now, row.id);
    return { account: { ...account, creditScope: "api-key", creditWallet: row.wallet, creditFreeOnly: scope === "inference" && !!row.free_only },
      wallet: row.wallet, key: this.view(row), apiPolicy: { id: row.id, dailyLimit: row.daily_limit } };
  }
  rate(accountId) {
    const minute = Math.floor(this.clock() / 60000);
    const row = this.db.prepare(`INSERT INTO credit_api_rate VALUES(?,?,1) ON CONFLICT(account_id) DO UPDATE SET
      minute=excluded.minute,requests=CASE WHEN credit_api_rate.minute=excluded.minute THEN credit_api_rate.requests+1 ELSE 1 END RETURNING requests`).get(accountId, minute);
    if (row.requests > 60) throw fail("Account request limit reached. Retry in one minute.", 429);
  }
}
module.exports = { CreditApiKeys, CREDIT_ACCESS, fail };
