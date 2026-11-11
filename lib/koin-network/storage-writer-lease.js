"use strict";
const fs = require("node:fs"), os = require("node:os"), { DatabaseSync } = require("node:sqlite");
// Call while holding the corresponding JournalSet anchor lock when opening a
// writer. Read-only offline preflights may use expected=0 but are not a lock.
function assertWriterLeaseCount(directory, expected, label = "storage") {
  if (![0, 1].includes(expected)) throw Error("Explicit storage writer count required");
  const anchor = new DatabaseSync(fs.realpathSync(directory) + ".recovery-anchor.sqlite", { readOnly: true });
  try {
    let live = 0;
    for (const lease of anchor.prepare("SELECT host,pid FROM leases").all()) {
      if (lease.host !== os.hostname()) throw Error("Stop every " + label + " writer before opening storage");
      try { process.kill(lease.pid, 0); live++; }
      catch (error) { if (error.code !== "ESRCH") live++; }
    }
    if (live !== expected) throw Error("Stop every " + label + " writer before opening storage");
  } finally { anchor.close(); }
}
module.exports = { assertWriterLeaseCount };
