"use strict";
// Offline storage command only: never stops/starts a service, edits its unit,
// loads signing/operator secrets, or repairs/rewinds payment journals.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const Storage = require("../../lib/koin-network/shadow-storage-activation");
const { UNIT, PATHS, LOCKS } = require("./update-reward-runtime");
const PROPERTIES = ["ActiveState", "MainPID", "ExecMainPID", "ExecMainCode", "ExecMainStatus", "Result", "NRestarts", "WorkingDirectory", "FragmentPath", "DropInPaths", "Restart", "RestartForceExitStatus", "UnitFileState"];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function publicConfig(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error("Regular bounded public runtime configuration required");
  return fs.readFileSync(file);
}
function productionGuard({ expectedRelease, configFile = path.join(PATHS.config, "runtime.json"), run = execFileSync } = {}) {
  if (!/^\/opt\/kai-koin-prepaid\/releases\/[a-f0-9]{40}$/.test(expectedRelease)) throw Error("Exact reviewed installed release required");
  const configHash = hash(publicConfig(configFile)); let baseline;
  return () => {
    const output = run("systemctl", ["show", UNIT, "--property=" + PROPERTIES.join(",")], { encoding: "utf8", timeout: 10000 });
    const state = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
    for (const name of PROPERTIES) if (!Object.hasOwn(state, name)) throw Error("Incomplete stopped-service identity");
    const expected = { ActiveState: "inactive", MainPID: "0", ExecMainCode: "1", ExecMainStatus: "0", Result: "success", WorkingDirectory: expectedRelease,
      FragmentPath: PATHS.unit, DropInPaths: "", Restart: "on-failure", RestartForceExitStatus: "", UnitFileState: "enabled" };
    for (const [name, value] of Object.entries(expected)) if (state[name] !== value) throw Error("Storage activation paused: unexpected " + name);
    if (!/^[1-9]\d*$/.test(state.ExecMainPID) || !/^\d+$/.test(state.NRestarts) || (baseline && JSON.stringify(state) !== baseline)) throw Error("Stopped service process identity changed");
    if (hash(publicConfig(configFile)) !== configHash) throw Error("Public runtime configuration changed during maintenance");
    baseline = JSON.stringify(state);
  };
}
function withUpdaterLocks(fn, { work = PATHS.work, names = ["kai-reward-storage-activation.lock", ...LOCKS] } = {}) {
  const held = [];
  try { for (const name of names) { const file = path.join(work, name); fs.mkdirSync(file, { mode: 0o700 }); held.push(file); } return fn(); }
  finally { for (const file of held.reverse()) fs.rmdirSync(file); }
}
function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3 || !["prepare", "activate"].includes(argv[0]) || argv[1] !== "--expected-release") throw Error("Usage: node activate-reward-storage.js prepare|activate --expected-release /opt/kai-koin-prepaid/releases/<reviewed-commit>");
  return withUpdaterLocks(() => {
    const configFile = path.join(PATHS.config, "runtime.json"), assertQuiescent = productionGuard({ expectedRelease: argv[2], configFile }); assertQuiescent();
    const identity = Storage.storageIdentity(JSON.parse(publicConfig(configFile))), paths = Storage.storagePaths(PATHS.state);
    // A live provider-device writer is never an acceptable offline source.
    const check = () => { assertQuiescent(); require("../../lib/koin-network/storage-writer-lease").assertWriterLeaseCount(path.join(paths.stateDir, "provider-devices"), 0, "Offline provider source"); };
    const expectedOwner = { uid: Number(execFileSync("id", ["-u", "kai-koin-prepaid"], { encoding: "utf8" }).trim()), gid: Number(execFileSync("id", ["-g", "kai-koin-prepaid"], { encoding: "utf8" }).trim()) };
    const sourceOwner = fs.lstatSync(paths.sourceFile);
    if (sourceOwner.uid !== expectedOwner.uid || sourceOwner.gid !== expectedOwner.gid) throw Error("Legacy shadow owner differs from the service account");
    const options = { stateDir: paths.stateDir, identity, assertQuiescent: check };
    const result = (argv[0] === "prepare" ? Storage.prepareStorage : Storage.activateStorage)(options);
    check(); require("./update-reward-storage").ownCandidate(paths, { expectedOwner }); check();
    console.log(JSON.stringify({ operation: "offline_shadow_" + argv[0], ...result })); return result;
  });
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { productionGuard, withUpdaterLocks, main };
