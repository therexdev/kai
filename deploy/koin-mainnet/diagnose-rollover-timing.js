"use strict";
// Local, read-only timing evidence. No runtime, credentials, signer, network
// client or financial journal constructor is loaded by this diagnostic.
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const FILE = "/var/lib/kai-koin-prepaid/cycle/reward-cycle.sqlite", DAY = 86400000;
const STATES = new Set(["queued", "signing", "staged", "unknown", "pending", "reversible", "needs_review", "complete", "observed_external"]);
const FINALITY = new Set(["unknown", "pending", "reversible", "finalized", "reverted"]);
function timestamp(value) {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : null;
}
function readTiming({ file = FILE, now = Date.now() } = {}) {
  if (timestamp(now) === null || now < 2 * DAY) throw Error("Valid diagnostic time required");
  const today = Math.floor(now / DAY), epochs = [today - 2, today - 1, today].map(String);
  let db;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error();
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout=1000; PRAGMA query_only=ON; BEGIN");
    // Only fixed scalar projections from at most three indexed rows leave
    // SQLite. Never select the signed outbox, manifest, signatures or keys.
    const rows = db.prepare(`WITH sampled AS (
      SELECT epoch,state,tx_id,length(data) AS recordLength,
        CASE WHEN length(data)<=1048576 THEN data ELSE '{}' END AS data
      FROM steps WHERE epoch IN (?,?,?) AND method='open_epoch'
      ORDER BY length(epoch),epoch LIMIT 3)
      SELECT epoch, state, tx_id, recordLength,
      json_extract(data,'$.updatedAt') AS rowUpdatedAt,
      json_extract(data,'$.outbox.createdAt') AS stagedAt,
      json_extract(data,'$.outbox.attempts') AS attempts,
      json_extract(data,'$.outbox.lastAttemptAt') AS lastAttemptAt,
      json_extract(data,'$.outbox.lastSubmission.at') AS submissionResponseAt,
      json_extract(data,'$.outbox.lastSubmission.outcome') AS submissionOutcome,
      json_extract(data,'$.finality.state') AS finalityState,
      json_extract(data,'$.finality.blockTime') AS includedBlockTime
      FROM sampled`).all(...epochs);
    return { probe: "reward_rollover_timing", version: 1, readOnly: true,
      recordedStatesArePaymentProof: false, observedAt: now, currentEpoch: String(today),
      epochs: epochs.map(epoch => {
        const row = rows.find(value => value.epoch === epoch), boundary = Number(epoch) * DAY;
        if (!row) return { epoch, recordFound: false };
        if (row.recordLength > 1048576) return { epoch, recordFound: true, timingAvailable: false, reason: "record_exceeds_limit" };
        const times = Object.fromEntries(["stagedAt", "lastAttemptAt", "submissionResponseAt", "includedBlockTime", "rowUpdatedAt"]
          .map(key => [key, timestamp(row[key])]));
        return { epoch, recordFound: true, boundaryUtc: new Date(boundary).toISOString(),
          state: STATES.has(row.state) ? row.state : "unrecognized",
          txId: typeof row.tx_id === "string" && /^0x1220[a-f0-9]{64}$/.test(row.tx_id) ? row.tx_id : null,
          attempts: Number.isSafeInteger(row.attempts) && row.attempts >= 0 && row.attempts <= 3 ? row.attempts : null,
          submissionOutcome: ["acknowledged", "unknown"].includes(row.submissionOutcome) ? row.submissionOutcome : null,
          finalityState: FINALITY.has(row.finalityState) ? row.finalityState : null,
          timingUtc: Object.fromEntries(Object.entries(times).map(([key, value]) => [key, value === null ? null : new Date(value).toISOString()])),
          secondsAfterBoundary: Object.fromEntries(Object.entries(times).map(([key, value]) => [key, value === null ? null : (value - boundary) / 1000])) };
      }) };
  } catch { throw Error("Reward opening timing could not be read; service and financial records were not changed"); }
  finally { db?.close(); }
}
if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw Error("Run the rollover timing diagnostic without arguments");
    console.log(JSON.stringify(readTiming(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { readTiming };
