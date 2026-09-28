"use strict";
const fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
const { JournalSet } = require("./journal-set"), P = require("./job-protocol");
// One persistent Test installation per wallet. There is deliberately no lease
// timeout or reset endpoint: going offline cannot authorize a second signer.
class TestHosts {
  constructor(directory, chainId) {
    this.guard = new JournalSet(directory, { files: ["test-hosts.sqlite"] });
    try {
      const file = path.join(directory, "test-hosts.sqlite"); this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS hosts(owner TEXT PRIMARY KEY,installation TEXT NOT NULL);`);
      this.guard.attach(this.db); const r = this.db.prepare("SELECT data FROM identity WHERE id=1").get();
      if (r && r.data !== chainId) throw Error("Test host lease chain changed");
      if (!r) this.guard.write(this.db, () => this.db.prepare("INSERT INTO identity VALUES(1,?)").run(chainId));
    } catch (e) { this.db?.close(); this.guard.close(); throw e; }
  }
  claim(owner, installation) {
    P.digest(installation);
    return this.guard.write(this.db, () => {
      const r = this.db.prepare("SELECT installation FROM hosts WHERE owner=?").get(owner);
      if (r && r.installation !== installation) throw Error("This Test wallet is already bound to another installation. Recover that installation or use a separately invited Test wallet");
      if (!r) this.db.prepare("INSERT INTO hosts VALUES(?,?)").run(owner, installation);
      return { owner, installation, granted: true };
    });
  }
  close() { this.db.close(); this.guard.close(); }
}
module.exports = { TestHosts };
