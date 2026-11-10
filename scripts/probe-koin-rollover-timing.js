"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { readTiming } = require("../deploy/koin-mainnet/diagnose-rollover-timing");
const DAY = 86400000, epoch = 20767, boundary = epoch * DAY, now = boundary + 3600000;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rollover-timing-")), file = path.join(directory, "cycle.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE steps(epoch TEXT, method TEXT, state TEXT, tx_id TEXT, data TEXT, UNIQUE(epoch,method))");
  return { file, db, add: (e, method, state, data, tx = null) => db.prepare("INSERT INTO steps VALUES(?,?,?,?,?)").run(String(e), method, state, tx, JSON.stringify(data)) };
}
test("rollover diagnostic reads only three opening records and reports timing without transaction payloads", t => {
  const f = fixture(t), tx = "0x1220" + "a".repeat(64), secret = "PRIVATE_SIGNED_PAYLOAD";
  f.add(epoch, "open_epoch", "complete", { updatedAt: boundary + 240000,
    outbox: { createdAt: boundary + 160000, attempts: 1, lastAttemptAt: boundary + 165000,
      lastSubmission: { at: boundary + 166000, outcome: "acknowledged", error: secret }, transaction: { id: tx, signatures: [secret] } },
    finality: { state: "finalized", blockTime: String(boundary + 175910), transaction: secret } }, tx);
  f.add(epoch - 1, "open_epoch", "queued", { updatedAt: boundary - DAY, outbox: null, finality: null });
  f.add(epoch - 3, "open_epoch", secret, { privateKey: secret });
  f.add(epoch, "finalize_root", secret, { privateKey: secret });
  f.db.close(); const before = fs.readFileSync(f.file);
  const value = readTiming({ file: f.file, now }), current = value.epochs[2];
  assert.equal(value.readOnly, true); assert.equal(value.recordedStatesArePaymentProof, false);
  assert.equal(value.currentEpoch, String(epoch)); assert.equal(value.epochs.length, 3);
  assert.deepEqual(value.epochs[0], { epoch: String(epoch - 2), recordFound: false });
  assert.equal(current.txId, tx); assert.equal(current.attempts, 1);
  assert.equal(current.secondsAfterBoundary.stagedAt, 160);
  assert.equal(current.secondsAfterBoundary.includedBlockTime, 175.91);
  assert.equal(current.timingUtc.includedBlockTime, new Date(boundary + 175910).toISOString());
  assert.equal(value.epochs[1].timingUtc.stagedAt, null);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|privateKey|signatures|transaction/);
  assert.deepEqual(fs.readFileSync(f.file), before);
});
test("malformed scalar fields are not printed and oversized records are excluded", t => {
  const f = fixture(t), secret = "DO_NOT_PRINT";
  f.add(epoch, "open_epoch", secret, { updatedAt: secret, outbox: { createdAt: {}, attempts: 99, lastAttemptAt: -1,
    lastSubmission: { at: "1e12", outcome: secret } }, finality: { state: secret, blockTime: "99999999999999999999" } }, secret);
  f.add(epoch - 1, "open_epoch", "queued", { extra: "x".repeat(1048576) }); f.db.close();
  const value = readTiming({ file: f.file, now }), current = value.epochs[2];
  assert.equal(current.state, "unrecognized"); assert.equal(current.txId, null); assert.equal(current.attempts, null);
  assert.equal(current.submissionOutcome, null); assert.equal(current.finalityState, null);
  assert.ok(Object.values(current.timingUtc).every(value => value === null));
  assert.deepEqual(value.epochs[1], { epoch: String(epoch - 1), recordFound: true, timingAvailable: false, reason: "record_exceeds_limit" });
  assert.doesNotMatch(JSON.stringify(value), /DO_NOT_PRINT/);
});
test("missing or malformed databases fail without creating state or printing database contents", t => {
  const f = fixture(t); f.db.close(); fs.unlinkSync(f.file);
  assert.throws(() => readTiming({ file: f.file, now }), /could not be read/); assert.equal(fs.existsSync(f.file), false);
  fs.writeFileSync(f.file, "PRIVATE_BROKEN_DATABASE");
  assert.throws(() => readTiming({ file: f.file, now }), error => !error.message.includes("PRIVATE") && /could not be read/.test(error.message));
  const link = f.file + ".link"; fs.symlinkSync(f.file, link);
  assert.throws(() => readTiming({ file: link, now }), /could not be read/);
});
