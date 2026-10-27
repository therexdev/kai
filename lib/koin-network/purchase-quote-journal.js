"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite"), { JournalSet } = require("./journal-set");
const Q = require("./purchase-quote"), Provenance = require("./purchase-provenance"), { uint } = require("./policy");
const FILE = "purchase-quotes.sqlite", DAY = 86400000;
// Compatibility parser for existing reviewed runtime files. New configuration
// needs no daily quote budget, and these historical values never gate issuance.
function budget(value) {
  if (value === undefined) return undefined;
  if (!value || Object.keys(value).sort().join() !== "accountDailyQuoteAuthorizationUsdAtoms,dailyQuoteAuthorizationUsdAtoms,schema" || value.schema !== 1 ||
      typeof value.dailyQuoteAuthorizationUsdAtoms !== "string" || !uint(value.dailyQuoteAuthorizationUsdAtoms) ||
      typeof value.accountDailyQuoteAuthorizationUsdAtoms !== "string" || !uint(value.accountDailyQuoteAuthorizationUsdAtoms) ||
      uint(value.accountDailyQuoteAuthorizationUsdAtoms) > uint(value.dailyQuoteAuthorizationUsdAtoms)) throw Error("Invalid legacy purchase quote budget settings");
  return structuredClone(value);
}
function identity(deployment) {
  return Provenance.canonical(Object.fromEntries(["product", "chainId", "token", "tokenHash", "credits", "creditsHash", "masterNode", "verifier"].map(k => [k, deployment[k]])));
}
function hash(value) { return Provenance.digest(JSON.stringify(Provenance.canonical(value))); }
function requestKey({ account, accountId = account, denomination, amount, scope, intentId }) {
  if (typeof intentId !== "string" || !/^[0-9a-f]{64}$/.test(intentId) || typeof accountId !== "string" || !accountId || accountId.length > 200 || !["KOIN", "USD"].includes(denomination) || typeof amount !== "string" || amount.length > 32) throw Error("Bounded quote request with purchase intent required");
  return hash({ account, accountId, denomination, amount, scope, intentId });
}
class PurchaseQuoteJournal {
  constructor(directory, deployment) {
    this.guard = new JournalSet(directory, { files: [FILE] });
    try {
      const file = path.join(directory, FILE);
      this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS clock(id INTEGER PRIMARY KEY CHECK(id=1), latest INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS days(day INTEGER PRIMARY KEY, authorized TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS account_days(day INTEGER NOT NULL, account_key TEXT NOT NULL, authorized TEXT NOT NULL, PRIMARY KEY(day,account_key));
        CREATE TABLE IF NOT EXISTS evidence(hash TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, request_key TEXT NOT NULL, day INTEGER NOT NULL, expires INTEGER NOT NULL,
          intent TEXT NOT NULL, intent_hash TEXT NOT NULL, evidence_hash TEXT NOT NULL, signed TEXT,
          FOREIGN KEY(evidence_hash) REFERENCES evidence(hash));
        CREATE INDEX IF NOT EXISTS quote_request ON quotes(request_key, expires);`);
      this.guard.attach(this.db);
      this.guard.write(this.db, () => {
        const expected = JSON.stringify(identity(deployment)), row = this.db.prepare("SELECT value FROM identity WHERE id=1").get();
        if (row && row.value !== expected) throw Error("Purchase journal deployment changed");
        if (!row) this.db.prepare("INSERT INTO identity VALUES(1,?)").run(expected);
      });
    } catch (error) { this.db?.close(); this.guard.close(); throw error; }
  }
  time(now) {
    if (!Number.isSafeInteger(now) || now < 1) throw Error("Quote journal time required");
    const saved = this.db.prepare("SELECT latest FROM clock WHERE id=1").get();
    if (saved && now < saved.latest) throw Error("Quote journal clock moved backward");
    this.db.prepare("INSERT INTO clock VALUES(1,?) ON CONFLICT(id) DO UPDATE SET latest=excluded.latest").run(now);
  }
  read(row) {
    if (!row) return null;
    const intent = JSON.parse(row.intent), archived = this.db.prepare("SELECT body FROM evidence WHERE hash=?").get(row.evidence_hash);
    if (hash(intent) !== row.intent_hash || !archived || Provenance.evidence(JSON.parse(archived.body)).hash !== row.evidence_hash ||
        row.id !== intent.quote.id || row.expires !== Number(intent.quote.expires_at) || row.evidence_hash !== intent.priceDetails.evidenceHash ||
        row.day !== Math.floor(Number(intent.quote.issued_at) / DAY)) throw Error("Purchase journal evidence or intent changed");
    Provenance.verify(Q.quote(intent.quote), intent.priceDetails);
    const args = row.signed ? JSON.parse(row.signed) : null;
    if (args && JSON.stringify(args.purchase_quote) !== JSON.stringify(intent.quote)) throw Error("Saved signed quote changed");
    return { ...intent, args };
  }
  lookup(request, now) {
    return this.guard.write(this.db, () => {
      this.time(now);
      return this.read(this.db.prepare("SELECT * FROM quotes WHERE request_key=? AND expires>=? ORDER BY expires DESC LIMIT 1").get(requestKey(request), now));
    });
  }
  admit(request, candidate, evidence, now) {
    const archived = Provenance.evidence(evidence);
    const key = requestKey(request), accountKey = hash("verified-account:" + request.accountId);
    const intent = { quote: Q.quote(candidate.quote), priceDetails: Provenance.details(candidate.priceDetails), accountKey };
    Provenance.verify(intent.quote, intent.priceDetails);
    if (archived.hash !== intent.priceDetails.evidenceHash || Number(intent.quote.issued_at) !== now) throw Error("Quote evidence differs from intent");
    return this.guard.write(this.db, () => {
      this.time(now);
      const existing = this.read(this.db.prepare("SELECT * FROM quotes WHERE request_key=? AND expires>=? ORDER BY expires DESC LIMIT 1").get(key, now));
      if (existing) return existing;
      const day = Math.floor(now / DAY);
      // The signed intent and its full evidence remain durable. Daily counters
      // from older versions are retained as history, never read or incremented:
      // checking a price or dismissing approval must not consume buying access.
      const prior = this.db.prepare("SELECT body FROM evidence WHERE hash=?").get(archived.hash);
      if (prior && prior.body !== archived.text) throw Error("Purchase evidence collision");
      this.db.prepare("INSERT OR IGNORE INTO evidence VALUES(?,?)").run(archived.hash, archived.text);
      this.db.prepare("INSERT INTO quotes VALUES(?,?,?,?,?,?,?,NULL)").run(intent.quote.id, key, day, Number(intent.quote.expires_at), JSON.stringify(intent), hash(intent), archived.hash);
      return { ...intent, args: null };
    });
  }
  save(id, args, now) {
    return this.guard.write(this.db, () => {
      this.time(now);
      const saved = this.read(this.db.prepare("SELECT * FROM quotes WHERE id=?").get(id));
      if (!saved || JSON.stringify(saved.quote) !== JSON.stringify(args.purchase_quote)) throw Error("Signed quote is not the admitted intent");
      if (saved.args) return saved.args;
      this.db.prepare("UPDATE quotes SET signed=? WHERE id=? AND signed IS NULL").run(JSON.stringify(args), id);
      return args;
    });
  }
  close() { this.db.close(); this.guard.close(); }
}
function unavailable() { return Object.assign(Error("New credit purchases are temporarily unavailable. Existing credits remain usable."), { code: "PURCHASE_QUOTE_UNAVAILABLE" }); }
class PurchaseQuoteIssuer {
  constructor({ directory, deployment, signer, prices, policy, scope, version, clock = Date.now }) {
    Object.assign(this, { directory, deployment, signer, prices, policy, scope, version, clock });
    this.journal = null; this.closed = false;
  }
  async issue(account, requestedAmount, denomination = "KOIN", accountId = account, intentId) {
    try {
      if (this.closed) throw Error("Quote issuer closed");
      if (denomination === "USD") Q.nativeForDollars(requestedAmount, "100000000");
      else if (denomination !== "KOIN" || typeof requestedAmount !== "string" || !uint(requestedAmount)) throw Error("Positive purchase amount required");
      if (!this.journal) this.journal = new PurchaseQuoteJournal(this.directory, this.deployment);
      const request = { account, accountId, denomination, amount: requestedAmount, scope: this.scope, intentId };
      let saved = this.journal.lookup(request, this.clock());
      if (!saved) {
        const snapshot = await this.prices.readEvidence(), now = this.clock(), price = snapshot.price;
        if (snapshot.summary.pricingPolicyHash !== this.scope.pricingPolicyHash) throw Error("Price policy changed during quote");
        const amount = denomination === "USD" ? Q.nativeForDollars(requestedAmount, price.usdPerKoin) : requestedAmount;
        require("./purchase-price").assertPurchaseSize(price, amount);
        const priceDetails = Provenance.details({ schema: 1, kind: Provenance.KIND, nonce: crypto.randomBytes(32).toString("hex"), evidenceHash: snapshot.evidenceHash, summary: snapshot.summary });
        const quote = Q.draft({ account, amount, usdPerKoin: price.usdPerKoin, version: this.version, now,
          ttlMs: Math.min(Q.MAX_QUOTE_MS, price.expiresAt - now), id: Provenance.quoteId(priceDetails) });
        saved = this.journal.admit(request, { quote, priceDetails }, snapshot.evidence, now);
      }
      let args = saved.args || await Q.sign({ deployment: this.deployment, signer: this.signer, quote: saved.quote });
      await Q.verify(this.deployment, args, { now: this.clock(), version: this.version });
      // Save before responding. If this fails the admitted intent stays journaled;
      // a retry signs/reuses the same id rather than creating an untracked quote.
      if (!saved.args) args = this.journal.save(saved.quote.id, args, this.clock());
      await Q.verify(this.deployment, args, { now: this.clock(), version: this.version });
      Provenance.verify(args.purchase_quote, saved.priceDetails, { expectedPricingPolicyHash: this.scope.pricingPolicyHash });
      return { args, priceDetails: saved.priceDetails };
    } catch (error) {
      if (["PURCHASE_DEPTH_EXCEEDED", "PURCHASE_PRICE_UNAVAILABLE"].includes(error.code)) throw error;
      throw unavailable();
    }
  }
  close() { this.closed = true; this.journal?.close(); }
}
module.exports = { budget, PurchaseQuoteJournal, PurchaseQuoteIssuer };
