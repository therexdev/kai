"use strict";
// Reviewed code + admission-policy transition. Never restore earlier live
// databases, qualification journals, signed evidence or payment records.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { validateUnit, runtimeTarget, health: walletHealth, UNIT, PATHS } = require("./update-wallet-access");
const BASE = "80eb56c94600b800c0b69910acde0937f0da052d";
const INSTALLED = ["b85363e6c6188fb215e9a98fc8fdaed5869ede75", BASE];
const LOCKS = ["kai-model-readiness-update.lock", "kai-provider-qualification-update.lock", "kai-purchase-quotes-update.lock", "kai-wallet-access-update.lock"];
const ALLOWED = new Set([
  "lib/koin-network/provider-qualification.js", "lib/koin-network/provider-qualification-set.js", "lib/koin-network/provider-readiness.js",
  "lib/koin-network/test-config.js", "lib/koin-network/test-runtime.js", "lib/koin-network/qualification-evidence.js", "lib/koin-network/runtime-readiness.js", "lib/koin-network/shadow.js", "test-server.js",
  "lib/accounts.js", "lib/device-free-auth.js", "lib/koin-network/prepaid-router.js", "scripts/probe-koin-device-free-auth.js", "scripts/probe-koin-device-free-router.js",
  "deploy/koin-mainnet/model-readiness.js", "deploy/koin-mainnet/qualification/model-readiness-2026-10-27.review.json",
  ...["koinos-fast", "gemma3-4b", "llama31-8b", "mistral-7b"].map(model => `deploy/koin-mainnet/qualification/model-readiness-2026-10-27.${model}.observation.json`),
  "deploy/koin-mainnet/update-model-readiness.js", "deploy/koin-mainnet/update-model-readiness.test.js", "deploy/koin-mainnet/MODEL_READINESS_UPDATE.md",
  "scripts/probe-koin-model-readiness.js", "scripts/probe-koin-automatic-qualification.js", "scripts/probe-koin-qualification-scheduling.js",
  "scripts/probe-koin-qualification-preparation.js", "scripts/probe-koin-provider-readiness.js", "scripts/probe-koin-multi-model-readiness.js",
  "scripts/probe-catalog-qualification.js", ".github/workflows/koin-pilot.yml",
]);
const REQUIRED = ["lib/koin-network/provider-qualification.js", "lib/koin-network/provider-qualification-set.js", "lib/koin-network/runtime-readiness.js", "lib/koin-network/shadow.js", "lib/koin-network/test-runtime.js", "lib/koin-network/qualification-evidence.js", "lib/accounts.js", "lib/device-free-auth.js", "lib/koin-network/prepaid-router.js", "scripts/probe-koin-device-free-auth.js", "scripts/probe-koin-device-free-router.js", "deploy/koin-mainnet/model-readiness.js", "deploy/koin-mainnet/qualification/model-readiness-2026-10-27.review.json", "scripts/probe-koin-model-readiness.js", "test-server.js", "deploy/koin-mainnet/update-model-readiness.js", "deploy/koin-mainnet/update-model-readiness.test.js"];
const PROBES = ["scripts/probe-koin-model-readiness.js", "scripts/probe-koin-device-free-auth.js", "scripts/probe-koin-device-free-router.js", "scripts/probe-koin-qualification-scheduling.js", "scripts/probe-koin-automatic-qualification.js", "scripts/probe-koin-qualification-preparation.js", "scripts/probe-koin-multi-model-readiness.js", "scripts/probe-koin-provider-devices.js", "scripts/probe-koin-provider-readiness.js", "scripts/probe-koin-on-demand-readiness.js", "scripts/probe-koin-prepaid.js", "scripts/probe-wallet-credit-auth.js", "scripts/probe-wallet-credit-router.js", "deploy/koin-mainnet/update-model-readiness.test.js"];
function command(exe, args, cwd, capture = false) {
  return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || "";
}
function realDirectory(file) { if (!fs.lstatSync(file).isDirectory()) throw Error("Expected a real prepaid service directory"); }
function syncDirectory(directory) { const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function snapshot(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o022) || s.size > 2097152) throw Error("Untrusted prepaid service configuration");
    return { bytes: fs.readFileSync(fd), mode: s.mode & 0o777, uid: s.uid, gid: s.gid };
  } finally { fs.closeSync(fd); }
}
function sameFile(file, expected) { const now = snapshot(file); return now.bytes.equals(expected.bytes) && now.mode === expected.mode && now.uid === expected.uid && now.gid === expected.gid; }
function configDigest(directory, ownTemporary) {
  const hash = crypto.createHash("sha256");
  const visit = (file, relative) => {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink()) throw Error("Unexpected prepaid configuration symlink");
    if (relative === "runtime.json" || file === ownTemporary) return;
    hash.update(JSON.stringify([relative, s.mode, s.uid, s.gid]));
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    else if (s.isFile()) hash.update(fs.readFileSync(file));
    else throw Error("Unexpected prepaid configuration file type");
  };
  visit(directory, ""); return hash.digest("hex");
}
function atomicFile(file, next, expected, guard) {
  if (!sameFile(file, expected) || !guard()) throw Error("Concurrent service configuration change preserved");
  const temporary = file + ".readiness-" + crypto.randomBytes(8).toString("hex"), fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, next.bytes); fs.fchownSync(fd, next.uid, next.gid); fs.fchmodSync(fd, next.mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (!sameFile(file, expected) || !guard(temporary)) throw Error("Concurrent service configuration change preserved");
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function onlyAdmissionChanged(before, after) {
  const old = JSON.parse(before), next = JSON.parse(after);
  delete old.qualificationPolicies; delete next.qualificationPolicies;
  if (JSON.stringify(old) !== JSON.stringify(next)) throw Error("Readiness migration may change only qualificationPolicies");
}
async function health({ admission = true, recovery = true, deviceFree = admission, fetchImpl = fetch, ...options } = {}) {
  return walletHealth({ ...options, capabilities: true, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (deviceFree && url.endsWith("/auth/wallet-credit/capabilities") && response.ok) {
      const body = await response.text(); if (Buffer.byteLength(body) > 32768) throw Error("Credit capability response too large");
      const buyer = JSON.parse(body), guestResponse = await fetchImpl(new URL("/auth/device-free/capabilities", url).href, init);
      if (!guestResponse.ok) throw Error("Automatic free access is not active");
      const guestBody = await guestResponse.text(); if (Buffer.byteLength(guestBody) > 32768) throw Error("Free-device capability response too large");
      const guest = JSON.parse(guestBody), c = guest.capabilities, b = buyer.capabilities;
      if (guest.ok !== true || c?.deviceFreeCredits !== 1 || c.scope !== "device-free" || c.freeOnly !== true || c.algorithm !== "Ed25519" ||
          c.challengeTtlMs !== 300000 || c.sessionTtlMs !== 86400000 || c.serviceOrigin !== b?.serviceOrigin || c.schedulerUrl !== b?.schedulerUrl ||
          JSON.stringify(c.target) !== JSON.stringify(b?.target)) throw Error("Automatic free access capability differs from the reviewed deployment");
      return { ok: response.ok, status: response.status, text: async () => body };
    }
    if (!url.endsWith("/health") || !response.ok) return response;
    const body = await response.text();
    if (Buffer.byteLength(body) > 32768) throw Error("Model readiness health response too large");
    const value = JSON.parse(body);
    if (value.purchaseQuotesUnlimited !== true) throw Error("Existing unlimited purchase quotes are not active");
    if (recovery && value.providerQualificationRecovery !== 1) throw Error("Provider qualification recovery is not active");
    if (admission && value.modelReadinessAdmission !== 1) throw Error("Reviewed model readiness admission is not active");
    return { ok: response.ok, status: response.status, text: async () => body };
  } });
}
async function update({ approve, repo = process.cwd(), paths: p = PATHS, run = command, checkHealth = health, log = console.log,
  reviewRuntime = bytes => require("./model-readiness").nextRuntime(bytes) } = {}) {
  if (!/^[a-f0-9]{64}$/.test(approve || "")) throw Error("Exact reviewed model-readiness approval hash required");
  for (const dir of [p.work, p.releases, p.config, p.state]) realDirectory(dir);
  const locks = [];
  try {
    // Exclude old reviewed updaters as well as another copy of this updater.
    for (const name of LOCKS) { const lock = path.join(p.work, name); fs.mkdirSync(lock, { mode: 0o700 }); locks.push(lock); }
    const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
    if (!/^[a-f0-9]{40}$/.test(target) || INSTALLED.includes(target) || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Use the clean reviewed model-readiness checkout");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (REQUIRED.some(name => !changed.includes(name)) || changed.some(name => !ALLOWED.has(name))) throw Error("Only the reviewed model-readiness update can be installed");
    const show = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key], undefined, true).trim();
    const current = show("WorkingDirectory"), targetDir = path.join(p.releases, target);
    if (![...INSTALLED.map(c => path.join(p.releases, c)), targetDir].includes(current) || show("ActiveState") !== "active" || show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected prepaid service version or overrides; service unchanged");
    realDirectory(current);
    const beforeUnit = snapshot(p.unit), afterUnit = { ...beforeUnit, bytes: validateUnit(beforeUnit.bytes, p, current, targetDir) };
    const runtimeFile = path.join(p.config, "runtime.json"), before = snapshot(runtimeFile), reviewed = reviewRuntime(before.bytes);
    if (reviewed.review?.reviewHash !== approve || reviewed.review?.eligibilityCreated !== false || !Array.isArray(reviewed.review?.models) || !Buffer.isBuffer(reviewed.bytes)) throw Error("Model-readiness approval does not match the reviewed policy");
    onlyAdmissionChanged(before.bytes, reviewed.bytes);
    const after = { ...before, bytes: reviewed.bytes }, expected = runtimeTarget(runtimeFile), digest = configDigest(p.config);
    const ready = { admission: true, recovery: true, expected, expectedQualification: reviewed.review.models, paths: p };
    const unchanged = (unit, runtime, ownTemporary) => sameFile(p.unit, unit) && sameFile(runtimeFile, runtime) && configDigest(p.config, ownTemporary) === digest;
    if (current === targetDir) {
      if (!reviewed.already || !after.bytes.equals(before.bytes)) throw Error("Installed code has a different readiness policy; preserve it for review");
      await checkHealth(ready);
      if (!unchanged(beforeUnit, before)) throw Error("Configuration changed during readiness check");
      log("Reviewed model readiness is already installed and verified: " + target);
      return { installed: true, unchanged: true, commit: target, reviewHash: approve, eligibilityCreated: false };
    }
    if (reviewed.already) throw Error("Existing code has an unexpected readiness policy; preserve it for review");
    if (fs.existsSync(targetDir)) throw Error("Target release already exists; preserve it for review");
    run(process.execPath, ["--test", ...PROBES], repo);
    const backup = fs.mkdtempSync(path.join(p.work, "kai-model-readiness-code-")); fs.chmodSync(backup, 0o700);
    for (const [name, bytes] of [["previous.service", beforeUnit.bytes], ["previous-runtime.json", before.bytes], ["next-runtime.json", after.bytes], ["model-readiness-review.json", JSON.stringify(reviewed.review, null, 2) + "\n"]]) {
      const fd = fs.openSync(path.join(backup, name), "wx", 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    syncDirectory(backup);
    const archive = path.join(backup, "source.tar"); run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
    const preserveUnused = () => {
      if (fs.existsSync(targetDir) && unchanged(beforeUnit, before) && show("WorkingDirectory") === current && show("ActiveState") === "active") {
        fs.renameSync(targetDir, path.join(backup, "unused-release")); syncDirectory(p.releases);
      }
    };
    const stage = fs.mkdtempSync(path.join(p.releases, ".model-readiness-" + target + "-")); fs.chmodSync(stage, 0o755);
    try {
      const mask = process.umask(0o022);
      try { run("tar", ["-xf", archive, "-C", stage]); run("npm", ["ci", "--omit=dev", "--ignore-scripts"], stage); }
      finally { process.umask(mask); }
      run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, "-e", "require(process.argv[1])", path.join(stage, "test-server.js")]);
      if (!unchanged(beforeUnit, before)) throw Error("Configuration changed during preparation; service unchanged");
      fs.renameSync(stage, targetDir); syncDirectory(p.releases);
    } catch (error) { try { preserveUnused(); } catch {} throw error; }
    finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
    const stopped = () => { if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Prepaid service did not stop cleanly"); };
    let attemptedStop = false;
    try {
      attemptedStop = true; run("systemctl", ["stop", UNIT]); stopped();
      if (!unchanged(beforeUnit, before)) throw Error("Concurrent service configuration change preserved");
      if (!after.bytes.equals(before.bytes)) atomicFile(runtimeFile, after, before, temporary => unchanged(beforeUnit, before, temporary));
      atomicFile(p.unit, afterUnit, beforeUnit, temporary => unchanged(beforeUnit, after, temporary));
      run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
      if (!unchanged(afterUnit, after) || show("WorkingDirectory") !== targetDir || show("ActiveState") !== "active") throw Error("Updated service identity or configuration changed");
      await checkHealth(ready);
      if (!unchanged(afterUnit, after)) throw Error("Configuration changed during readiness check");
    } catch (error) {
      try {
        // Inspect persisted bytes, not completed-call flags: rename can succeed
        // before a directory fsync fails. Recover either partial transition.
        const unit = sameFile(p.unit, afterUnit) ? afterUnit : sameFile(p.unit, beforeUnit) ? beforeUnit : null;
        const runtime = sameFile(runtimeFile, after) ? after : sameFile(runtimeFile, before) ? before : null;
        if (unit && runtime && unchanged(unit, runtime)) {
          if (show("ActiveState") !== "inactive") run("systemctl", ["stop", UNIT]);
          stopped();
          if (!unit.bytes.equals(beforeUnit.bytes)) atomicFile(p.unit, beforeUnit, unit, temporary => unchanged(unit, runtime, temporary));
          if (!runtime.bytes.equals(before.bytes)) atomicFile(runtimeFile, before, runtime, temporary => unchanged(beforeUnit, runtime, temporary));
          run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
          await checkHealth({ admission: false, recovery: current.endsWith("/" + BASE), expected, paths: p });
          if (!unchanged(beforeUnit, before)) throw Error("Configuration changed during recovery check");
          log("Previous code and admission policy restored. Current accounts, payments, rewards and qualification evidence were retained.");
        } else if (attemptedStop) log("Concurrent changes preserved; service recovery needs attention. Previous unit: " + path.join(backup, "previous.service"));
      } catch { log("Automatic recovery could not finish. Previous unit: " + path.join(backup, "previous.service")); }
      try { preserveUnused(); } catch { log("Prepared source retained at " + targetDir); }
      throw error;
    }
    log("Reviewed model readiness installed and verified on loopback and HTTPS: " + target);
    log("Each model requires fresh signed readiness checks. Old quality evidence was retained; no existing failure was promoted to eligibility.");
    log("Prices, reward rules, wallet keys, accounts and transaction records were preserved.");
    return { installed: true, unchanged: false, commit: target, reviewHash: approve, backup, eligibilityCreated: false };
  } finally { for (const lock of locks.reverse()) fs.rmdirSync(lock); }
}
if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== "--approve" || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root: update-model-readiness.js --approve <reviewed policy hash>");
  process.umask(0o077); update({ approve: process.argv[3] }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, BASE, INSTALLED, LOCKS, ALLOWED, REQUIRED, PROBES, UNIT, PATHS };
