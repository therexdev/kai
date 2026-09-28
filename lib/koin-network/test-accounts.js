"use strict";
const fs = require("fs"), crypto = require("crypto"), { utils } = require("koilib");
const P = require("./job-protocol"), D = require("./session-delegation");
// Explicit Test invitations only. Does not load, proxy or share live sessions.
// Tokens identify the invite; the wallet must separately sign bounded spending.
class TestAccounts {
  constructor(file, clock = Date.now) { this.file = file; this.clock = clock; this.rows(); }
  rows() {
    const stat = fs.lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error("Invalid Test invitation file");
    const rows = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!Array.isArray(rows) || !rows.length || rows.length > 64) throw Error("One to 64 explicit Test invitations required");
    for (const r of rows) {
      if (Object.keys(r).sort().join() !== "accountId,enabled,expiresAt,grantId,owner,tokenHash" || typeof r.enabled !== "boolean" || !utils.isChecksumAddress(r.owner)) throw Error("Invalid Test invitation");
      D.identity(r.accountId); D.identity(r.grantId); P.digest(r.tokenHash); P.integer(r.expiresAt);
    }
    for (const k of ["accountId", "grantId", "owner", "tokenHash"]) if (new Set(rows.map(r => r[k])).size !== rows.length) throw Error("Duplicate Test invitation");
    return rows;
  }
  sessionAccount(token) {
    if (typeof token !== "string" || !/^test_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const digest = Buffer.from(P.hash(token), "hex"), row = this.rows().find(r => crypto.timingSafeEqual(digest, Buffer.from(r.tokenHash, "hex")));
    return row?.enabled && this.clock() < row.expiresAt ? { id: row.accountId } : null;
  }
  accountById(id) { return this.rows().some(r => r.accountId === id) ? { id } : null; }
  accountView(account) { return { id: account.id, wallets: this.rows().filter(r => r.accountId === account.id && r.enabled && this.clock() < r.expiresAt).map(r => ({ address: r.owner })) }; }
  spendableGrant(accountId, grantId) {
    const r = this.rows().find(r => r.accountId === accountId && r.grantId === grantId);
    if (!r || !r.enabled || this.clock() >= r.expiresAt) throw Error("Test access expired or revoked");
    return { id: r.grantId, address: r.owner, expiresAt: r.expiresAt, live: true };
  }
  chargeGrant() { throw Error("Legacy spending is disabled on the Test backend"); }
  refundGrant() { throw Error("Legacy spending is disabled on the Test backend"); }
}
module.exports = { TestAccounts };
