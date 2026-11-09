"use strict";
const crypto = require("node:crypto");
const { presenceHash } = require("./presence");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MAX_PENDING = 8192, MAX_BATCH = 128;
function damagedPresenceStorage() { return Object.assign(Error("Damaged provider presence storage"), { status: 503, code: "PROVIDER_PRESENCE_STORAGE_INVALID" }); }
function presenceEventDigest(e) {
  return hash(["KAI-PROVIDER-PRESENCE-OUTBOX-V1", e.schema, e.eventId, e.address, e.report, e.acceptedAt,
    e.rewardQualified, e.sequence, e.authorizationId, e.deviceId, e.authorization, e.proofAt, e.signature]);
}
function canonicalReport(r) {
  return { schema: r.schema, session: r.session, sequence: r.sequence, at: r.at, model: r.model, modelHash: r.modelHash, ready: r.ready };
}
function eventId(schedulerUrl, target, authorizationId, digest, signature) {
  return hash(["KAI-PROVIDER-PRESENCE-EVENT-V1", schedulerUrl, target, authorizationId, digest.toString("hex"), signature]);
}
function bound(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw Error("Invalid provider presence " + name);
  return value;
}
function assertPresenceActivationIsExclusive(directory) {
  // Called while JournalSet holds its anchor write lock. A newly starting old
  // writer waits for that lock and then fails the activated identity check.
  require("./storage-writer-lease").assertWriterLeaseCount(directory, 1, "provider device");
}
// The owner invokes create/append/acknowledge within its existing guarded SQLite
// transaction. No outbox action advances or repairs the separate recovery anchor.
// Pending events are bounded globally. Acknowledgment deletes delivered events;
// only the latest receipt per authorization remains. Older delivered reports are
// replay-rejected once a newer report commits, rather than retained indefinitely.
class ProviderPresenceOutbox {
  constructor(db, schedulerUrl, target, maxPending = MAX_PENDING) {
    this.db = db; this.schedulerUrl = schedulerUrl; this.target = target;
    this.maxPending = bound(maxPending, MAX_PENDING, "queue limit");
  }
  create() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS presence_outbox_state(id INTEGER PRIMARY KEY CHECK(id=1),next_sequence INTEGER NOT NULL,last_accepted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS presence_outbox(sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,authorization_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS presence_receipts(authorization_id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL,delivered INTEGER NOT NULL);
      INSERT OR IGNORE INTO presence_outbox_state VALUES(1,1,0);`);
  }
  decode(row) {
    let e;
    try {
      e = JSON.parse(row.data);
      if (e.schema !== 1 || !Number.isSafeInteger(e.sequence) || e.sequence < 1 ||
        !Number.isSafeInteger(e.acceptedAt) || e.acceptedAt < 0 || typeof e.rewardQualified !== "boolean" ||
        e.eventId !== row.event_id || e.authorizationId !== row.authorization_id ||
        (row.sequence !== undefined && row.sequence !== e.sequence) || e.digest !== presenceEventDigest(e) ||
        e.eventId !== eventId(this.schedulerUrl, this.target, e.authorizationId, presenceHash(e.address, this.schedulerUrl, e.report), e.signature))
        throw damagedPresenceStorage();
    } catch (_) { throw damagedPresenceStorage(); }
    return e;
  }
  find(authorizationId, id) {
    const row = this.db.prepare("SELECT * FROM presence_outbox WHERE event_id=?").get(id) ||
      this.db.prepare("SELECT * FROM presence_receipts WHERE authorization_id=? AND event_id=?").get(authorizationId, id);
    return row ? this.decode(row) : null;
  }
  append(checked, signature, report, acceptedAt, rewardQualified, id) {
    if (typeof rewardQualified !== "boolean") throw Error("Acceptance-time provider reward eligibility required");
    const state = this.db.prepare("SELECT * FROM presence_outbox_state WHERE id=1").get();
    if (!state || !Number.isSafeInteger(state.next_sequence) || state.next_sequence < 1 || state.next_sequence >= Number.MAX_SAFE_INTEGER)
      throw damagedPresenceStorage();
    if (!Number.isSafeInteger(state.last_accepted_at) || acceptedAt < state.last_accepted_at)
      throw Object.assign(Error("Provider presence clock moved backwards"), { status: 503, code: "PROVIDER_PRESENCE_CLOCK" });
    if (this.db.prepare("SELECT count(*) AS n FROM presence_outbox").get().n >= this.maxPending)
      throw Object.assign(Error("Provider presence delivery is busy. Retry this report shortly."), { status: 503, code: "PROVIDER_PRESENCE_BACKPRESSURE" });
    const e = { schema: 1, eventId: id, address: checked.wallet, report: canonicalReport(report), acceptedAt, rewardQualified,
      sequence: state.next_sequence, authorizationId: checked.authorizationId, deviceId: checked.deviceId,
      authorization: checked.authorization, proofAt: checked.at, signature };
    e.digest = presenceEventDigest(e);
    const data = JSON.stringify(e);
    this.db.prepare("INSERT INTO presence_outbox VALUES(?,?,?,?)").run(e.sequence, e.eventId, e.authorizationId, data);
    this.db.prepare("INSERT INTO presence_receipts VALUES(?,?,?,0) ON CONFLICT(authorization_id) DO UPDATE SET event_id=excluded.event_id,data=excluded.data,delivered=0")
      .run(e.authorizationId, e.eventId, data);
    this.db.prepare("UPDATE presence_outbox_state SET next_sequence=?,last_accepted_at=? WHERE id=1").run(e.sequence + 1, acceptedAt);
    return e;
  }
  pending(limit = 64) {
    return this.db.prepare("SELECT * FROM presence_outbox ORDER BY sequence LIMIT ?").all(bound(limit, MAX_BATCH, "batch limit")).map(row => this.decode(row));
  }
  acknowledge(receipts) {
    if (!Array.isArray(receipts) || !receipts.length || receipts.length > MAX_BATCH) throw Error("Bounded provider presence acknowledgments required");
    let acknowledged = 0;
    for (const r of receipts) {
      if (!r || !/^[a-f0-9]{64}$/.test(r.eventId || "") || !/^[a-f0-9]{64}$/.test(r.digest || "")) throw Error("Exact provider presence receipt required");
      const row = this.db.prepare("SELECT * FROM presence_outbox WHERE event_id=?").get(r.eventId);
      if (!row) {
        const latest = this.db.prepare("SELECT * FROM presence_receipts WHERE event_id=?").get(r.eventId);
        if (latest && this.decode(latest).digest !== r.digest) throw Error("Provider presence acknowledgment digest changed");
        continue; // Repeating an already committed acknowledgment is a no-op.
      }
      const event = this.decode(row);
      if (event.digest !== r.digest) throw Error("Provider presence acknowledgment digest changed");
      if (this.db.prepare("SELECT event_id FROM presence_outbox ORDER BY sequence LIMIT 1").get().event_id !== r.eventId)
        throw Error("Provider presence acknowledgments must follow source order");
      this.db.prepare("DELETE FROM presence_outbox WHERE event_id=?").run(r.eventId);
      this.db.prepare("UPDATE presence_receipts SET delivered=1 WHERE event_id=?").run(r.eventId);
      acknowledged++;
    }
    return { acknowledged, pending: this.db.prepare("SELECT count(*) AS n FROM presence_outbox").get().n };
  }
  status() {
    const first = this.db.prepare("SELECT * FROM presence_outbox ORDER BY sequence LIMIT 1").get();
    const state = this.db.prepare("SELECT * FROM presence_outbox_state WHERE id=1").get();
    return { enabled: true, pending: this.db.prepare("SELECT count(*) AS n FROM presence_outbox").get().n, limit: this.maxPending,
      nextSequence: state.next_sequence, lastAcceptedAt: state.last_accepted_at, oldestAcceptedAt: first ? this.decode(first).acceptedAt : null };
  }
}
module.exports = { ProviderPresenceOutbox, presenceEventDigest, canonicalReport, eventId, assertPresenceActivationIsExclusive, damagedPresenceStorage, MAX_PENDING, MAX_BATCH };
