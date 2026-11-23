"use strict";
const crypto = require("node:crypto"), { Signer, utils } = require("koilib");
const WINDOW = 5 * 60 * 1000;
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const message = (origin, address, accountId, ts) => JSON.stringify(["KAI-CREDIT-WALLET-LINK-V1", origin, address, accountId, ts]);
const revokeMessage = (origin, address, ts) => JSON.stringify(["KAI-CREDIT-WALLET-REVOKE-V1", origin, address, ts]);

// A separate credit permission, never an account merge or wallet transfer.
// The wallet signs the exact recipient and service. Its original account ID
// remains the funding identity, so linking cannot reset its daily allowance.
class CreditWalletLinks {
  constructor(accounts, clock = Date.now) {
    this.accounts = accounts; this.db = accounts.db; this.clock = clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS credit_wallet_links (
      address TEXT NOT NULL, owner_account_id TEXT NOT NULL, account_id TEXT NOT NULL,
      linked_at INTEGER NOT NULL, PRIMARY KEY(address,account_id));
      CREATE INDEX IF NOT EXISTS credit_wallet_links_account ON credit_wallet_links(account_id);
      CREATE TABLE IF NOT EXISTS credit_wallet_link_proofs (
      digest TEXT PRIMARY KEY, used_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_wallet_preferences (account_id TEXT PRIMARY KEY, primary_wallet TEXT);`);
  }
  primary(account, wallets) {
    const saved = this.db.prepare("SELECT primary_wallet FROM credit_wallet_preferences WHERE account_id=?").get(account.id)?.primary_wallet;
    return wallets.some(w => w.address === saved) ? saved : null;
  }
  setPrimary(account, address) {
    if (address !== null && !this.accounts.creditAccountView(account).wallets.some(w => w.address === address)) throw fail("Choose one of your linked credit accounts");
    this.db.prepare("INSERT INTO credit_wallet_preferences VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET primary_wallet=excluded.primary_wallet").run(account.id, address);
  }
  forgetPrimary(accountId, address) { this.db.prepare("UPDATE credit_wallet_preferences SET primary_wallet=NULL WHERE account_id=? AND primary_wallet=?").run(accountId, address); }
  wallets(account) {
    return this.db.prepare(`SELECT l.address,l.owner_account_id,l.linked_at FROM credit_wallet_links l
      JOIN wallets w ON w.address=l.address AND w.account_id=l.owner_account_id
      JOIN accounts a ON a.id=l.owner_account_id WHERE l.account_id=? ORDER BY l.linked_at`).all(account.id)
      .map(w => ({ address: w.address, linkedAt: w.linked_at, creditAccountId: w.owner_account_id, creditAccessOnly: true }));
  }
  account(account, address) {
    if (!address || this.db.prepare("SELECT 1 FROM wallets WHERE address=? AND account_id=?").get(address, account.id)) return account;
    const link = this.wallets(account).find(w => w.address === address);
    if (!link) throw fail("This Core wallet is no longer linked to your account", 403);
    return { ...account, id: link.creditAccountId, creditScope: account.creditScope || "linked-wallet", creditWallet: address };
  }
  link(account, input) {
    if (!input || Object.keys(input).sort().join() !== "address,signature,ts" || !utils.isChecksumAddress(input.address) ||
        !Number.isSafeInteger(input.ts) || Math.abs(this.clock() - input.ts) > WINDOW ||
        typeof input.signature !== "string" || input.signature.length > 100 || Buffer.from(input.signature, "base64").length !== 65 ||
        Buffer.from(input.signature, "base64").toString("base64") !== input.signature) throw fail("Invalid or expired credit-link proof. Link this wallet again from Core.");
    const { address, ts, signature } = input, hash = crypto.createHash("sha256").update(message(this.accounts.siteOrigin, address, account.id, ts)).digest();
    let signer; try { signer = Signer.recoverAddress(hash, Buffer.from(signature, "base64")); } catch { throw fail("Invalid credit-link signature", 401); }
    if (signer !== address) throw fail("The credit-link signature does not match this wallet and account", 401);
    const now = this.clock();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM credit_wallet_link_proofs WHERE used_at < ?").run(now - WINDOW * 2);
      const prior = this.db.prepare("SELECT 1 FROM credit_wallet_link_proofs WHERE digest=?").get(hash.toString("hex"));
      const owned = this.db.prepare("SELECT account_id FROM wallets WHERE address=?").get(address);
      const linked = this.wallets(account).some(w => w.address === address);
      if (prior && owned?.account_id !== account.id && !linked) throw fail("This credit-link approval was revoked. Approve a new link in Core.", 409);
      if (prior) { this.db.exec("COMMIT"); return; }
      if (this.db.prepare("SELECT count(*) AS n FROM credit_wallet_link_proofs").get().n >= 10000) throw fail("Too many credit-link requests. Try again shortly.", 429);
      if (this.accounts.accountView(account).wallets.length + this.wallets(account).length >= 64 && !linked && owned?.account_id !== account.id)
        throw fail("This account has reached its wallet limit", 409);
      if (owned && !this.accounts.getAccount(owned.account_id)) throw fail("The original credit account needs recovery", 409);
      if (!owned) {
        // A remembered credit identity must be recovered, never reassigned.
        const remembered = this.accounts.walletCredits && this.db.prepare("SELECT account_id FROM wallet_credit_identities WHERE address=?").get(address);
        if (remembered) throw fail("Restore this wallet's original account link before linking credit access", 409);
        this.db.prepare("INSERT INTO wallets(address,account_id,label,linked_at) VALUES(?,?,NULL,?)").run(address, account.id, now);
        this.accounts.walletCredits?.rememberWallet(account.id, address);
      } else if (owned.account_id !== account.id) {
        if (!linked && this.db.prepare("SELECT count(*) AS n FROM credit_wallet_links WHERE address=?").get(address).n >= 16)
          throw fail("This Core wallet has reached its linked-account limit", 409);
        this.db.prepare("INSERT OR IGNORE INTO credit_wallet_links VALUES(?,?,?,?)").run(address, owned.account_id, account.id, now);
      }
      this.db.prepare("INSERT INTO credit_wallet_link_proofs VALUES(?,?)").run(hash.toString("hex"), now);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  revokeKeys(accountId, address) {
    this.forgetPrimary(accountId, address);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_api_keys'").get())
      this.db.prepare("UPDATE credit_api_keys SET revoked_at=coalesce(revoked_at,?) WHERE account_id=? AND wallet=?").run(this.clock(), accountId, address);
  }
  unlink(account, address) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.revokeKeys(account.id, address);
      const result = this.db.prepare("DELETE FROM credit_wallet_links WHERE address=? AND account_id=?").run(address, account.id);
      if (!result.changes) throw fail("This Core credit link is not on your account", 404);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  revokeOwned(account, address) {
    for (const row of this.db.prepare("SELECT account_id FROM credit_wallet_links WHERE address=? AND owner_account_id=?").all(address, account.id))
      this.revokeKeys(row.account_id, address);
    this.db.prepare("DELETE FROM credit_wallet_links WHERE address=? AND owner_account_id=?").run(address, account.id);
  }
  revokeByWallet(input) {
    if (!input || Object.keys(input).sort().join() !== "address,signature,ts" || !utils.isChecksumAddress(input.address) ||
        !Number.isSafeInteger(input.ts) || Math.abs(this.clock() - input.ts) > WINDOW || typeof input.signature !== "string" ||
        input.signature.length > 100 || Buffer.from(input.signature, "base64").length !== 65 || Buffer.from(input.signature, "base64").toString("base64") !== input.signature)
      throw fail("Invalid or expired wallet revocation proof");
    const hash = crypto.createHash("sha256").update(revokeMessage(this.accounts.siteOrigin, input.address, input.ts)).digest();
    let signer; try { signer = Signer.recoverAddress(hash, Buffer.from(input.signature, "base64")); } catch { throw fail("Invalid wallet revocation signature", 401); }
    if (signer !== input.address) throw fail("The revocation signature does not match this wallet", 401);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM credit_wallet_link_proofs WHERE used_at < ?").run(this.clock() - WINDOW * 2);
      const prior = this.db.prepare("SELECT 1 FROM credit_wallet_link_proofs WHERE digest=?").get(hash.toString("hex"));
      if (!prior) {
        if (this.db.prepare("SELECT count(*) AS n FROM credit_wallet_link_proofs").get().n >= 10000) throw fail("Too many credit-link requests. Try again shortly.", 429);
        const owner = this.db.prepare("SELECT account_id FROM wallets WHERE address=?").get(input.address);
        if (owner) this.revokeOwned({ id: owner.account_id }, input.address);
        this.db.prepare("INSERT INTO credit_wallet_link_proofs VALUES(?,?)").run(hash.toString("hex"), this.clock());
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}
module.exports = { CreditWalletLinks, message, revokeMessage, WINDOW };
