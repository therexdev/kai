"use strict";
// Test worker wrapper only. Production never imports or launches this file.
// Instrument the real worker-owned store without adding a live debug command.
const { workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const control = workerData.integrationFault;
if (!control || !(control.barrier instanceof SharedArrayBuffer) || typeof control.entry !== "string") throw Error("Explicit integration fixture required");
delete workerData.integrationFault;
const words = new Int32Array(control.barrier), { ShadowStore } = require("../../lib/koin-network/shadow-store"), policy = require("../../lib/koin-network/policy");
const armed = () => Atomics.compareExchange(words, 0, 1, 0) === 1;
const entered = () => { Atomics.store(words, 1, 1); Atomics.notify(words, 1); };
function hold({ cpu = false } = {}) {
  entered();
  if (cpu) {
    const deadline = performance.now() + 10000;
    while (!Atomics.load(words, 2)) if (performance.now() >= deadline) throw Error("Test CPU gate expired");
  } else if (Atomics.wait(words, 2, 0, 10000) === "timed-out") throw Error("Test commit gate expired");
  Atomics.store(words, 3, 1);
}
if (control.mode === "allocation") {
  const allocate = policy.allocate;
  policy.allocate = function (...args) { if (armed()) hold({ cpu: true }); return allocate.apply(this, args); };
} else if (control.mode === "before_commit") {
  const write = ShadowStore.prototype._write;
  ShadowStore.prototype._write = function (fn) { return write.call(this, () => { const result = fn(); if (armed()) hold(); return result; }); };
} else if (control.mode === "after_commit") {
  const ingest = ShadowStore.prototype.ingestPresenceBatch;
  ShadowStore.prototype.ingestPresenceBatch = function (...args) { const result = ingest.apply(this, args); if (armed()) hold(); return result; };
} else if (control.mode === "between_commits") {
  let ingesting = false;
  const ingest = ShadowStore.prototype.ingestPresenceBatch, exec = DatabaseSync.prototype.exec;
  ShadowStore.prototype.ingestPresenceBatch = function (...args) { ingesting = true; try { return ingest.apply(this, args); } finally { ingesting = false; } };
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (ingesting && sql === "COMMIT" && path.basename(this.prepare("PRAGMA database_list").get().file) === "shadow.sqlite" && armed()) hold();
    return result;
  };
} else if (control.mode === "checkpoint") {
  const evidence = ShadowStore.prototype.getManifestEvidence;
  ShadowStore.prototype.getManifestEvidence = function (...args) {
    if (armed()) {
      entered();
      const result = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      Atomics.store(words, 4, result.busy); Atomics.store(words, 3, 1);
    }
    return evidence.apply(this, args);
  };
} else throw Error("Unknown integration fixture mode");
require(control.entry);
