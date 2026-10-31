"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { DatabaseSync } = require("node:sqlite");
const D = require("./provider-device-protocol"), P = require("./job-protocol");
const { JournalSet } = require("./journal-set");
const PREFIX = "/koin/provider/device/";
// Only public certificates and replay records are stored here. Neither this
// service nor a provider device ever receives the reward wallet's private key.
class ProviderDevices {
  constructor({ directory, schedulerUrl, target, deployment, clock = Date.now, catalog = () => null, status = () => ({}) }) {
    Object.assign(this, { schedulerUrl, target: require("./session-delegation").target(target), deployment, clock, catalog, status });
    this.guard = new JournalSet(directory, { files: ["provider-devices.sqlite"] });
    try {
      const file = path.join(directory, "provider-devices.sqlite"); this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, wallet TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL, used INTEGER);
        CREATE TABLE IF NOT EXISTS authorizations(id TEXT PRIMARY KEY,wallet TEXT NOT NULL,device TEXT NOT NULL,expires INTEGER NOT NULL,revoked INTEGER,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS wallet_devices ON authorizations(wallet,device);
        CREATE TABLE IF NOT EXISTS presence(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS registration_proofs(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);`);
      this.guard.attach(this.db);
      const identity = JSON.stringify({ schedulerUrl, target: this.target }), saved = this.db.prepare("SELECT data FROM identity WHERE id=1").get();
      if (saved && saved.data !== identity) throw Error("Provider authorization deployment changed");
      if (!saved) this.write(() => this.db.prepare("INSERT INTO identity VALUES(1,?)").run(identity));
    } catch (e) { this.db?.close(); this.guard.close(); throw e; }
  }
  write(fn) { return this.guard.write(this.db, fn); }
  now() { return P.integer(this.clock()); }
  expected(wallet) { return { schedulerUrl: this.schedulerUrl, target: this.target, ...(wallet ? { wallet } : {}), now: this.now() }; }
  capabilities(catalogPolicyHash) { return { ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 }, schedulerUrl: this.schedulerUrl,
    target: this.target, deployment: this.deployment, catalog: this.catalog(catalogPolicyHash) }; }
  challenge(body) {
    if (!body || Object.keys(body).sort().join() !== "deviceId,publicKey,wallet") throw Error("Exact provider enrollment identity required");
    const now = this.now(), authorization = D.validateAuthorization({ schema: 1, purpose: "provider", schedulerUrl: this.schedulerUrl, target: this.target,
      wallet: body.wallet, deviceId: body.deviceId, publicKey: body.publicKey, challenge: crypto.randomBytes(32).toString("hex"), issuedAt: now,
      challengeExpiresAt: now + 300000, expiresAt: now + 2592000000, actions: [...D.ACTIONS] }, this.expected());
    this.write(() => {
      this.db.prepare("DELETE FROM challenges WHERE expires < ?").run(now - 300000);
      if (this.db.prepare("SELECT count(*) AS n FROM challenges WHERE wallet=? AND used IS NULL AND expires>=?").get(body.wallet, now).n >= 8 ||
          this.db.prepare("SELECT count(*) AS n FROM challenges").get().n >= 4096) throw Error("Provider enrollment is busy. Try again shortly.");
      this.db.prepare("INSERT INTO challenges VALUES(?,?,?,?,NULL)").run(authorization.challenge, authorization.wallet, authorization.challengeExpiresAt, JSON.stringify(authorization));
    });
    return { ok: true, authorization };
  }
  enroll(body) {
    if (!body || Object.keys(body).sort().join() !== "at,authorization,signature,walletSignature") throw Error("Exact approved provider authorization required");
    const encoded = "pd1." + Buffer.from(JSON.stringify(body)).toString("base64url");
    const verified = D.verifyAction(encoded, "register", D.authorizationHash(body.authorization), this.expected());
    const { authorization: a, authorizationId: id } = verified, data = JSON.stringify({ authorization: a, walletSignature: body.walletSignature });
    this.write(() => {
      const existing = this.db.prepare("SELECT * FROM authorizations WHERE id=?").get(id);
      if (existing) {
        if (existing.data !== data || existing.revoked !== null || existing.expires <= this.now()) throw Object.assign(Error("Provider authorization expired or revoked"), { status: 401, code: "PROVIDER_AUTHORIZATION_REQUIRED" });
        return; // Exact recovery after a lost response never consumes a new challenge.
      }
      const row = this.db.prepare("SELECT * FROM challenges WHERE id=?").get(a.challenge);
      if (!row || row.used !== null || row.expires <= this.now() || row.data !== JSON.stringify(a)) throw Object.assign(Error("Provider enrollment challenge expired or already used"), { status: 409, code: "PROVIDER_CHALLENGE_EXPIRED" });
      if (this.db.prepare("SELECT count(*) AS n FROM authorizations WHERE wallet=? AND revoked IS NULL AND expires>?").get(a.wallet, this.now()).n >= 32)
        throw Error("Too many authorized provider devices for this wallet");
      // Reauthorization retires only this device; other devices retain their
      // distinct credentials and all reward attribution remains the wallet.
      this.db.prepare("UPDATE authorizations SET revoked=? WHERE wallet=? AND device=? AND revoked IS NULL").run(this.now(), a.wallet, a.deviceId);
      this.db.prepare("INSERT INTO authorizations VALUES(?,?,?,?,NULL,?)").run(id, a.wallet, a.deviceId, a.expiresAt, data);
      this.db.prepare("UPDATE challenges SET used=? WHERE id=? AND used IS NULL").run(this.now(), a.challenge);
    });
    return { ok: true, authorizationId: id, deviceId: a.deviceId, wallet: a.wallet, expiresAt: a.expiresAt };
  }
  active(id, wallet, deviceId) {
    if (!/^[a-f0-9]{64}$/.test(id || "")) return false;
    const row = this.db.prepare("SELECT wallet,device,expires,revoked FROM authorizations WHERE id=?").get(id);
    return !!row && row.revoked === null && row.expires > this.now() && (!wallet || row.wallet === wallet) && (!deviceId || row.device === deviceId);
  }
  workerActive(worker) { return !worker?.providerAuthorization || this.active(worker.providerAuthorization, worker.address, worker.providerDeviceId); }
  verify(signature, action, digest, wallet, binding) {
    const checked = D.verifyAction(signature, action, digest, this.expected(wallet));
    if (!this.active(checked.authorizationId, checked.wallet, checked.deviceId)) throw Object.assign(Error("Provider device authorization expired or revoked. Enable earning again."), { status: 401, code: "PROVIDER_AUTHORIZATION_REQUIRED" });
    if (binding && (binding.providerAuthorization !== checked.authorizationId || binding.providerDeviceId !== checked.deviceId)) throw Error("Provider proof does not match the assigned device");
    return checked;
  }
  observePresence(signature, wallet, report) {
    const checked = this.verify(signature, "presence", require("./presence").presenceHash(wallet, this.schedulerUrl, report), wallet);
    if (Math.abs(report.at - this.now()) > 60000) throw Error("Expired provider presence");
    this.write(() => {
      const previous = this.db.prepare("SELECT data FROM presence WHERE id=?").get(checked.authorizationId);
      const old = previous && JSON.parse(previous.data);
      if (old && (report.at <= old.signedAt || (old.session === report.session && report.sequence <= old.sequence))) throw Error("Replayed provider presence");
      if (old && this.now() - old.at < 10000) throw Error("Provider presence rate exceeded");
      const data = JSON.stringify({ ...report, signedAt: report.at, at: this.now() });
      this.db.prepare("INSERT INTO presence VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(checked.authorizationId, data);
    });
    return checked;
  }
  presence(worker) {
    if (!worker?.providerAuthorization || !this.workerActive(worker)) return null;
    const row = this.db.prepare("SELECT data FROM presence WHERE id=?").get(worker.providerAuthorization);
    return row ? JSON.parse(row.data) : null;
  }
  register(body) {
    const checked = this.verify(body.signature, "register", D.registrationHash(body), body.address);
    if (Math.abs(body.ts - checked.at) > 5000) throw Error("Registration proof timestamp changed");
    this.write(() => {
      this.db.prepare("DELETE FROM registration_proofs WHERE expires<?").run(this.now());
      const proof = P.hash(body.signature);
      if (this.db.prepare("SELECT id FROM registration_proofs WHERE id=?").get(proof)) throw Error("Provider registration proof already used");
      this.db.prepare("INSERT INTO registration_proofs VALUES(?,?)").run(proof, this.now() + 120000);
    });
    return { providerAuthorization: checked.authorizationId, providerDeviceId: checked.deviceId };
  }
  revoke(signature) {
    const proof = D.decodeAction(signature), id = D.authorizationId(proof.authorization);
    const checked = D.verifyAction(signature, "revoke", D.hash("revoke:" + id), this.expected());
    const row = this.db.prepare("SELECT data FROM authorizations WHERE id=?").get(id);
    if (!row || JSON.parse(row.data).walletSignature !== proof.walletSignature) throw Error("Unknown provider authorization");
    this.write(() => this.db.prepare("UPDATE authorizations SET revoked=COALESCE(revoked,?) WHERE id=?").run(this.now(), id));
    return { ok: true, revoked: true, authorizationId: id, wallet: checked.wallet };
  }
  async handle(req, res) {
    const route = new URL(req.url, "http://scheduler").pathname;
    if (!route.startsWith(PREFIX)) return false;
    const send = (code, data) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
    try {
      if (route === PREFIX + "capabilities" && req.method === "GET") { send(200, this.capabilities(req.headers?.["x-kai-catalog-policy"])); return true; }
      if (req.method !== "POST") throw Error("POST required");
      let size = 0; const parts = []; for await (const part of req) { size += part.length; if (size > 16384) throw Error("Provider enrollment request too large"); parts.push(part); }
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")), action = route.slice(PREFIX.length); let result;
      if (action === "challenge") result = this.challenge(body);
      else if (action === "enroll") result = this.enroll(body);
      else if (["status", "revoke"].includes(action)) {
        if (!body || Object.keys(body).join() !== "signature") throw Error("Exact provider device proof required");
        if (action === "revoke") result = this.revoke(body.signature);
        else {
          const proof = D.decodeAction(body.signature), id = D.authorizationId(proof.authorization);
          const checked = this.verify(body.signature, "status", D.hash("status:" + id));
          result = { ok: true, ...this.status(checked.wallet, checked.deviceId), authorization: { id, deviceId: checked.deviceId, expiresAt: checked.authorization.expiresAt } };
        }
      } else { send(404, { ok: false, error: "Unknown provider device route" }); return true; }
      send(200, result);
    } catch (e) { send(e.status || 400, { ok: false, ...(e.code ? { code: e.code } : {}), error: String(e.message).slice(0, 220) }); }
    return true;
  }
  close() { this.db.close(); this.guard.close(); }
}
module.exports = { ProviderDevices };
