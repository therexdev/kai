"use strict";
// Offline, forward-only activation. Importing this selector does not open SQLite,
// load runtime keys, or parse the legacy history. All writes require an explicit
// quiescence guard supplied by the reviewed installer/maintenance command.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const FORMAT = 1, SHADOW_SCHEMA = 2, SMALL = 16384, INTENT_LIMIT = 4 * 1024 * 1024, MANIFEST_LIMIT = 2 * 1024 * 1024;
const hash = value => crypto.createHash("sha256").update(value).digest("hex"), json = JSON.stringify;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || (typeof value === "number" && !Number.isFinite(value))) throw Error("JSON storage identity required");
  return value;
}
const equal = (a, b) => json(canonical(a)) === json(canonical(b));
function exact(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) throw Error("Invalid " + label); }
function regular(file) { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw Error("Regular storage file required: " + path.basename(file)); return s; }
function same(a, b) { return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(k => a[k] === b[k]); }
function read(file, limit) {
  const first = regular(file), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!same(first, before) || before.size > limit) throw Error("Storage file changed or exceeds read limit");
    const raw = Buffer.alloc(before.size + 1); let size = 0, n;
    while (size < raw.length && (n = fs.readSync(fd, raw, size, raw.length - size, null))) size += n;
    if (size !== before.size || !same(before, fs.fstatSync(fd)) || !same(before, regular(file))) throw Error("Storage file changed during read");
    return raw.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
function digestFile(file, limit) {
  const first = regular(file), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd), digest = crypto.createHash("sha256"), buffer = Buffer.alloc(65536); let size = 0, n;
    if (!same(first, before) || before.size > limit) throw Error("Storage file changed or exceeds read limit");
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) { size += n; if (size > limit) throw Error("Storage file exceeds read limit"); digest.update(buffer.subarray(0, n)); }
    if (size !== before.size || !same(before, fs.fstatSync(fd)) || !same(before, regular(file))) throw Error("Storage file changed during hashing");
    return { hash: digest.digest("hex"), bytes: size };
  } finally { fs.closeSync(fd); }
}
function syncDirectory(directory) { const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(file, value, { replace = false, owner } = {}) {
  const temp = file + "." + crypto.randomUUID() + ".tmp", fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, json(value) + "\n"); if (owner && process.platform !== "win32") fs.fchownSync(fd, owner.uid, owner.gid); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (replace) fs.renameSync(temp, file);
    else { fs.linkSync(temp, file); fs.unlinkSync(temp); }
    syncDirectory(path.dirname(file));
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function physicalDirectory(directory) {
  const absolute = path.resolve(directory);
  if (fs.existsSync(absolute)) { if (!fs.lstatSync(absolute).isDirectory() || fs.lstatSync(absolute).isSymbolicLink()) throw Error("Physical storage directory required"); return fs.realpathSync(absolute); }
  const parent = physicalDirectory(path.dirname(absolute)); return path.join(parent, path.basename(absolute));
}
function storagePaths(stateDir) {
  const state = physicalDirectory(stateDir), legacyDirectory = physicalDirectory(path.join(state, "scheduler", "koin-shadow"));
  const directory = physicalDirectory(path.join(state, "scheduler", "koin-shadow-sqlite"));
  return { stateDir: state, legacyDirectory, sourceFile: path.join(legacyDirectory, "koin-shadow.json"), directory,
    markerFile: path.join(legacyDirectory, "storage-active.json"), preparedFile: path.join(legacyDirectory, "storage-prepared.json"),
    lockDirectory: path.join(legacyDirectory, ".storage-maintenance.lock"), legacyBackup: path.join(directory, "legacy-koin-shadow.json") };
}
function storageIdentity(config) {
  const d = config?.deployment;
  if (!d || typeof config.schedulerUrl !== "string" || !config.schedulerUrl || !/^[a-f0-9]{64}$/.test(config.policyHash)) throw Error("Public storage deployment configuration required");
  const target = require("./reward-manifest").target({ chainId: d.chainId, credits: d.credits, creditsHash: d.creditsHash,
    rewards: d.rewards, rewardsHash: d.rewardsHash, token: d.token, tokenHash: d.tokenHash, verifier: d.verifier,
    version: String(config.version), workCapBps: 8000, ...(require("./product").isUsd(d) ? { rewardBasis: "usd-pool" } : {}) });
  return { schedulerUrl: config.schedulerUrl, policyHash: config.policyHash, target };
}
function descriptor(value, paths, identity) {
  exact(value, ["schema", "mode", "storeId", "directory", "identityHash", "sourceHash", "verificationHash"], "shadow activation descriptor");
  if (value.schema !== SHADOW_SCHEMA || value.mode !== "sqlite-shadow" || value.directory !== paths.directory ||
      !/^[a-f0-9-]{36}$/.test(value.storeId) || ![value.identityHash, value.sourceHash, value.verificationHash].every(v => /^[a-f0-9]{64}$/.test(v)) ||
      value.identityHash !== hash(json(canonical(identity)))) throw Error("Shadow activation identity or schema mismatch");
  return value;
}
function sentinel(value) { return { schema: 2, mode: "sqlite-shadow-redirect", descriptorHash: hash(json(canonical(value))), storeId: value.storeId, sourceHash: value.sourceHash }; }
function inspectStorage(stateDir, { identity } = {}) {
  const paths = storagePaths(stateDir);
  if (fs.existsSync(paths.lockDirectory)) throw Error("Shadow storage maintenance is in progress");
  if (fs.existsSync(paths.markerFile)) {
    const active = descriptor(JSON.parse(read(paths.markerFile, SMALL)), paths, identity);
    if (!fs.existsSync(paths.sourceFile) || !equal(JSON.parse(read(paths.sourceFile, SMALL)), sentinel(active))) throw Error("Shadow sentinel and activation marker disagree; recovery required");
    return { mode: "sqlite-shadow", paths, directory: paths.directory, markerFile: paths.markerFile, descriptor: active };
  }
  if (fs.existsSync(paths.preparedFile) || fs.existsSync(paths.directory) || fs.existsSync(paths.directory + ".recovery-anchor.sqlite")) throw Error("Shadow activation is incomplete; offline review required");
  if (fs.existsSync(paths.sourceFile)) {
    const stat = regular(paths.sourceFile);
    // Ordinary large legacy files are left to KoinShadow. A bounded redirect
    // always fits here, and a malformed small ledger is never a blank fallback.
    if (stat.size <= SMALL) { const value = JSON.parse(read(paths.sourceFile, SMALL)); if (value.schema !== 1 || value.mode !== "shadow") throw Error("Unsupported shadow ledger without activation marker"); }
  }
  return { mode: "legacy", paths };
}
function guard(options) {
  if (typeof options.assertQuiescent !== "function") throw Error("Explicit offline quiescence guard required");
  const result = options.assertQuiescent(); if (result && typeof result.then === "function") throw Error("Synchronous offline quiescence guard required");
}
function maintenance(paths, options, fn) {
  // The caller's guard also holds the shared updater/maintenance lock set.
  // That outer exclusion serializes recovery of a proven-dead local owner.
  guard(options);
  if (fs.existsSync(paths.lockDirectory)) {
    if (!fs.lstatSync(paths.lockDirectory).isDirectory() || fs.lstatSync(paths.lockDirectory).isSymbolicLink()) throw Error("Invalid shadow maintenance lock");
    const owner = JSON.parse(read(path.join(paths.lockDirectory, "owner.json"), SMALL));
    exact(owner, ["schema", "host", "pid", "stateDir"], "shadow maintenance lock owner");
    if (owner.schema !== FORMAT || owner.host !== os.hostname() || owner.stateDir !== paths.stateDir || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error("Shadow maintenance lock needs review");
    let exited = false; try { process.kill(owner.pid, 0); } catch (e) { if (e.code === "ESRCH") exited = true; }
    if (!exited || !equal(fs.readdirSync(paths.lockDirectory).sort(), ["owner.json"])) throw Error("Shadow maintenance lock is live or needs review");
    fs.unlinkSync(path.join(paths.lockDirectory, "owner.json")); fs.rmdirSync(paths.lockDirectory); syncDirectory(paths.legacyDirectory);
  }
  fs.mkdirSync(paths.lockDirectory, { mode: 0o700 });
  atomic(path.join(paths.lockDirectory, "owner.json"), { schema: FORMAT, host: os.hostname(), pid: process.pid, stateDir: paths.stateDir }); syncDirectory(paths.legacyDirectory);
  try { guard(options); return fn(); }
  finally { fs.unlinkSync(path.join(paths.lockDirectory, "owner.json")); fs.rmdirSync(paths.lockDirectory); syncDirectory(paths.legacyDirectory); }
}
function manifestFiles(paths) {
  const files = fs.readdirSync(paths.stateDir).filter(name => /^manifest-.*\.json$/.test(name)).sort();
  if (files.length > 10000 || files.some(name => !/^manifest-(0|[1-9]\d*)\.json$/.test(name))) throw Error("Invalid or excessive saved reward manifests");
  return files;
}
function verifyManifests(store, paths, identity) {
  const M = require("./reward-manifest"), target = M.target(identity.target), manifests = [];
  for (const name of manifestFiles(paths)) {
    const raw = read(path.join(paths.stateDir, name), MANIFEST_LIMIT), result = M.verify(JSON.parse(raw), target), m = result.envelope.manifest;
    if (name !== "manifest-" + m.epoch + ".json") throw Error("Saved manifest filename and epoch differ");
    const evidence = store.getManifestEvidence(m.epoch, { workBasis: target.rewardBasis });
    const rows = evidence.allocation.allocations.filter(row => BigInt(row.availability) + BigInt(row.work) > 0n);
    const tree = M.build(target, m.epoch, rows), allocations = tree.claims.map(({ address, availability, work }) => ({ address, availability, work }));
    if (m.evidenceHash !== evidence.evidenceHash || !equal(m.root, tree.root) || !equal(m.allocations, allocations)) throw Error("Saved manifest differs from migrated reward evidence");
    manifests.push({ name, epoch: m.epoch, hash: hash(raw), signatureHash: result.hash, evidenceHash: evidence.evidenceHash });
  }
  return manifests;
}
function loadIntent(paths, identity) {
  const intent = JSON.parse(read(paths.preparedFile, INTENT_LIMIT));
  exact(intent, ["schema", "mode", "stateDir", "sourceFile", "legacyBackup", "descriptor", "manifests", "sealedEpochs"], "storage preparation intent");
  if (intent.schema !== FORMAT || intent.mode !== "verified-shadow-preparation" || intent.stateDir !== paths.stateDir || intent.sourceFile !== paths.sourceFile || intent.legacyBackup !== paths.legacyBackup || !Array.isArray(intent.manifests) || !Array.isArray(intent.sealedEpochs)) throw Error("Storage preparation binding changed");
  descriptor(intent.descriptor, paths, identity); return intent;
}
function candidate(paths, identity) {
  require("./storage-writer-lease").assertWriterLeaseCount(paths.directory, 0, "Offline shadow activation");
  return new (require("./shadow-store").ShadowStore)(paths.directory, { identity, staging: true });
}
function verifyRows(store, sql, expected, ...args) {
  const actual = store._statement(sql).iterate(...args);
  for (const row of expected) { const next = actual.next(); if (next.done || !equal(next.value, row)) throw Error("Staged shadow semantic index changed"); }
  if (!actual.next().done) throw Error("Staged shadow contains unexpected indexed rows");
}
function verifyRecordIndexes(store, state) {
  verifyRows(store, "SELECT * FROM qualifications ORDER BY rowid", (function* () {
    for (const [id, q] of Object.entries(state.qualifications)) yield { capacity_id: id, address: q.address, approved_at: q.approvedAt, expires: q.expires, data: json(q) };
  })());
  verifyRows(store, "SELECT * FROM presence_latest ORDER BY rowid", (function* () {
    for (const [address, p] of Object.entries(state.presence)) { const { samples = [], ...latest } = p; yield { address, observed_at: latest.at, retained_from: 0, data: json(latest) }; }
  })());
  verifyRows(store, "SELECT * FROM presence_samples ORDER BY rowid", (function* () {
    for (const [address, p] of Object.entries(state.presence)) for (const sample of p.samples || []) yield { address, observed_at: sample.at, data: json(sample) };
  })());
  verifyRows(store, "SELECT * FROM observations ORDER BY rowid", (function* () {
    for (const [address, rows] of Object.entries(state.observations)) for (const [ordinal, row] of rows.entries()) yield { address, ordinal, observed_at: row.at, data: json(row) };
  })());
}
function verifyCandidate(store, paths, identity, { seal = false } = {}) {
  const { MAX_SOURCE_BYTES } = require("./shadow-store"), active = descriptor(store.descriptor(), paths, identity);
  const backup = read(paths.legacyBackup, MAX_SOURCE_BYTES), state = JSON.parse(backup), saved = store._identity();
  if ((regular(paths.legacyBackup).mode & 0o777) !== 0o400 || hash(backup) !== active.sourceHash || saved.migration !== "verified" || saved.sourceFile !== paths.sourceFile ||
      state.schema !== 1 || state.mode !== "shadow" || !equal(saved.identity, identity)) throw Error("Verified original shadow backup or migration identity changed");
  const records = store._verifyMigratedRecords(state), epochs = Object.keys(state.budgets).map(Number).sort((a, b) => a - b), verification = [];
  verifyRecordIndexes(store, state); let availabilityCount = 0, workCount = 0, intervalCount = 0, evidenceWorkCount = 0;
  if (store._statement("SELECT COUNT(*) AS count FROM days").get().count !== epochs.length || store._statement("SELECT COUNT(*) AS count FROM ingested_events").get().count || store._statement("SELECT COUNT(*) AS count FROM legacy_presence_receipts").get().count) throw Error("Staged shadow contains unexpected runtime writes");
  for (const epoch of epochs) {
    const day = state.days[epoch], original = { budget: state.budgets[epoch], intervals: day.intervals, work: day.work }, evidence = store.getManifestEvidence(epoch), usd = store.getManifestEvidence(epoch, { workBasis: "usd-pool" });
    const P = require("./policy"), allocation = P.allocate(original), usdAllocation = P.allocate({ ...original, workBasis: "usd-pool" });
    if (evidence.evidenceHash !== hash(json(original)) || !equal(evidence.allocation, allocation) || !equal(usd.allocation, usdAllocation)) throw Error("Staged shadow evidence or allocation changed");
    const lastEnd = day.intervals.at(-1)?.end ?? null;
    verifyRows(store, "SELECT epoch,budget,interval_count,next_start,last_end,work_count FROM days WHERE epoch=?", [{ epoch, budget: json(original.budget), interval_count: day.intervals.length,
      next_start: lastEnd ?? Math.ceil(original.budget.openedAt / 60000) * 60000, last_end: lastEnd, work_count: day.work.length }], epoch);
    verifyRows(store, "SELECT * FROM intervals WHERE epoch=? ORDER BY ordinal", day.intervals.map((row, ordinal) => ({ epoch, ordinal, start: row.start, end: row.end, data: json(row) })), epoch);
    verifyRows(store, "SELECT * FROM work WHERE epoch=? ORDER BY ordinal", day.work.map((row, ordinal) => ({ epoch, ordinal, data: json(row) })), epoch);
    intervalCount += day.intervals.length; evidenceWorkCount += day.work.length;
    const available = P.allocate({ budget: original.budget, intervals: day.intervals, work: [] }).allocations.map(row => ({ epoch, address: row.address, atoms: row.availability }));
    const worked = P.allocate({ budget: original.budget, intervals: [], work: day.work }).allocations.map(row => ({ epoch, address: row.address, atoms: row.work }));
    // SQLite's binary ordering need not match locale address ordering.
    for (const [table, rows] of [["availability", available], ["work_totals", worked]]) for (const row of rows) verifyRows(store, "SELECT * FROM " + table + " WHERE epoch=? AND address=?", [row], epoch, row.address);
    availabilityCount += available.length; workCount += worked.length;
    verification.push({ epoch, evidenceHash: evidence.evidenceHash, allocationHash: hash(json(allocation)), usdAllocationHash: hash(json(usdAllocation)), intervalCount: day.intervals.length, workCount: day.work.length, sealed: day.sealed === true });
  }
  for (const [table, count] of [["availability", availabilityCount], ["work_totals", workCount], ["intervals", intervalCount], ["work", evidenceWorkCount]])
    if (store._statement("SELECT COUNT(*) AS count FROM " + table).get().count !== count) throw Error("Staged shadow contains unexpected indexed rows");
  if (!equal(saved.verification, verification) || !equal(saved.records, records) || hash(json({ epochs: verification, records })) !== active.verificationHash) throw Error("Staged shadow verification commitment changed");
  const manifests = verifyManifests(store, paths, identity), sealedEpochs = [...new Set([...verification.filter(row => row.sealed).map(row => String(row.epoch)), ...manifests.map(row => row.epoch)])].sort((a, b) => Number(a) - Number(b));
  const expected = new Set(sealedEpochs);
  for (const epoch of epochs) if (store.getDayProgress(epoch).sealed && !expected.has(String(epoch))) throw Error("Staged shadow has an unexplained seal");
  if (seal) store.markSealedMany(sealedEpochs);
  for (const epoch of sealedEpochs) if (!store.getDayProgress(epoch).sealed) throw Error("Saved manifest seal is missing");
  if (store._statement("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Staged shadow integrity check failed");
  return { schema: FORMAT, mode: "verified-shadow-preparation", stateDir: paths.stateDir, sourceFile: paths.sourceFile, legacyBackup: paths.legacyBackup, descriptor: active, manifests, sealedEpochs };
}
function sourceState(paths, intent) {
  const stat = regular(paths.sourceFile);
  if (stat.size <= SMALL) {
    const value = JSON.parse(read(paths.sourceFile, SMALL));
    if (value.mode === "sqlite-shadow-redirect") { if (!equal(value, sentinel(intent.descriptor))) throw Error("Shadow sentinel changed; recovery required"); return "sentinel"; }
  }
  if (digestFile(paths.sourceFile, require("./shadow-store").MAX_SOURCE_BYTES).hash !== intent.descriptor.sourceHash) throw Error("Legacy shadow changed after preparation");
  return "legacy";
}
function checkManifests(paths, intent) {
  if (!equal(manifestFiles(paths), intent.manifests.map(row => row.name))) throw Error("Saved manifest set changed after preparation");
  for (const row of intent.manifests) if (digestFile(path.join(paths.stateDir, row.name), MANIFEST_LIMIT).hash !== row.hash) throw Error("Saved manifest changed after preparation");
}
function prepareStorage(options) {
  const { stateDir, identity } = options, paths = storagePaths(stateDir);
  return maintenance(paths, options, () => {
    if (fs.existsSync(paths.markerFile)) throw Error("Storage is already active; preparation cannot rewind it");
    let previous = fs.existsSync(paths.preparedFile) ? loadIntent(paths, identity) : null;
    if (previous) { sourceState(paths, previous); checkManifests(paths, previous); }
    if (!fs.existsSync(paths.directory) && !fs.existsSync(paths.directory + ".recovery-anchor.sqlite")) {
      guard(options); require("./shadow-store").ShadowStore.migrateLegacy({ sourceFile: paths.sourceFile, directory: paths.directory, identity });
      options.onStage?.("candidate-migrated");
    }
    guard(options); const store = candidate(paths, identity); let intent;
    try { intent = verifyCandidate(store, paths, identity, { seal: !previous }); } finally { store.close(); }
    if (previous && !equal(previous, intent)) throw Error("Prepared storage verification changed");
    if (sourceState(paths, intent) !== "legacy" && !previous) throw Error("Unbound shadow sentinel requires recovery");
    checkManifests(paths, intent); guard(options);
    if (!previous) atomic(paths.preparedFile, intent, { owner: regular(paths.sourceFile) });
    options.onStage?.("prepared");
    return { prepared: true, activated: false, descriptor: intent.descriptor, manifestCount: intent.manifests.length, sealedEpochs: intent.sealedEpochs, legacyBackup: paths.legacyBackup };
  });
}
function activateStorage(options) {
  const { stateDir, identity } = options, paths = storagePaths(stateDir);
  return maintenance(paths, options, () => {
    const intent = loadIntent(paths, identity);
    if (fs.existsSync(paths.markerFile)) {
      const active = descriptor(JSON.parse(read(paths.markerFile, SMALL)), paths, identity);
      if (!equal(active, intent.descriptor) || sourceState(paths, intent) !== "sentinel") throw Error("Active storage binding changed; recovery required");
      return { activated: true, alreadyActive: true, descriptor: active };
    }
    checkManifests(paths, intent); const before = sourceState(paths, intent); guard(options);
    const store = candidate(paths, identity); let verified;
    try { verified = verifyCandidate(store, paths, identity); } finally { store.close(); }
    if (!equal(verified, intent)) throw Error("Staged storage differs from verified preparation");
    checkManifests(paths, intent); if (sourceState(paths, intent) !== before) throw Error("Legacy shadow changed during activation"); guard(options);
    const owner = regular(paths.sourceFile);
    if (before === "legacy") { atomic(paths.sourceFile, sentinel(intent.descriptor), { replace: true, owner }); options.onStage?.("sentinel-installed"); }
    guard(options); checkManifests(paths, intent);
    if (sourceState(paths, intent) !== "sentinel") throw Error("Shadow sentinel was overwritten; recovery required");
    atomic(paths.markerFile, intent.descriptor, { owner }); options.onStage?.("marker-installed");
    return { activated: true, alreadyActive: false, descriptor: intent.descriptor, legacyBackup: paths.legacyBackup };
  });
}
module.exports = { storagePaths, storageIdentity, inspectStorage, prepareStorage, activateStorage };
