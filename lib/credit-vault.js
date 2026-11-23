"use strict";
const crypto = require("node:crypto");
const VAULT = "https://koinvault.app";
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
/** Server-bound wallet approvals. Client supplied addresses never establish ownership. */
class CreditVault {
  constructor(accounts, { fetcher = fetch, clock = Date.now } = {}) {
    this.accounts = accounts; this.db = accounts.db; this.fetcher = fetcher; this.clock = clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS credit_vault_links (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, secret_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, address TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS credit_vault_quotes (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, wallet TEXT NOT NULL, operations TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, session_id TEXT, request_id TEXT);`);
  }
  async call(path, body, query) {
    const url = new URL(path, VAULT); if (query) url.search = new URLSearchParams(query).toString();
    let r; try { r = await this.fetcher(url, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Origin: this.accounts.siteOrigin, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); } catch { throw fail("KOIN Vault connection could not be confirmed",502); }
    // Do not surface wallet error bodies: pairing secrets may be echoed there.
    if (!r.ok) throw fail("KOIN Vault is unavailable or the connection expired. Check your wallet before retrying.", r.status === 404 ? 410 : 502);
    const text = await r.text(); if (text.length > 131072) throw fail("Invalid wallet response", 502);
    let value; try { value = JSON.parse(text); } catch { throw fail("Invalid wallet response",502); } if (value.ok !== true) throw fail("Wallet request was not accepted", 502); return value;
  }
  async connect(account) {
    const config = await this.call("/api/config");
    if (config.demo || config.network !== "mainnet" || config.features?.openDappConnections !== true || config.features?.dappReviewVersion !== 1) throw fail("KOIN Vault mainnet connections are unavailable", 503);
    const s = await this.call("/api/dapp/create", { name: "Koinos AI", icon: this.accounts.siteOrigin + "/redesign/brand-mark.svg" });
    if (typeof s.sessionId !== "string" || s.sessionId.length > 256 || typeof s.secret !== "string" || s.secret.length < 20 || s.secret.length > 512 || !Number.isSafeInteger(s.expiresAt) || s.expiresAt <= this.clock()) throw fail("Invalid wallet connection", 502);
    const uri = new URL(s.uri);
    if (uri.origin !== VAULT || uri.pathname !== "/" || uri.username || uri.password || uri.searchParams.get("connect") !== s.sessionId || uri.searchParams.get("secret") !== s.secret) throw fail("Invalid wallet destination", 502);
    this.db.prepare("DELETE FROM credit_vault_links WHERE expires_at < ?").run(this.clock());
    this.db.prepare("INSERT INTO credit_vault_links (id,account_id,secret_hash,expires_at) VALUES (?,?,?,?)").run(s.sessionId, account.id, hash(s.secret), s.expiresAt);
    return { sessionId: s.sessionId, secret: s.secret, uri: s.uri, expiresAt: s.expiresAt };
  }
  credentials(account, input) {
    const { sessionId, secret } = input || {};
    if (typeof sessionId !== "string" || typeof secret !== "string" || secret.length > 512) throw fail("Reconnect KOIN Vault");
    const row = this.db.prepare("SELECT * FROM credit_vault_links WHERE id = ? AND account_id = ?").get(sessionId, account.id);
    if (!row || row.expires_at <= this.clock() || !crypto.timingSafeEqual(Buffer.from(row.secret_hash,"hex"),Buffer.from(hash(secret),"hex"))) throw fail("Reconnect KOIN Vault", 403);
    return { sessionId, secret };
  }
  async status(account, input) {
    const creds = this.credentials(account,input), s = await this.call("/api/dapp/status", null, creds);
    if (s.origin !== this.accounts.siteOrigin || s.id !== creds.sessionId || !Number.isSafeInteger(s.expiresAt) || s.expiresAt <= this.clock()) throw fail("Wallet connection no longer matches this account", 403);
    if (!s.connected) return { connected: false };
    if (!/^[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(s.address || "")) throw fail("Invalid wallet address", 502);
    const previous = this.db.prepare("SELECT address FROM credit_vault_links WHERE id=?").get(creds.sessionId).address;
    if (previous && (previous !== s.address || !this.accounts.accountView(account).wallets.some(w=>w.address===s.address))) throw fail("Wallet was unlinked. Reconnect to authorize it again.",403);
    if (!previous) {
      this.accounts.linkVerifiedVaultWallet(account,s.address);
      this.db.prepare("UPDATE credit_vault_links SET address=? WHERE id=?").run(s.address,creds.sessionId);
    }
    return { connected: true, address: s.address };
  }
  rememberQuote(account, q) {
    const id = crypto.randomUUID();
    this.db.prepare("DELETE FROM credit_vault_quotes WHERE expires_at < ? AND state = 'review'").run(this.clock());
    this.db.prepare("INSERT INTO credit_vault_quotes (id,account_id,wallet,operations,expires_at,state) VALUES (?,?,?,?,?,'review')")
      .run(id,account.id,q.signerAddress,JSON.stringify(q.transaction.operations),q.expiresAt);
    return { ...q, vaultQuoteId: id };
  }
  async request(account,input) {
    const creds = this.credentials(account,input), status = await this.status(account,input);
    const q = this.db.prepare("SELECT * FROM credit_vault_quotes WHERE id = ? AND account_id = ?").get(input.quoteId,account.id);
    if (!q || !status.connected || q.wallet !== status.address || q.expires_at <= this.clock()) throw fail("Review a new quote for the connected wallet");
    if (q.state === "requested" && q.session_id === creds.sessionId) return { requestId: q.request_id };
    if (q.state !== "review") throw fail("The previous wallet request has an uncertain outcome. Inspect KOIN Vault before making another purchase.",409);
    // Commit before the non-idempotent remote request. Never replay after an ambiguous response.
    const claimed = this.db.prepare("UPDATE credit_vault_quotes SET state='submitting',session_id=? WHERE id=? AND state='review'").run(creds.sessionId,q.id);
    if (!claimed.changes) throw fail("Wallet request already started",409);
    try {
      const r = await this.call("/api/dapp/request", { ...creds, operations: JSON.parse(q.operations), mana: "wallet" });
      if (typeof r.requestId !== "string" || !r.requestId || r.requestId.length > 256) throw fail("Invalid wallet request response",502);
      this.db.prepare("UPDATE credit_vault_quotes SET state='requested',request_id=? WHERE id=?").run(r.requestId,q.id);
      return { requestId: r.requestId };
    } catch { throw fail("Wallet request outcome is unknown. Check KOIN Vault; do not repeat the purchase until reconciled.",502); }
  }
  async result(account,input) {
    const creds = this.credentials(account,input);
    const q = this.db.prepare("SELECT * FROM credit_vault_quotes WHERE request_id=? AND account_id=? AND session_id=?").get(input.requestId,account.id,creds.sessionId);
    if (!q) throw fail("Unknown wallet purchase",404);
    const s = await this.call("/api/dapp/request-status",null,{ ...creds, requestId:q.request_id });
    return { status: s.status, txid: /^0x1220[a-f0-9]{64}$/.test(s.txid || "") ? s.txid : null, wallet:q.wallet };
  }
}
module.exports = { CreditVault };
