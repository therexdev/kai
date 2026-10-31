"use strict";
// Forward-only code repair. No configuration, model admission, pricing, wallet
// keys or financial records are changed or restored by this installer.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { validateUnit, runtimeTarget, UNIT, PATHS } = require("./update-wallet-access");
const { configDigest } = require("./update-prepaid-web");
const { LOCKS: PREVIOUS_LOCKS, health } = require("./update-liquid-catalog");
const BASE = "87a7bd87faac1e2bd707eb60f6d225cbf25cc8e8";
const INSTALLED = [BASE, "4b26b738e63d9f92717b99191ed2f6b7e32090e3"];
const LOCKS = ["kai-tokenizer-memory-repair.lock", ...PREVIOUS_LOCKS];
const FILES = ["lib/koin-network/tokenizer.js", "lib/koin-network/test-runtime.js", "scripts/probe-koin-tokenizer-packs.js",
  "scripts/verify-koin-catalog-memory.js", "scripts/probe-koin-tokenizer-memory-update.js",
  "deploy/koin-mainnet/repair-tokenizer-memory.js", "deploy/koin-mainnet/TOKENIZER_MEMORY_REPAIR.md"];
function command(exe, args, cwd, capture = false) {
  return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || "";
}
function snapshot(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o022) || s.size > 2097152) throw Error("Untrusted service configuration");
    return { bytes: fs.readFileSync(fd), mode: s.mode & 0o777, uid: s.uid, gid: s.gid };
  } finally { fs.closeSync(fd); }
}
function same(file, previous) { const now = snapshot(file); return now.bytes.equals(previous.bytes) && now.mode === previous.mode && now.uid === previous.uid && now.gid === previous.gid; }
function sync(directory) { const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function replace(file, previous, bytes, guard) {
  const temp = file + ".memory-" + crypto.randomBytes(8).toString("hex");
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fchownSync(fd, previous.uid, previous.gid); fs.fchmodSync(fd, previous.mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (!same(file, previous) || !guard()) throw Error("Concurrent service configuration change preserved");
    fs.renameSync(temp, file); sync(path.dirname(file));
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
async function repair({ repo = process.cwd(), paths: p = PATHS, run = command, checkHealth = health, log = console.log,
  reviewRuntime = bytes => require("./liquid-catalog").nextRuntime(bytes) } = {}) {
  const locks = []; let stopped = false, backup;
  try {
    for (const dir of [p.work, p.releases, p.config, p.state]) if (!fs.lstatSync(dir).isDirectory()) throw Error("Expected a real service directory");
    for (const name of LOCKS) { const lock = path.join(p.work, name); fs.mkdirSync(lock, { mode: 0o700 }); locks.push(lock); }
    const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
    if (!/^[a-f0-9]{40}$/.test(target) || INSTALLED.includes(target) || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Use the clean reviewed memory-repair checkout");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (changed.length !== FILES.length || FILES.some(name => !changed.includes(name))) throw Error("Only the reviewed memory repair may be installed");
    const show = name => run("systemctl", ["show", UNIT, "--value", "--property=" + name], undefined, true).trim();
    const current = show("WorkingDirectory"), targetDir = path.join(p.releases, target);
    if (![...INSTALLED.map(s => path.join(p.releases, s)), targetDir].includes(current) || show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected service version or overrides; service unchanged");
    const unit = snapshot(p.unit), runtimeFile = path.join(p.config, "runtime.json"), runtime = snapshot(runtimeFile);
    const nextUnit = validateUnit(unit.bytes, p, current, targetDir), reviewed = reviewRuntime(runtime.bytes);
    if (!reviewed.already || !reviewed.bytes.equals(runtime.bytes)) throw Error("Expected the already installed Liquid catalog; configuration preserved");
    const digest = configDigest(p.config), unchanged = () => same(p.unit, unit) && same(runtimeFile, runtime) && configDigest(p.config) === digest;
    const healthOptions = { admission: true, recovery: true, paths: p, expected: runtimeTarget(runtimeFile),
      expectedQualification: reviewed.review.models, catalogPolicyHash: reviewed.review.catalogPolicyHash };
    if (current === targetDir) { await checkHealth(healthOptions); log("Memory repair is already installed and healthy."); return { unchanged: true, commit: target }; }
    if (fs.existsSync(targetDir)) throw Error("Prepared release already exists; preserve it for review");
    run(process.execPath, ["--test", "scripts/probe-koin-tokenizer-packs.js", "scripts/probe-koin-additive-catalog.js", "scripts/probe-koin-tokenizer-memory-update.js"], repo);
    backup = fs.mkdtempSync(path.join(p.work, "kai-tokenizer-memory-")); fs.chmodSync(backup, 0o700);
    fs.writeFileSync(path.join(backup, "previous.service"), unit.bytes, { mode: 0o600 }); sync(backup);
    const archive = path.join(backup, "source.tar"); run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
    const stage = fs.mkdtempSync(path.join(p.releases, ".tokenizer-memory-")); fs.chmodSync(stage, 0o755);
    try {
      const mask = process.umask(0o022);
      try { run("tar", ["-xf", archive, "-C", stage]); run("npm", ["ci", "--omit=dev", "--ignore-scripts"], stage); }
      finally { process.umask(mask); }
      if (!unchanged()) throw Error("Configuration changed during preparation");
      // Stop the failing restart loop before the memory-intensive preflight.
      // A previous OOM/ABRT exit is expected; do not require exit status zero.
      stopped = true; run("systemctl", ["stop", UNIT]);
      if (!["inactive", "failed"].includes(show("ActiveState")) || show("MainPID") !== "0") throw Error("Service process has not stopped");
      run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, "--max-old-space-size=768",
        path.join(stage, "scripts/verify-koin-catalog-memory.js"), p.config]);
      if (!unchanged()) throw Error("Concurrent configuration change preserved");
      fs.renameSync(stage, targetDir); sync(p.releases);
    } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
    replace(p.unit, unit, nextUnit, unchanged);
    run("systemctl", ["daemon-reload"]); run("systemctl", ["reset-failed", UNIT]); run("systemctl", ["start", UNIT]);
    if (show("WorkingDirectory") !== targetDir || show("ActiveState") !== "active") throw Error("Repaired service identity did not verify");
    await checkHealth(healthOptions);
    if (configDigest(p.config) !== digest || !same(runtimeFile, runtime) || !same(p.unit, { ...unit, bytes: nextUnit })) throw Error("Service configuration changed during recovery");
    log("Memory repair installed; loopback and public HTTPS health and all 16 models verified.");
    log("Wallets, accounts, credits, rewards, model admission and configuration were preserved.");
    return { commit: target, backup, unchanged: false };
  } catch (error) {
    if (stopped) log("Recovery needs attention; no financial records or configuration were restored. Check systemctl status " + UNIT + ". Previous unit: " + path.join(backup, "previous.service"));
    throw error;
  } finally { for (const lock of locks.reverse()) fs.rmdirSync(lock); }
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run repair-tokenizer-memory.js with system Node 22+ as root");
  process.umask(0o077); repair().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { repair, BASE, INSTALLED, FILES, LOCKS };
