"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const DEFAULT_FILES = ["funding-recovery.sqlite", "wallet-nonces.sqlite"];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value);
function regular(file) {
  const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw Error("Regular journal file required");
}
function syncFile(file) { const fd = fs.openSync(file, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

// The anchor stays OUTSIDE the replaceable journal directory. It witnesses the
// newest committed generation; a backup cannot restore or reset that witness.
// An absent/lost witness requires separate disaster recovery, never an unlock.
class JournalSet {
  #anchor; #directory; #files; #lease; #id;
  constructor(directory, { files = DEFAULT_FILES, maintenance = false } = {}) {
    this.#directory = path.resolve(directory);
    if (!Array.isArray(files) || !files.length || files.length > 16 || files.some(f => !/^[a-z][a-z0-9-]{0,60}\.sqlite$/.test(f)) || new Set(files).size !== files.length) throw Error("Explicit journal file set required");
    this.#files = [...files].sort();
    fs.mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(this.#directory) !== this.#directory) throw Error("Journal symlink paths are not supported");
    const anchorFile = this.#directory + ".recovery-anchor.sqlite";
    if (!fs.existsSync(anchorFile) && this.#files.some(f => fs.existsSync(path.join(this.#directory, f)))) throw Error("Journal recovery anchor missing; do not initialize over existing records");
    if (maintenance && !fs.existsSync(anchorFile)) throw Error("Existing journal recovery anchor required");
    if (fs.existsSync(anchorFile)) regular(anchorFile);
    this.#anchor = new DatabaseSync(anchorFile); fs.chmodSync(anchorFile, 0o600);
    try {
      this.#anchor.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS anchor(id INTEGER PRIMARY KEY CHECK(id=1), pair_id TEXT NOT NULL, directory TEXT NOT NULL, files TEXT NOT NULL, generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ownership(id INTEGER PRIMARY KEY CHECK(id=1),host TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY, host TEXT NOT NULL, pid INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS attached_files(name TEXT PRIMARY KEY, generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY, generation INTEGER NOT NULL, manifest_hash TEXT NOT NULL);`);
      this.#locked(() => {
        let row = this.#anchor.prepare("SELECT * FROM anchor WHERE id=1").get();
        if (!row) {
          if (maintenance || this.#files.some(f => fs.existsSync(path.join(this.#directory, f)))) throw Error("Recovery anchor identity missing");
          this.#anchor.prepare("INSERT INTO anchor VALUES(1,?,?,?,0)").run(crypto.randomUUID(), this.#directory, json(this.#files));
          row = this.#anchor.prepare("SELECT * FROM anchor WHERE id=1").get();
        }
        if (row.directory !== this.#directory || row.files !== json(this.#files)) throw Error("Recovery anchor directory or journal set changed");
        const host = json({ hostname: os.hostname(), platform: process.platform, arch: process.arch });
        const owner = this.#anchor.prepare("SELECT host FROM ownership WHERE id=1").get();
        if (owner && owner.host !== host) throw Error("Journals belong to another host or operating system; reviewed migration required");
        if (!owner) this.#anchor.prepare("INSERT INTO ownership VALUES(1,?)").run(host);
        this.#id = row.pair_id;
        if (!maintenance) {
          this.#assertGeneration(); this.#lease = crypto.randomUUID();
          this.#anchor.prepare("INSERT INTO leases VALUES(?,?,?)").run(this.#lease, os.hostname(), process.pid);
        }
      });
    } catch (e) { this.#anchor.close(); throw e; }
  }
  #locked(fn) {
    this.#anchor.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#anchor.exec("COMMIT"); return result; }
    catch (e) { this.#anchor.exec("ROLLBACK"); throw e; }
  }
  #row() {
    const r = this.#anchor.prepare("SELECT * FROM anchor WHERE id=1").get();
    if (!r || (this.#id && r.pair_id !== this.#id) || !Number.isSafeInteger(r.generation) || r.generation < 0) throw Error("Damaged journal recovery anchor");
    return r;
  }
  #assertGeneration() {
    const anchor = this.#row(); let newest = 0;
    const expected = new Map(this.#anchor.prepare("SELECT * FROM attached_files").all().map(r => [r.name, r.generation]));
    for (const file of this.#files) {
      const p = path.join(this.#directory, file);
      if (!fs.existsSync(p)) {
        if (expected.has(file)) throw Error(file === "wallet-nonces.sqlite" ? "Shared wallet nonce journal missing; restore both journals" : "Tracked funding journal missing; restore both journals");
        continue;
      }
      regular(p); const db = new DatabaseSync(p, { readOnly: true });
      try {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery_generation'").get();
        if (!exists) throw Error("Journal generation missing; reviewed migration required");
        const r = db.prepare("SELECT * FROM recovery_generation WHERE id=1").get();
        if (!r || r.pair_id !== anchor.pair_id || !Number.isSafeInteger(r.generation) || r.generation < 0 || r.generation !== expected.get(file)) throw Error("Journal recovery generation mismatch; possible rollback");
        newest = Math.max(newest, r.generation);
      } finally { db.close(); }
    }
    if (newest !== anchor.generation) throw Error("Journal generation differs from recovery anchor; possible rollback or interrupted commit");
    return anchor;
  }
  #name(db) {
    const file = db.prepare("PRAGMA database_list").all().find(r => r.name === "main")?.file;
    if (!file || path.dirname(file) !== this.#directory || !this.#files.includes(path.basename(file))) throw Error("Database outside journal set");
    return path.basename(file);
  }
  attach(db) {
    this.#locked(() => {
      const name = this.#name(db);
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery_generation'").get();
      if (!exists) {
        if (db.prepare("SELECT 1 FROM identity LIMIT 1").get()) throw Error("Existing journal needs reviewed generation migration");
        db.exec("CREATE TABLE recovery_generation(id INTEGER PRIMARY KEY CHECK(id=1),pair_id TEXT NOT NULL,generation INTEGER NOT NULL)");
        db.prepare("INSERT INTO recovery_generation VALUES(1,?,0)").run(this.#id);
        this.#anchor.prepare("INSERT INTO attached_files VALUES(?,0)").run(name);
      }
    });
  }
  write(db, fn) {
    if (!this.#lease) throw Error("Journal writer lease required");
    return this.#locked(() => {
      const anchor = this.#assertGeneration(); db.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        const result = fn(), generation = anchor.generation + 1;
        if (!Number.isSafeInteger(generation)) throw Error("Journal generation exhausted");
        if (db.prepare("UPDATE recovery_generation SET generation=? WHERE id=1 AND pair_id=?").run(generation, this.#id).changes !== 1) throw Error("Journal generation identity changed");
        this.#anchor.prepare("UPDATE attached_files SET generation=? WHERE name=?").run(generation, this.#name(db));
        this.#anchor.prepare("UPDATE anchor SET generation=? WHERE id=1").run(generation);
        db.exec("COMMIT"); committed = true;
        return result;
      } catch (e) { if (!committed) db.exec("ROLLBACK"); throw e; }
      // A crash between the two commits produces a generation mismatch and
      // blocks signing. It never silently rolls the witness back to the backup.
    });
  }
  snapshot(destination) {
    const target = path.resolve(destination);
    if (target === this.#directory || target.startsWith(this.#directory + path.sep) || fs.existsSync(target)) throw Error("New external backup directory required");
    return this.#locked(() => {
      const anchor = this.#assertGeneration(), entries = [];
      fs.mkdirSync(target, { mode: 0o700 });
      try {
        for (const file of this.#files) {
          const source = path.join(this.#directory, file); regular(source);
          const db = new DatabaseSync(source, { readOnly: true }), output = path.join(target, file);
          try { db.prepare("VACUUM INTO ?").run(output); } finally { db.close(); }
          fs.chmodSync(output, 0o600); syncFile(output);
          entries.push({ name: file, sha256: hash(fs.readFileSync(output)), size: fs.statSync(output).size });
        }
        const manifest = { schema: 1, mode: "journal-backup", id: crypto.randomUUID(), pairId: this.#id, generation: anchor.generation,
          createdAt: Date.now(), files: entries };
        const text = json(manifest) + "\n", file = path.join(target, "manifest.json");
        fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 }); syncFile(file);
        this.#anchor.prepare("INSERT INTO backups VALUES(?,?,?)").run(manifest.id, anchor.generation, hash(text));
        return manifest;
      } catch (e) { fs.rmSync(target, { recursive: true, force: true }); throw e; }
    });
  }
  #inspect(directory) {
    const root = path.resolve(directory), file = path.join(root, "manifest.json"); regular(file);
    if (fs.statSync(file).size > 16384) throw Error("Backup manifest too large");
    const text = fs.readFileSync(file, "utf8"), m = JSON.parse(text), witness = this.#anchor.prepare("SELECT * FROM backups WHERE id=?").get(m.id);
    if (m.schema !== 1 || m.mode !== "journal-backup" || m.pairId !== this.#id || !witness || witness.manifest_hash !== hash(text) || witness.generation !== m.generation ||
        !Array.isArray(m.files) || json(m.files.map(f => f.name)) !== json(this.#files)) throw Error("Unrecognized or altered journal backup");
    for (const entry of m.files) {
      const p = path.join(root, entry.name); regular(p);
      if (fs.statSync(p).size !== entry.size || hash(fs.readFileSync(p)) !== entry.sha256) throw Error("Backup file checksum changed");
      const db = new DatabaseSync(p, { readOnly: true });
      try { if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Corrupt journal backup"); }
      finally { db.close(); }
    }
    const current = this.#row();
    return { ...m, currentGeneration: current.generation, restorable: m.generation === current.generation, requiresClosedWriters: true };
  }
  inspect(directory) { return this.#locked(() => this.#inspect(directory)); }
  restore(directory) {
    return this.#locked(() => {
      const m = this.#inspect(directory);
      if (!m.restorable) throw Error("Backup predates newer journal activity; restore cannot rewind payment history");
      // Remove only leases from demonstrably exited processes on THIS host.
      for (const lease of this.#anchor.prepare("SELECT * FROM leases").all()) {
        if (lease.host !== os.hostname()) continue;
        try { process.kill(lease.pid, 0); }
        catch (e) { if (e.code === "ESRCH") this.#anchor.prepare("DELETE FROM leases WHERE id=?").run(lease.id); }
      }
      if (this.#anchor.prepare("SELECT 1 FROM leases LIMIT 1").get()) throw Error("Close every journal writer before restoring");
      const prepared = [];
      try {
        for (const f of m.files) {
          const temp = path.join(this.#directory, f.name + ".restore-" + m.id);
          fs.copyFileSync(path.join(path.resolve(directory), f.name), temp, fs.constants.COPYFILE_EXCL); fs.chmodSync(temp, 0o600); syncFile(temp);
          prepared.push({ temp, file: path.join(this.#directory, f.name) });
        }
        for (const { temp, file } of prepared) {
          for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(file + suffix)) { regular(file + suffix); fs.unlinkSync(file + suffix); }
          fs.renameSync(temp, file);
        }
        this.#assertGeneration(); return { id: m.id, generation: m.generation, restored: true };
      } finally { for (const { temp } of prepared) if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    });
  }
  close() {
    if (this.#lease) { this.#locked(() => this.#anchor.prepare("DELETE FROM leases WHERE id=?").run(this.#lease)); this.#lease = null; }
    this.#anchor.close();
  }
}
module.exports = { JournalSet };
