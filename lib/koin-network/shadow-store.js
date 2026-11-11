"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { DatabaseSync } = require("node:sqlite");
const { utils } = require("koilib"), P = require("./policy"), { JournalSet } = require("./journal-set");
const FILE = "shadow.sqlite", MODE = "sqlite-shadow", SCHEMA = 2, MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const json = JSON.stringify, hash = value => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) throw Error("JSON identity required");
  return value;
}
function integer(value, label = "time") { if (!Number.isSafeInteger(value) || value < 0) throw Error("Valid " + label + " required"); return value; }
function epochNumber(value) { const n = typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value; return integer(n, "epoch"); }
function capacityId(value) { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw Error("Valid capacity ID required"); return value; }
function regular(file) { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw Error("Regular shadow file required"); return s; }
function syncFile(file) { const fd = fs.openSync(file, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncDirectory(dir) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function sameFile(a, b) { return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(k => a[k] === b[k]); }
function boundedRead(file, limit, expected) {
  const initial = regular(file), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || !sameFile(initial, before) || (expected && !sameFile(expected, before))) throw Error("Legacy shadow source identity changed");
    if (!Number.isSafeInteger(before.size) || before.size > limit) throw Error("Legacy shadow exceeds offline migration size limit");
    const bytes = Buffer.alloc(before.size + 1); let read = 0, n;
    while (read < bytes.length && (n = fs.readSync(fd, bytes, read, bytes.length - read, null))) read += n;
    if (read !== before.size || !sameFile(before, fs.fstatSync(fd)) || !sameFile(before, regular(file))) throw Error("Legacy shadow source changed during bounded read");
    return { raw: bytes.subarray(0, read), stat: before };
  } finally { fs.closeSync(fd); }
}
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid shadow " + label); return value; }
function validateReport(address, report, acceptedAt) {
  integer(acceptedAt);
  if (!utils.isChecksumAddress(address) || !report || report.schema !== 1 || !Number.isSafeInteger(report.at) ||
      Math.abs(report.at - acceptedAt) > 60000 || !Number.isSafeInteger(report.sequence) || report.sequence < 0 ||
      typeof report.session !== "string" || !/^[a-f0-9]{32}$/.test(report.session)) throw Error("Invalid presence report");
  if (typeof report.model !== "string" || report.model.length > 100 || !(report.modelHash === "" || /^[a-f0-9]{64}$/.test(report.modelHash)) ||
      typeof report.ready !== "boolean") throw Error("Invalid model report");
}
function qualification(q, now) {
  integer(now); capacityId(q?.capacityId);
  if (!utils.isChecksumAddress(q?.address) || typeof q.model !== "string" || !q.model || q.model.length > 100 ||
      !/^[a-f0-9]{64}$/.test(q.modelHash) || !/^[a-f0-9]{64}$/.test(q.benchmarkHash)) throw Error("Verified benchmark identity required");
  if (!Number.isSafeInteger(q.expires) || q.expires <= now || q.expires > now + P.DAY || P.uint(q.modelWeight) === 0n) throw Error("Qualification must expire within a day");
  if (!Number.isInteger(q.coverageBps) || q.coverageBps < 7500 || q.coverageBps > 15000) throw Error("Invalid coverage");
  return { address: q.address, capacityId: q.capacityId, model: q.model, modelHash: q.modelHash, modelWeight: q.modelWeight,
    coverageBps: q.coverageBps, benchmarkHash: q.benchmarkHash, expires: q.expires, approvedAt: now };
}
function descriptorValid(value) {
  return value && Object.keys(value).sort().join() === "directory,identityHash,mode,schema,sourceHash,storeId,verificationHash" &&
    value.schema === SCHEMA && value.mode === MODE && typeof value.directory === "string" && path.isAbsolute(value.directory) &&
    /^[a-f0-9-]{36}$/.test(value.storeId) && [value.identityHash, value.sourceHash, value.verificationHash].every(v => /^[a-f0-9]{64}$/.test(v));
}

// Staged storage foundation. Nothing selects or activates this backend by
// default. JournalSet deliberately fails closed after a main/anchor commit
// interruption; that case requires reviewed recovery, not automatic rebasing.
// Runtime integration must enforce one writer lifecycle and drain the source
// outbox before advancing interval watermarks. Activation/downgrade fencing is
// external and is intentionally absent here. Reads keep history on disk, but
// one parsed interval and Policy.allocate's wallet/job sets still occupy RAM.
// Offline migration parses its bounded source while the service is drained;
// maxSourceBytes is an input limit, not a promise about expanded heap usage.
class ShadowStore {
  constructor(directory, { identity, clock = Date.now, create = false, staging = false, markerFile } = {}) {
    object(identity, "deployment identity");
    this.clock = clock; this.identity = canonical(identity); this.identityHash = hash(json(this.identity)); this.statements = new Map();
    const requested = path.resolve(directory), file = path.join(requested, FILE), anchor = requested + ".recovery-anchor.sqlite";
    if (create) {
      if (!staging || fs.existsSync(file) || fs.existsSync(anchor) || (fs.existsSync(requested) && fs.readdirSync(requested).length)) throw Error("New empty staging shadow directory required");
      fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
    } else {
      if (!fs.existsSync(file) || !fs.existsSync(anchor)) throw Error("Shadow database or recovery anchor missing; recovery required");
      regular(file); regular(anchor);
    }
    if (fs.lstatSync(requested).isSymbolicLink()) throw Error("Shadow directory symlinks are not supported");
    this.directory = fs.realpathSync(requested); this.file = path.join(this.directory, FILE);
    this.markerFile = markerFile && path.resolve(markerFile);
    let marker;
    if (!staging) {
      if (!this.markerFile || !fs.existsSync(this.markerFile) || regular(this.markerFile).size > 16384) throw Error("Explicit shadow activation marker required");
      marker = JSON.parse(fs.readFileSync(this.markerFile, "utf8"));
      if (!descriptorValid(marker) || marker.directory !== this.directory || marker.identityHash !== this.identityHash) throw Error("Shadow activation identity mismatch");
    }
    try {
      this.guard = new JournalSet(this.directory, { files: [FILE] });
      this.db = new DatabaseSync(this.file); fs.chmodSync(this.file, 0o600);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA foreign_keys=ON;");
      if (create) {
        this.db.exec(`
          CREATE TABLE identity(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
          CREATE TABLE days(epoch INTEGER PRIMARY KEY,budget TEXT NOT NULL,sealed INTEGER NOT NULL CHECK(sealed IN (0,1)),interval_count INTEGER NOT NULL,next_start INTEGER NOT NULL,last_end INTEGER,work_count INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX unsealed_days ON days(sealed,epoch);
          CREATE TABLE intervals(epoch INTEGER NOT NULL REFERENCES days(epoch),ordinal INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(epoch,ordinal));
          CREATE TRIGGER immutable_intervals_update BEFORE UPDATE ON intervals BEGIN SELECT RAISE(ABORT,'Immutable shadow interval'); END;
          CREATE TRIGGER immutable_intervals_delete BEFORE DELETE ON intervals BEGIN SELECT RAISE(ABORT,'Immutable shadow interval'); END;
          CREATE TRIGGER sealed_intervals_insert BEFORE INSERT ON intervals WHEN (SELECT sealed FROM days WHERE epoch=NEW.epoch)=1 BEGIN SELECT RAISE(ABORT,'Sealed shadow day'); END;
          CREATE TABLE work(epoch INTEGER NOT NULL REFERENCES days(epoch),ordinal INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(epoch,ordinal));
          CREATE TRIGGER sealed_work_insert BEFORE INSERT ON work WHEN (SELECT sealed FROM days WHERE epoch=NEW.epoch)=1 BEGIN SELECT RAISE(ABORT,'Sealed shadow day'); END;
          CREATE TRIGGER sealed_work_update BEFORE UPDATE ON work WHEN (SELECT sealed FROM days WHERE epoch=OLD.epoch)=1 BEGIN SELECT RAISE(ABORT,'Sealed shadow day'); END;
          CREATE TRIGGER sealed_work_delete BEFORE DELETE ON work WHEN (SELECT sealed FROM days WHERE epoch=OLD.epoch)=1 BEGIN SELECT RAISE(ABORT,'Sealed shadow day'); END;
          CREATE TABLE availability(epoch INTEGER NOT NULL REFERENCES days(epoch),address TEXT NOT NULL,atoms TEXT NOT NULL,PRIMARY KEY(epoch,address));
          CREATE TABLE work_totals(epoch INTEGER NOT NULL REFERENCES days(epoch),address TEXT NOT NULL,atoms TEXT NOT NULL,PRIMARY KEY(epoch,address));
          CREATE TABLE qualifications(capacity_id TEXT PRIMARY KEY,address TEXT NOT NULL,approved_at INTEGER NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL);
          CREATE INDEX qualifications_expiry ON qualifications(expires,approved_at);
          CREATE INDEX qualifications_wallet ON qualifications(address,expires);
          CREATE TABLE presence_latest(address TEXT PRIMARY KEY,observed_at INTEGER NOT NULL,retained_from INTEGER NOT NULL,data TEXT NOT NULL);
          CREATE TABLE presence_samples(address TEXT NOT NULL,observed_at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(address,observed_at));
          CREATE TABLE observations(address TEXT NOT NULL,ordinal INTEGER NOT NULL,observed_at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(address,ordinal));
          CREATE TABLE ingested_events(event_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,payload_hash TEXT NOT NULL,digest TEXT NOT NULL,outcome TEXT NOT NULL);
          CREATE UNIQUE INDEX source_event_sequence ON ingested_events(sequence);
          CREATE TABLE legacy_presence_receipts(address TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,accepted_at INTEGER NOT NULL,data TEXT NOT NULL);
        `);
        this.guard.attach(this.db);
        const data = { schema: SCHEMA, mode: MODE, storeId: crypto.randomUUID(), identityHash: this.identityHash, identity: this.identity,
          sourceHash: null, verificationHash: null, sourceFile: null, migration: "empty" };
        this._write(() => this._statement("INSERT INTO identity VALUES(1,?)").run(json(data)));
      }
      const saved = this._identity();
      if (saved.schema !== SCHEMA || saved.mode !== MODE || saved.identityHash !== this.identityHash || json(saved.identity) !== json(this.identity)) throw Error("Shadow deployment identity changed");
      if (marker && (saved.migration !== "verified" || json(canonical(marker)) !== json(canonical(this.descriptor())))) throw Error("Shadow activation does not match verified migration");
      this._write(() => require("./storage-writer-lease").assertWriterLeaseCount(this.directory, 1, "shadow storage"));
    } catch (error) { this.db?.close(); this.guard?.close(); throw error; }
  }
  _statement(sql) { if (this.closed) throw Error("Shadow store is closed"); let s = this.statements.get(sql); if (!s) { s = this.db.prepare(sql); this.statements.set(sql, s); } return s; }
  _identity() { const row = this._statement("SELECT data FROM identity WHERE id=1").get(); if (!row) throw Error("Shadow store identity missing"); return JSON.parse(row.data); }
  _write(fn) {
    if (this.writing) throw Error("Nested shadow transaction");
    this.writing = true; try { return this.guard.write(this.db, fn); } finally { this.writing = false; }
  }
  _read(fn) { if (this.writing) return fn(); this.db.exec("BEGIN"); try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  descriptor() {
    const saved = this._identity();
    return { schema: SCHEMA, mode: MODE, storeId: saved.storeId, directory: this.directory, identityHash: saved.identityHash,
      sourceHash: saved.sourceHash, verificationHash: saved.verificationHash };
  }
  getBudget(epoch) { const r = this._statement("SELECT budget FROM days WHERE epoch=?").get(epochNumber(epoch)); return r ? JSON.parse(r.budget) : null; }
  getQualification(id) { const r = this._statement("SELECT data FROM qualifications WHERE capacity_id=?").get(capacityId(id)); return r ? JSON.parse(r.data) : null; }
  listQualifications({ expiresAfter } = {}) {
    const rows = expiresAfter === undefined ? this._statement("SELECT data FROM qualifications ORDER BY rowid").iterate()
      : this._statement("SELECT data FROM qualifications WHERE expires>? ORDER BY rowid").iterate(integer(expiresAfter));
    return Array.from(rows, r => JSON.parse(r.data));
  }
  getPresence(address) { const r = this._statement("SELECT data FROM presence_latest WHERE address=?").get(address); return r ? JSON.parse(r.data) : null; }
  hasQualifiedCapacity(address, at = this.clock()) { return !!this._statement("SELECT 1 FROM qualifications WHERE address=? AND expires>? LIMIT 1").get(address, integer(at)); }
  qualificationProjection() {
    return this._statement("SELECT address,max(expires) AS expires FROM qualifications WHERE expires>? GROUP BY address ORDER BY address").all(integer(this.clock()));
  }
  getUnsealedEpochs() { return this._statement("SELECT epoch FROM days WHERE sealed=0 ORDER BY epoch").all().map(r => String(r.epoch)); }
  getDayProgress(epoch) {
    const r = this._statement("SELECT sealed,interval_count,next_start,last_end FROM days WHERE epoch=?").get(epochNumber(epoch));
    return { present: !!r, sealed: r?.sealed === 1, intervalCount: r?.interval_count || 0, nextStart: r?.next_start ?? null, lastIntervalEnd: r?.last_end ?? null };
  }
  _insertBudget(epoch, budget) {
    if (!Number.isSafeInteger(budget?.epoch) || budget.epoch !== epoch) throw Error("Shadow budget epoch mismatch");
    P.allocate({ budget, intervals: [], work: [] });
    this._statement("INSERT INTO days(epoch,budget,sealed,interval_count,next_start,last_end) VALUES(?,?,0,0,?,NULL)").run(epoch, json(budget), Math.ceil(budget.openedAt / 60000) * 60000);
  }
  importBudget(epoch, budget) {
    const n = epochNumber(epoch), old = this.getBudget(n);
    if (old) { if (json(old) !== json(budget)) throw Error("Existing shadow budget differs"); return false; }
    return this._write(() => { this._insertBudget(n, budget); return true; });
  }
  open(balance, { liabilities = "0" } = {}) {
    const budget = P.dailyBudget({ balance, liabilities, openedAt: this.clock() });
    if (this.getBudget(budget.epoch)) throw Error("Shadow budget already opened");
    this.importBudget(budget.epoch, budget); return budget;
  }
  qualify(q) {
    const row = qualification(q, this.clock());
    this._write(() => {
      const old = this.getQualification(row.capacityId);
      if ((!old || old.expires <= row.approvedAt) && this._statement("SELECT count(*) AS n FROM qualifications WHERE expires>?").get(row.approvedAt).n >= 10000) throw Error("Qualification capacity reached");
      this._putQualification(row);
    });
  }
  _putQualification(row) {
    this._statement("INSERT INTO qualifications VALUES(?,?,?,?,?) ON CONFLICT(capacity_id) DO UPDATE SET address=excluded.address,approved_at=excluded.approved_at,expires=excluded.expires,data=excluded.data")
      .run(row.capacityId, row.address, row.approvedAt, row.expires, json(row));
  }
  expireQualifications(ids, cutoff = this.clock()) {
    if (!Array.isArray(ids)) throw Error("Valid capacity IDs required"); ids.forEach(capacityId); integer(cutoff);
    const unique = [...new Set(ids)];
    if (!unique.some(id => this.getQualification(id)?.expires > cutoff)) return false;
    return this._write(() => { let changed = false; for (const id of unique) { const q = this.getQualification(id); if (q?.expires > cutoff) { q.expires = cutoff; this._putQualification(q); changed = true; } } return changed; });
  }
  applyQualificationRefresh({ retired = [], qualifications = [], cutoff } = {}) {
    const now = integer(this.clock()); integer(cutoff);
    if (cutoff > now || !Array.isArray(retired) || !Array.isArray(qualifications) || retired.length > 10000 || qualifications.length > 10000)
      throw Error("Bounded qualification refresh and nonfuture cutoff required");
    const ids = [...new Set(retired.map(capacityId))], rows = qualifications.map(q => qualification(q, now));
    if (new Set(rows.map(q => q.capacityId)).size !== rows.length || new Set([...ids, ...rows.map(q => q.capacityId)]).size > 10000)
      throw Error("Bounded unique qualification refresh required");
    return this._write(() => {
      let expired = 0;
      for (const id of ids) { const q = this.getQualification(id); if (q?.expires > cutoff) { q.expires = cutoff; this._putQualification(q); expired++; } }
      for (const row of rows) {
        const old = this.getQualification(row.capacityId);
        if ((!old || old.expires <= now) && this._statement("SELECT count(*) AS n FROM qualifications WHERE expires>?").get(now).n >= 10000)
          throw Error("Qualification capacity reached");
        this._putQualification(row);
      }
      return { retired: expired, qualified: rows.length };
    });
  }
  retireUnmatchedQualifications(models, verified) {
    if (!Array.isArray(models) || models.length > 64 || models.some(m => typeof m !== "string" || !m) || !Array.isArray(verified)) throw Error("Configured admission models and verified evidence required");
    const now = integer(this.clock()), selected = new Set(models), byCapacity = new Map();
    for (const q of verified) { const list = byCapacity.get(q.capacityId) || []; list.push(q); byCapacity.set(q.capacityId, list); }
    const retired = this.listQualifications({ expiresAfter: now }).filter(q => selected.has(q.model) && !(byCapacity.get(q.capacityId) || []).some(current =>
      ["address", "capacityId", "model", "modelHash", "benchmarkHash", "modelWeight", "coverageBps", "expires"].every(k => q[k] === current[k]))).map(q => q.capacityId);
    return this.expireQualifications(retired, now);
  }
  _presenceReason(address, report, acceptedAt) {
    const row = this._statement("SELECT data FROM presence_latest WHERE address=?").get(address), old = row && JSON.parse(row.data);
    if (old?.session === report.session && report.sequence <= old.sequence) return "Replayed presence";
    if (old && report.at <= old.signedAt) return "Stale presence";
    if (old && acceptedAt - old.at < 10000) return "Presence rate exceeded";
    if (!old && this._statement("SELECT count(*) AS n FROM presence_latest").get().n >= 10000) return "Presence capacity reached";
    return null;
  }
  _putPresence(address, report, acceptedAt) {
    const sample = { session: report.session, sequence: report.sequence, model: report.model, modelHash: report.modelHash, ready: report.ready, at: acceptedAt, signedAt: report.at };
    const old = this._statement("SELECT observed_at,retained_from FROM presence_latest WHERE address=?").get(address);
    if (old && acceptedAt <= old.observed_at) throw Error("KOIN shadow samples must be strictly chronological; original data was preserved");
    const pending = this._statement("SELECT min(next_start-45000) AS oldest FROM days WHERE sealed=0 AND next_start+60000 <= (epoch+1)*86400000").get().oldest;
    // Archived samples stay on disk. This logical boundary exactly preserves
    // legacy observe() pruning; old evidence cannot silently regain eligibility.
    const retainedFrom = Math.max(old?.retained_from || 0, Math.min(acceptedAt - 180000, pending ?? Infinity), 0);
    const data = json(sample);
    this._statement("INSERT INTO presence_samples VALUES(?,?,?)").run(address, acceptedAt, data);
    this._statement("INSERT INTO presence_latest VALUES(?,?,?,?) ON CONFLICT(address) DO UPDATE SET observed_at=excluded.observed_at,retained_from=excluded.retained_from,data=excluded.data")
      .run(address, acceptedAt, retainedFrom, data);
  }
  observe(address, report) {
    const acceptedAt = this.clock(); validateReport(address, report, acceptedAt);
    return this._write(() => {
      if (!this.hasQualifiedCapacity(address, acceptedAt)) throw Error("Capacity qualification required before shadow collection");
      const reason = this._presenceReason(address, report, acceptedAt); if (reason) throw Error(reason);
      this._putPresence(address, report, acceptedAt);
    });
  }
  _presenceEnvelope(event) {
    if (!event || event.schema !== 1 || typeof event.eventId !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(event.eventId) ||
        !/^[a-f0-9]{64}$/.test(event.digest) || typeof event.rewardQualified !== "boolean") throw Error("Valid durable presence event required");
    integer(event.sequence, "source sequence"); validateReport(event.address, event.report, event.acceptedAt);
    if (require("./provider-presence-outbox").presenceEventDigest(event) !== event.digest) throw Error("Durable presence event digest changed");
    // The source module verifies authentication and its signed-event digest.
    // This independent hash also binds every field when recovering an event ID.
    return hash(json(canonical(event)));
  }
  ingestPresence(event) { return this.ingestPresenceBatch([event])[0]; }
  ingestPresenceBatch(events) {
    if (!Array.isArray(events) || !events.length || events.length > 128) throw Error("Bounded durable presence batch required");
    const hashes = events.map(event => this._presenceEnvelope(event));
    return this._write(() => events.map((event, index) => {
      const existing = this._statement("SELECT payload_hash,outcome FROM ingested_events WHERE event_id=?").get(event.eventId);
      if (existing) { if (existing.payload_hash !== hashes[index]) throw Error("Durable presence event changed"); return JSON.parse(existing.outcome); }
      const newest = this._statement("SELECT max(sequence) AS n FROM ingested_events").get().n;
      if (event.sequence !== (newest ?? 0) + 1) throw Error("Durable presence events must be consumed in contiguous source order");
      const reason = event.rewardQualified ? this._presenceReason(event.address, event.report, event.acceptedAt) : "Capacity qualification required before shadow collection";
      const outcome = reason ? { applied: false, reason } : { applied: true };
      if (!reason) this._putPresence(event.address, event.report, event.acceptedAt);
      this._statement("INSERT INTO ingested_events VALUES(?,?,?,?,?)").run(event.eventId, event.sequence, hashes[index], event.digest, json(outcome));
      return outcome;
    }));
  }
  acceptLegacyPresence(body, { audience } = {}) {
    const { presenceHash, verifyPresence } = require("./presence");
    if (!body || typeof body.signature !== "string" || body.signature.length > 512) throw Error("Exact legacy presence proof required");
    const reportHash = presenceHash(body.address, audience, body.report).toString("hex");
    const eventId = hash(json(["KAI-LEGACY-PRESENCE-RECEIPT-V1", this.identityHash, audience, body.address, reportHash, body.signature]));
    const prior = this._statement("SELECT event_id,accepted_at FROM legacy_presence_receipts WHERE address=?").get(body.address);
    if (prior?.event_id === eventId) return { eventId, acceptedAt: prior.accepted_at, applied: true, duplicate: true };
    verifyPresence(body, audience, this.clock());
    const acceptedAt = integer(this.clock()); validateReport(body.address, body.report, acceptedAt);
    return this._write(() => {
      const existing = this._statement("SELECT event_id,accepted_at FROM legacy_presence_receipts WHERE address=?").get(body.address);
      if (existing?.event_id === eventId) return { eventId, acceptedAt: existing.accepted_at, applied: true, duplicate: true };
      if (!this.hasQualifiedCapacity(body.address, acceptedAt)) throw Error("Capacity qualification required before shadow collection");
      const reason = this._presenceReason(body.address, body.report, acceptedAt); if (reason) throw Error(reason);
      this._putPresence(body.address, body.report, acceptedAt);
      // One exact receipt per wallet: older reports remain replay-rejected once
      // a newer accepted legacy report replaces this bounded recovery record.
      this._statement("INSERT INTO legacy_presence_receipts VALUES(?,?,?,?) ON CONFLICT(address) DO UPDATE SET event_id=excluded.event_id,accepted_at=excluded.accepted_at,data=excluded.data")
        .run(body.address, eventId, acceptedAt, json({ address: body.address, report: body.report, signature: body.signature, audience }));
      return { eventId, acceptedAt, applied: true, duplicate: false };
    });
  }
  _window(address, start, end) {
    const latest = this._statement("SELECT retained_from FROM presence_latest WHERE address=?").get(address); if (!latest) return [];
    const first = this._statement("SELECT observed_at FROM presence_samples WHERE address=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 1").get(address, latest.retained_from, start);
    const last = this._statement("SELECT observed_at FROM presence_samples WHERE address=? AND observed_at>=? ORDER BY observed_at LIMIT 1").get(address, Math.max(end, latest.retained_from));
    if (!first || !last || last.observed_at > end + 45000) return [];
    return Array.from(this._statement("SELECT data FROM presence_samples WHERE address=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at").iterate(address, first.observed_at, last.observed_at), r => JSON.parse(r.data));
  }
  *_observations(address, end) { for (const row of this._statement("SELECT data FROM observations WHERE address=? AND observed_at<=? ORDER BY ordinal").iterate(address, end)) yield JSON.parse(row.data); }
  _appendInterval(epoch, interval, { imported = false } = {}) {
    const day = this._statement("SELECT * FROM days WHERE epoch=?").get(epoch);
    if (!day || day.sealed || (!imported && interval.start !== day.next_start) || interval.start < (day.last_end ?? JSON.parse(day.budget).openedAt)) throw Error("Invalid shadow interval append");
    const allocation = P.allocate({ budget: JSON.parse(day.budget), intervals: [interval], work: [] });
    this._statement("INSERT INTO intervals VALUES(?,?,?,?,?)").run(epoch, day.interval_count, interval.start, interval.end, json(interval));
    for (const row of allocation.allocations) {
      const old = this._statement("SELECT atoms FROM availability WHERE epoch=? AND address=?").get(epoch, row.address);
      const amount = String(P.add(old?.atoms || "0", row.availability));
      this._statement("INSERT INTO availability VALUES(?,?,?) ON CONFLICT(epoch,address) DO UPDATE SET atoms=excluded.atoms").run(epoch, row.address, amount);
    }
    this._statement("UPDATE days SET interval_count=interval_count+1,next_start=?,last_end=? WHERE epoch=?").run(interval.end, interval.end, epoch);
  }
  tick({ maxIntervals = 120, currentFirst = false } = {}) {
    if (!Number.isInteger(maxIntervals) || maxIntervals < 1 || maxIntervals > 120 || typeof currentFirst !== "boolean") throw Error("Bounded shadow tick required");
    const now = integer(this.clock()), watermark = Math.floor((now - 45001) / 60000) * 60000;
    const due = this._statement("SELECT 1 FROM days WHERE sealed=0 AND next_start+60000<=min(?,(epoch+1)*86400000) LIMIT 1").get(watermark);
    if (!due) return;
    this._write(() => {
      let remaining = maxIntervals;
      const collect = (day, quota = remaining) => {
        const limit = Math.min(watermark, (day.epoch + 1) * P.DAY);
        for (let start = day.next_start; start + 60000 <= limit && remaining > 0 && quota > 0; start += 60000, remaining--, quota--) {
          const end = start + 60000, slots = []; let wallet, samples, reliability;
          for (const row of this._statement("SELECT address,data FROM qualifications WHERE approved_at<=? AND expires>=? ORDER BY address,capacity_id").iterate(start, end)) {
            const q = JSON.parse(row.data);
            if (wallet !== row.address) { wallet = row.address; samples = this._window(wallet, start, end); reliability = null; }
            if (!samples.length || samples.some((p, i) => !p.ready || p.model !== q.model || p.modelHash !== q.modelHash ||
                (i > 0 && (p.at - samples[i - 1].at > 45000 || p.session !== samples[i - 1].session)))) continue;
            reliability ??= P.reliability(this._observations(wallet, end), end);
            slots.push({ ...q, verified: true, eligible: true, reliabilityBps: reliability });
          }
          slots.sort((a, b) => a.address.localeCompare(b.address) || a.capacityId.localeCompare(b.capacityId));
          this._appendInterval(day.epoch, { start, end, slots });
        }
      };
      if (currentFirst) {
        const currentEpoch = Math.floor(now / P.DAY);
        const current = () => this._statement("SELECT epoch,next_start FROM days WHERE epoch=? AND sealed=0 AND next_start+60000<=min(?,(epoch+1)*86400000)").get(currentEpoch, watermark);
        const day = current(); if (day) collect(day, Math.min(4, remaining));
        if (remaining) for (const historical of this._statement("SELECT epoch,next_start FROM days WHERE epoch<>? AND sealed=0 AND next_start+60000<=min(?,(epoch+1)*86400000) ORDER BY epoch").iterate(currentEpoch, watermark)) {
          collect(historical); if (!remaining) break;
        }
        const rest = remaining && current(); if (rest) collect(rest);
      } else {
        for (const day of this._statement("SELECT epoch,next_start FROM days WHERE sealed=0 AND next_start+60000<=min(?,(epoch+1)*86400000) ORDER BY epoch").iterate(watermark)) {
          collect(day); if (!remaining) break;
        }
      }
    });
  }
  *iterateClosedIntervals(epoch) { for (const r of this._statement("SELECT data FROM intervals WHERE epoch=? ORDER BY ordinal").iterate(epochNumber(epoch))) yield JSON.parse(r.data); }
  *iterateWork(epoch) { for (const r of this._statement("SELECT data FROM work WHERE epoch=? ORDER BY ordinal").iterate(epochNumber(epoch))) yield JSON.parse(r.data); }
  getClosedEvidence(epoch) {
    return this._read(() => { const budget = this.getBudget(epoch); if (!budget) throw Error("Shadow day is unavailable"); return { budget, intervals: [...this.iterateClosedIntervals(epoch)], work: [...this.iterateWork(epoch)] }; });
  }
  _evidenceHash(epoch) {
    const row = this._statement("SELECT budget FROM days WHERE epoch=?").get(epoch); if (!row) throw Error("Shadow day is unavailable");
    const digest = crypto.createHash("sha256").update('{"budget":').update(row.budget).update(',"intervals":['); let separator = "";
    for (const r of this._statement("SELECT data FROM intervals WHERE epoch=? ORDER BY ordinal").iterate(epoch)) { digest.update(separator).update(r.data); separator = ","; }
    digest.update('],"work":['); separator = "";
    for (const r of this._statement("SELECT data FROM work WHERE epoch=? ORDER BY ordinal").iterate(epoch)) { digest.update(separator).update(r.data); separator = ","; }
    return digest.update("]}").digest("hex");
  }
  getManifestEvidence(epoch, { workBasis } = {}) {
    const n = epochNumber(epoch);
    return this._read(() => ({ evidenceHash: this._evidenceHash(n), allocation: P.allocate({ budget: this.getBudget(n), intervals: this.iterateClosedIntervals(n), work: this.iterateWork(n), workBasis }) }));
  }
  getAvailability(epoch, address) {
    const n = epochNumber(epoch), day = this._statement("SELECT budget,last_end FROM days WHERE epoch=?").get(n);
    if (!day) return { availability: null, asOf: null };
    const row = this._statement("SELECT atoms FROM availability WHERE epoch=? AND address=?").get(n, address);
    return { availability: row?.atoms || "0", asOf: day.last_end ?? JSON.parse(day.budget).openedAt };
  }
  _indexWork(epoch, budget, work) {
    const allocation = P.allocate({ budget, intervals: [], work });
    this._statement("DELETE FROM work_totals WHERE epoch=?").run(epoch);
    for (const row of allocation.allocations) this._statement("INSERT INTO work_totals VALUES(?,?,?)").run(epoch, row.address, row.work);
  }
  commitWork(epoch, work) {
    const n = epochNumber(epoch), day = this._statement("SELECT * FROM days WHERE epoch=?").get(n);
    if (!day || !Array.isArray(work)) throw Error("Shadow day and verified work required");
    const encoded = work.map(json), existing = this._statement("SELECT data FROM work WHERE epoch=? ORDER BY ordinal").all(n);
    if (encoded.length === existing.length && encoded.every((v, i) => v === existing[i].data)) return false;
    return this._write(() => { const current = this._statement("SELECT budget,sealed FROM days WHERE epoch=?").get(n);
      if (current.sealed) throw Error("Sealed shadow evidence cannot change");
      P.allocate({ budget: JSON.parse(current.budget), intervals: this.iterateClosedIntervals(n), work: encoded.map(data => JSON.parse(data)) });
      this._statement("DELETE FROM work WHERE epoch=?").run(n); encoded.forEach((data, i) => this._statement("INSERT INTO work VALUES(?,?,?)").run(n, i, data));
      this._indexWork(n, JSON.parse(current.budget), encoded.map(data => JSON.parse(data)));
      this._statement("UPDATE days SET work_count=? WHERE epoch=?").run(encoded.length, n); return true; });
  }
  markSealed(epoch) { return this.markSealedMany([epoch]) > 0; }
  markSealedMany(epochs) {
    if (!Array.isArray(epochs)) throw Error("Shadow epochs required"); const unique = [...new Set(epochs.map(epochNumber))], pending = [];
    for (const n of unique) { const day = this.getDayProgress(n); if (!day.present) throw Error("Shadow day is unavailable"); if (!day.sealed) pending.push(n); }
    if (!pending.length) return 0;
    return this._write(() => { let changed = 0; for (const n of pending) changed += this._statement("UPDATE days SET sealed=1 WHERE epoch=? AND sealed=0").run(n).changes; return changed; });
  }
  status(address) {
    const now = this.clock(), epoch = Math.floor(now / P.DAY), budget = this.getBudget(epoch), presence = this.getPresence(address);
    const qualified = presence?.ready && presence.at > now - 90000 && this._statement("SELECT data FROM qualifications WHERE address=? AND expires>? ORDER BY rowid").all(address, now)
      .some(r => { const q = JSON.parse(r.data); return q.model === presence.model && q.modelHash === presence.modelHash; });
    const a = budget && this._statement("SELECT atoms FROM availability WHERE epoch=? AND address=?").get(epoch, address);
    const work = budget && this._statement("SELECT atoms FROM work_totals WHERE epoch=? AND address=?").get(epoch, address);
    return { schema: 1, mode: "shadow", asset: "KOIN", paymentsEnabled: false, claimable: null, usageCredit: null,
      estimate: a || work ? { availability: a?.atoms || "0", work: work?.atoms || "0", simulated: true } : null,
      qualification: qualified ? "qualified-shadow" : presence ? "awaiting-verification" : "unreported", model: presence?.model || null, budget, policy: P.DEFAULTS, asOf: now };
  }
  manifest(epoch) {
    const n = epochNumber(epoch); if (n >= Math.floor(this.clock() / P.DAY)) throw Error("Closed shadow day required");
    const budget = this.getBudget(n); if (!budget) throw Error("Closed shadow day required");
    const data = { schema: 1, mode: "shadow", epoch, budget, ...this.getManifestEvidence(n).allocation };
    return { ...data, hash: hash(json(data)) };
  }
  _verifyMigratedRecords(state) {
    const expected = crypto.createHash("sha256"), actual = crypto.createHash("sha256"), counts = { qualifications: 0, presence: 0, samples: 0, observations: 0 };
    const update = (digest, kind, key, value) => digest.update(kind + "\0").update(json([key, canonical(value)])).update("\n");
    for (const [id, q] of Object.entries(state.qualifications)) { update(expected, "qualification", id, q); counts.qualifications++; }
    for (const r of this._statement("SELECT capacity_id,data FROM qualifications ORDER BY rowid").iterate()) update(actual, "qualification", r.capacity_id, JSON.parse(r.data));
    for (const [address, p] of Object.entries(state.presence)) {
      const { samples = [], ...latest } = p; update(expected, "presence", address, latest); counts.presence++;
      for (const sample of samples) { update(expected, "sample", address, sample); counts.samples++; }
    }
    for (const r of this._statement("SELECT address,data FROM presence_latest ORDER BY rowid").iterate()) {
      update(actual, "presence", r.address, JSON.parse(r.data));
      for (const sample of this._statement("SELECT data FROM presence_samples WHERE address=? ORDER BY observed_at").iterate(r.address)) update(actual, "sample", r.address, JSON.parse(sample.data));
    }
    for (const [address, rows] of Object.entries(state.observations)) for (const row of rows) { update(expected, "observation", address, row); counts.observations++; }
    for (const r of this._statement("SELECT address,data FROM observations ORDER BY rowid").iterate()) update(actual, "observation", r.address, JSON.parse(r.data));
    const expectedHash = expected.digest("hex"), actualHash = actual.digest("hex");
    if (expectedHash !== actualHash) throw Error("Legacy shadow record migration equivalence failed");
    return { ...counts, hash: actualHash };
  }
  close() { if (this.closed) return; this.statements.clear(); this.db.close(); this.guard.close(); this.closed = true; }

  static migrateLegacy({ sourceFile, directory, identity, clock = Date.now, maxSourceBytes = MAX_SOURCE_BYTES }) {
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > MAX_SOURCE_BYTES) throw Error("Bounded offline migration size required");
    const source = path.resolve(sourceFile), { raw, stat } = boundedRead(source, maxSourceBytes), sourceHash = hash(raw), state = JSON.parse(raw.toString("utf8"));
    if (state.schema !== 1 || state.mode !== "shadow") throw Error("Invalid legacy shadow ledger");
    for (const field of ["qualifications", "presence", "observations", "budgets", "days"]) object(state[field], field);
    if (state.qualificationHistory !== undefined) throw Error("Qualification history needs a separately reviewed migration");
    const store = new ShadowStore(directory, { identity, clock, create: true, staging: true });
    try {
      const backup = path.join(store.directory, "legacy-koin-shadow.json"); fs.writeFileSync(backup, raw, { flag: "wx", mode: 0o600 }); syncFile(backup); fs.chmodSync(backup, 0o400); syncFile(backup); syncDirectory(store.directory);
      const epochs = Object.keys(state.budgets).map(epochNumber).sort((a, b) => a - b), verification = [];
      if (Object.keys(state.days).some(e => !Object.hasOwn(state.budgets, e))) throw Error("Orphan legacy shadow day");
      store._write(() => {
        for (const [id, q] of Object.entries(state.qualifications)) {
          if (capacityId(id) !== q?.capacityId || !utils.isChecksumAddress(q.address)) throw Error("Invalid legacy qualification");
          integer(q.approvedAt); integer(q.expires); P.uint(q.modelWeight); store._putQualification(q);
        }
        for (const [address, p] of Object.entries(state.presence)) {
          if (!utils.isChecksumAddress(address)) throw Error("Invalid legacy presence address"); object(p, "presence");
          const { samples = [], ...latest } = p; if (!Array.isArray(samples)) throw Error("Invalid legacy sample history");
          let previous = -1;
          for (const sample of samples) {
            if (!sample || !Number.isSafeInteger(sample.at) || sample.at < 0 || sample.at <= previous) throw Error("Legacy samples must be strictly chronological; original data was preserved");
            previous = sample.at; store._statement("INSERT INTO presence_samples VALUES(?,?,?)").run(address, sample.at, json(sample));
          }
          integer(latest.at); if (previous > latest.at) throw Error("Legacy presence latest precedes its sample history");
          store._statement("INSERT INTO presence_latest VALUES(?,?,0,?)").run(address, latest.at, json(latest));
        }
        for (const [address, rows] of Object.entries(state.observations)) {
          if (!Array.isArray(rows)) throw Error("Invalid legacy observations");
          rows.forEach((row, i) => { integer(row.at); if (typeof row.success !== "boolean") throw Error("Invalid legacy observation"); store._statement("INSERT INTO observations VALUES(?,?,?,?)").run(address, i, row.at, json(row)); });
        }
        for (const epoch of epochs) {
          const budget = state.budgets[epoch], day = state.days[epoch]; if (!day || !Array.isArray(day.intervals) || !Array.isArray(day.work) || (day.sealed !== undefined && typeof day.sealed !== "boolean")) throw Error("Incomplete or invalid legacy shadow day");
          store._insertBudget(epoch, budget);
          for (const interval of day.intervals) store._appendInterval(epoch, interval, { imported: true });
          day.work.forEach((row, i) => store._statement("INSERT INTO work VALUES(?,?,?)").run(epoch, i, json(row)));
          store._indexWork(epoch, budget, day.work);
          store._statement("UPDATE days SET work_count=?,sealed=? WHERE epoch=?").run(day.work.length, day.sealed === true ? 1 : 0, epoch);
          const evidence = { budget, intervals: day.intervals, work: day.work }, evidenceHash = hash(json(evidence)), targetHash = store._evidenceHash(epoch);
          const allocation = P.allocate(evidence), migrated = P.allocate({ budget: store.getBudget(epoch), intervals: store.iterateClosedIntervals(epoch), work: store.iterateWork(epoch) });
          const usd = P.allocate({ ...evidence, workBasis: "usd-pool" }), migratedUsd = P.allocate({ budget: store.getBudget(epoch), intervals: store.iterateClosedIntervals(epoch), work: store.iterateWork(epoch), workBasis: "usd-pool" });
          if (evidenceHash !== targetHash || json(allocation) !== json(migrated) || json(usd) !== json(migratedUsd)) throw Error("Legacy shadow migration equivalence failed");
          const exactAvailability = P.allocate({ budget, intervals: day.intervals, work: [] }).allocations.map(r => ({ address: r.address, atoms: r.availability }));
          const indexedAvailability = store._statement("SELECT address,atoms FROM availability WHERE epoch=?").all(epoch).map(r => ({ ...r })).sort((a, b) => a.address.localeCompare(b.address, "en"));
          const exactWork = P.allocate({ budget, intervals: [], work: day.work }).allocations.map(r => ({ address: r.address, atoms: r.work }));
          const indexedWork = store._statement("SELECT address,atoms FROM work_totals WHERE epoch=?").all(epoch).map(r => ({ ...r })).sort((a, b) => a.address.localeCompare(b.address, "en"));
          if (json(exactAvailability) !== json(indexedAvailability) || json(exactWork) !== json(indexedWork)) throw Error("Legacy shadow indexed totals differ");
          verification.push({ epoch, evidenceHash, allocationHash: hash(json(allocation)), usdAllocationHash: hash(json(usd)), intervalCount: day.intervals.length, workCount: day.work.length, sealed: day.sealed === true });
        }
        if (hash(boundedRead(source, maxSourceBytes, stat).raw) !== sourceHash || hash(boundedRead(backup, maxSourceBytes).raw) !== sourceHash) throw Error("Legacy shadow changed during offline migration");
        const records = store._verifyMigratedRecords(state);
        const saved = store._identity(); Object.assign(saved, { sourceFile: source, sourceHash, verificationHash: hash(json({ epochs: verification, records })), migration: "verified", verification, records });
        store._statement("UPDATE identity SET data=? WHERE id=1").run(json(saved));
      });
      if (store._statement("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Shadow migration database verification failed");
      const descriptor = store.descriptor(); syncDirectory(store.directory);
      return { descriptor, verification, recordVerification: store._identity().records, sourceBytes: raw.length, legacyBackup: backup, activated: false };
    } finally { store.close(); }
  }
}
module.exports = { ShadowStore, SHADOW_STORE_SCHEMA: SCHEMA, SHADOW_STORE_FILE: FILE, MAX_SOURCE_BYTES };
