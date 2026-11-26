"use strict";
// Operator-only configuration activation for the already installed protocol 2.
// No supplier calls, process kill escalation, code replacement or journal restore.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { RELEASES, UNIT, USER, command, verifyInstalled } = require("./native-rollout-release");
const RELEASE = RELEASES[0], MODEL = "akash-gpt-oss-120b";
const VALUES = { KAI_AKASHML_API_KEY_FILE: "/etc/kai-koin-prepaid/akashml-api-key", KAI_NATIVE_QUALIFICATION_FILE: "/var/lib/kai-koin-prepaid/native-qualification/routes.json", KAI_NATIVE_TOOL_MODELS: MODEL };
function clean(s) { return s.ActiveState === "inactive" && s.MainPID === "0" && s.ExecMainCode === "1" && s.ExecMainStatus === "0" && s.Result === "success"; }
const MODELS = require("../../lib/koin-network/managed-models.json").models.map(m => m.model);
function validateModels(models) {
  if (!Array.isArray(models) || !models.length || models.some(m => !MODELS.includes(m)) || new Set(models).size !== models.length) throw Error("Choose distinct managed model IDs");
  return models;
}
function desired(bytes, models = [MODEL]) {
  validateModels(models);
  const text = bytes.toString("utf8"); if (!Buffer.from(text).equals(bytes)) throw Error("Environment must be UTF-8");
  if (/^[ \t]*KAI_AKASHML_API_KEY[ \t]*=/m.test(text)) throw Error("Expected only the existing protected key-file source");
  let result = text;
  const values = { ...VALUES, KAI_NATIVE_TOOL_MODELS: models.join(",") };
  for (const [key, value] of Object.entries(values)) {
    const rows = [...text.matchAll(new RegExp("^[ \\t]*" + key + "[ \\t]*=([^\\r\\n]*)", "gm"))];
    if (rows.length > 1) throw Error("Duplicate managed native configuration");
    if (rows.length) {
      let current = rows[0][1].trim(); if ((current.startsWith('"') && current.endsWith('"')) || (current.startsWith("'") && current.endsWith("'"))) current = current.slice(1, -1);
      if (key === "KAI_NATIVE_TOOL_MODELS") {
        const existing = current ? current.split(",").map(m => m.trim()) : [];
        if (existing.length) validateModels(existing);
        const merged = [...new Set([...existing, ...models])].join(",");
        if (current !== merged) result = result.replace(rows[0][0], key + "=" + merged);
        continue;
      }
      if (current !== value) throw Error("Existing managed native configuration differs; preserve it for review");
    } else {
      if (key === "KAI_AKASHML_API_KEY_FILE") throw Error("Expected the configured protected supplier key file");
      result += (result.endsWith("\n") ? "" : "\n") + key + "=" + value + "\n";
    }
  }
  return Buffer.from(result);
}
function real(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.size > 1048576) throw Error("Expected a private owner-controlled regular configuration file");
  return s;
}
function syncDir(dir) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function production(run, values = VALUES, expectedRelease, load) {
  const release = verifyInstalled(run, expectedRelease);
  const at = load || (p => require(path.join(release, p))), prior = at("deploy/koin-mainnet/update-reward-runtime"), wallet = at("deploy/koin-mainnet/update-wallet-access");
  const runtime = at(release === RELEASES[1] ? "deploy/koin-mainnet/update-purchase-limit" : "deploy/koin-mainnet/update-native-qualification");
  return {
    release,
    locks: runtime.LOCKS,
    guard() {
      verifyInstalled(run, release);
      wallet.validateUnit(fs.readFileSync(wallet.PATHS.unit), wallet.PATHS, release, release);
    },
    state: () => prior.processState(run),
    drain: options => prior.gracefulShutdown({ ...options, run, timeoutMs: 240000 }),
    qualify(model = MODEL) {
      const code = `const q=require(${JSON.stringify(path.join(release, "lib/koin-network/native-qualification"))}).capability(${JSON.stringify(model)});if(!q)process.exit(1);console.log(JSON.stringify(q));`;
      return JSON.parse(run("runuser", ["-u", USER, "--", "env", "-i", "PATH=/usr/bin:/bin", ...Object.entries(values).map(([k,v]) => `${k}=${v}`), "/usr/bin/node", "-e", code], release));
    },
    loaded(pid) {
      if (!/^[1-9][0-9]*$/.test(pid)) throw Error("Invalid running process identity");
      const bytes = fs.readFileSync(`/proc/${pid}/environ`); if (bytes.length > 1048576) throw Error("Oversized process environment");
      const entries = bytes.toString().split("\0");
      // Inspect only these fields; never print or persist environment secrets.
      return !entries.some(v => v.startsWith("KAI_AKASHML_API_KEY=")) && Object.entries(values).every(([k,v]) => entries.filter(x => x.startsWith(k + "=")).join() === `${k}=${v}`);
    },
    health: () => runtime.health({ expected: wallet.runtimeTarget(path.join(wallet.PATHS.config, "runtime.json")) }),
  };
}
async function activate({ run = command, deps, work = "/root", file = "/etc/kai-koin-prepaid/account.env", log = console.log, models = [MODEL] } = {}) {
  validateModels(models);
  const live = !deps; deps ||= production(run); const held = [];
  try {
    for (const name of ["kai-native-activation.lock", ...deps.locks]) { const lock = path.join(work, name); fs.mkdirSync(lock, { mode: 0o700 }); held.push(lock); }
    deps.guard(); const st = real(file), before = fs.readFileSync(file), after = desired(before, models);
    const enabled = after.toString().match(/^[ \t]*KAI_NATIVE_TOOL_MODELS[ \t]*=([^\r\n]*)/m)[1].replace(/^["']|["']$/g, "").split(",").map(m => m.trim());
    // Validate every route in the resulting allowlist, including routes already enabled.
    if (live) deps = production(run, { ...VALUES, KAI_NATIVE_TOOL_MODELS: enabled.join(",") }, deps.release);
    const qualify = () => enabled.map(model => { const q = deps.qualify(model); if (q?.version !== 2 || q.replay !== "sealed-v1" || !/^[a-f0-9]{64}$/.test(q.qualificationId) || q.expiresAt <= Date.now() + 60000) throw Error("Current qualification with at least one minute remaining is required"); return { model, ...q }; });
    qualify(); let state = deps.state();
    if (!(state.ActiveState === "active" && state.MainPID !== "0" && state.MainPID === state.ExecMainPID) && !clean(state)) throw Error("Service must be active or normally stopped; no restart will be forced");
    if (!before.equals(after)) {
      const backup = fs.mkdtempSync(path.join(work, "kai-native-config-")); fs.chmodSync(backup, 0o700);
      fs.writeFileSync(path.join(backup, "account.env"), before, { flag: "wx", mode: 0o600, flush: true }); syncDir(backup); syncDir(work);
      const tmp = file + ".native-" + crypto.randomUUID() + ".tmp", fd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeFileSync(fd, after); fs.fchownSync(fd, st.uid, st.gid); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try {
        deps.guard(); const current = real(file);
        if (current.ino !== st.ino || current.ctimeMs !== st.ctimeMs || !fs.readFileSync(file).equals(before)) throw Error("Concurrent configuration change preserved");
        fs.renameSync(tmp, file); syncDir(path.dirname(file));
      } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
      log("Private configuration backup: " + backup);
    }
    const unchanged = () => { deps.guard(); real(file); if (!fs.readFileSync(file).equals(after)) throw Error("Configuration changed during activation; preserve it for review"); };
    unchanged(); state = deps.state();
    if (state.ActiveState === "active" && !deps.loaded(state.MainPID)) {
      const initial = state; log("Waiting for a normal service exit; no forced kill deadline is used.");
      await deps.drain({ assertUnchanged: unchanged }); state = deps.state();
      if (!clean(state) || state.ExecMainPID !== initial.MainPID || state.NRestarts !== initial.NRestarts) throw Error("Original clean process exit was not verified");
    }
    unchanged(); qualify(); state = deps.state();
    if (clean(state)) { run("systemctl", ["start", UNIT]); }
    else if (state.ActiveState !== "active" || !deps.loaded(state.MainPID)) throw Error("Service has not completed its clean configuration transition");
    await deps.health(); unchanged(); state = deps.state();
    if (state.ActiveState !== "active" || !deps.loaded(state.MainPID)) throw Error("Running service did not load the qualified configuration");
    for (const q of qualify()) log(JSON.stringify({ model: q.model, enabled: true, protocol: 2, qualificationId: q.qualificationId, expiresAt: q.expiresAt, supplierCalls: 0 }));
  } finally { for (const lock of held.reverse()) fs.rmdirSync(lock); }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const models = args.length === 1 && args[0] === "--enable-gpt-oss" ? [MODEL] :
    args.length === 2 && args[0] === "--enable-models" ? args[1].split(",") : null;
  if (process.getuid?.() !== 0 || process.execPath !== "/usr/bin/node" || !models) throw Error("Run with /usr/bin/node as root and --enable-models <comma-separated IDs>");
  validateModels(models);
  process.umask(0o077);
  activate({ models }).catch(error => { console.error(error.message); console.error("Activation paused. Configuration and current journals were preserved. Rerun this same helper to resume; do not force-stop the service or rerun the code updater."); process.exitCode = 1; });
}
module.exports = { activate, desired, production, VALUES, RELEASE, MODEL, MODELS, validateModels };
