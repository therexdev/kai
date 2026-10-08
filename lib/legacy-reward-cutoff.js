"use strict";
const fs = require("node:fs"), path = require("node:path");
const FILE = "legacy-reward-cutoff.json";
const DRAIN = "legacy-reward-drain.json";
function drain(dataDir) {
  const file = path.join(dataDir, DRAIN);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) throw Error("Invalid legacy drain file");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d || Object.keys(d).sort().join() !== "mode,schema,startedAt" || d.schema !== 1 || d.mode !== "legacy-kai-draining" ||
      typeof d.startedAt !== "string" || !Number.isFinite(Date.parse(d.startedAt))) throw Error("Invalid legacy drain marker");
  return Object.freeze(d);
}
function save(dataDir, name, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  const fd = fs.openSync(path.join(dataDir, name), "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform !== "win32") { const dir = fs.openSync(dataDir, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
// Install only during Alpha maintenance, after draining and closing the final
// legacy epoch. Loading it never disables recovery of already-earned claims.
function load(dataDir, store, now = Date.now()) {
  const file = path.join(dataDir, FILE);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) throw Error("Invalid legacy reward cutoff file");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || Object.keys(value).sort().join() !== "effectiveAt,finalEpoch,finalRoot,mode,schema" ||
      value.schema !== 1 || value.mode !== "legacy-kai-cutoff" || !Number.isSafeInteger(value.finalEpoch) || value.finalEpoch < 0 ||
      !/^[a-f0-9]{64}$/.test(value.finalRoot) || typeof value.effectiveAt !== "string" ||
      !Number.isFinite(Date.parse(value.effectiveAt)) || new Date(value.effectiveAt).toISOString() !== value.effectiveAt || Date.parse(value.effectiveAt) > now)
    throw Error("An explicit completed Alpha cutoff is required");
  const last = store.readEpoch(value.finalEpoch);
  if (store.latestEpochNumber() !== value.finalEpoch || !last?.summary || last.epoch !== value.finalEpoch ||
      last.summary.epoch !== value.finalEpoch || last.summary.persisted === false || last.summary.root !== value.finalRoot)
    throw Error("Close and durably preserve the final KAI epoch before installing its cutoff");
  return Object.freeze(value);
}
module.exports = { FILE, DRAIN, load, drain, save };
