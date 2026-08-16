"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const gzip = promisify(zlib.gzip);

/*
 * Rotating snapshots of the scheduler's state (mainnet-readiness: the
 * earnings/credits ledgers are real-money records and JSON files on one
 * disk). Every snapshot is a single gzipped JSON bundle of the state files,
 * written atomically (tmp + rename) so a crash mid-write can't corrupt the
 * newest good copy. Local rotation protects against corruption and bad
 * deploys; the export endpoint (operator-protected — bundles include
 * worker tokens and balances) is the offsite path.
 */

// Guard the env knobs: a malformed value must never silently disable
// backups or (with KEEP=0) delete the only snapshot the instant it is
// written. Fall back to the defaults and floor KEEP at 1.
function envInt(name, def, min = 1) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
}
const KEEP = envInt("KAI_BACKUP_KEEP", 28, 1); // 7 days at the 6h default
const EVERY_MS = envInt("KAI_BACKUP_EVERY_MS", 6 * 3600 * 1000, 60000);
const MAX_EPOCH_FILES = 200; // most recent epochs; older ones are anchored on-chain

// Async so the reads and gzip run on the libuv threadpool, never blocking
// the scheduler's event loop (the project's hard-won "never block the
// worker path" rule — a large sync gzip would freeze polls/heartbeats).
async function snapshotOnce(dataDir) {
  let names = [];
  try {
    names = await fsp.readdir(dataDir);
  } catch {
    return null; // nothing to back up yet
  }
  const bundle = { at: new Date().toISOString(), files: {} };
  const core = names.filter((n) => n.endsWith(".json") && !n.startsWith("epoch-"));
  const epochs = names.filter((n) => n.startsWith("epoch-") && n.endsWith(".json")).sort().slice(-MAX_EPOCH_FILES);
  for (const n of [...core, ...epochs]) {
    try {
      bundle.files[n] = await fsp.readFile(path.join(dataDir, n), "utf8");
    } catch {
      /* file vanished mid-walk — skip */
    }
  }
  if (Object.keys(bundle.files).length === 0) return null;
  const dir = path.join(dataDir, "backups");
  await fsp.mkdir(dir, { recursive: true });
  const name = "state-" + bundle.at.replace(/[:.]/g, "-") + ".json.gz";
  const tmp = path.join(dir, name + ".tmp");
  await fsp.writeFile(tmp, await gzip(JSON.stringify(bundle)));
  await fsp.rename(tmp, path.join(dir, name));
  let all = await fsp.readdir(dir);
  all = all.filter((n) => n.startsWith("state-") && n.endsWith(".json.gz")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
    try {
      await fsp.unlink(path.join(dir, old));
    } catch {
      /* best-effort rotation */
    }
  }
  return name;
}

function latestBackupPath(dataDir) {
  const dir = path.join(dataDir, "backups");
  let all = [];
  try {
    all = fs.readdirSync(dir).filter((n) => n.startsWith("state-") && n.endsWith(".json.gz")).sort();
  } catch {
    return null;
  }
  return all.length ? path.join(dir, all[all.length - 1]) : null;
}

function startBackups(dataDir, log = () => {}) {
  const run = async () => {
    try {
      const name = await snapshotOnce(dataDir);
      if (name) log(`snapshot ${name}`);
    } catch (e) {
      log(`snapshot failed: ${e.message}`);
    }
  };
  // First snapshot shortly after boot (state files exist by then), then on
  // the interval. Timers unref'd — backups never keep the process alive.
  const first = setTimeout(run, 90 * 1000);
  first.unref?.();
  const t = setInterval(run, EVERY_MS);
  t.unref?.();
}

module.exports = { startBackups, snapshotOnce, latestBackupPath };
