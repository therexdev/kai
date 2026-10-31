"use strict";
// Reviewed code + admission-policy transition. Never restore earlier live
// databases, qualification journals, signed evidence or payment records.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { validateUnit, runtimeTarget, health: walletHealth, UNIT, PATHS } = require("./update-wallet-access");
const BASE = "daf2dc4cb19c84412f00d8552b348ebb4a8e0bd8";
const INSTALLED = [BASE];
const LOCKS = ["kai-liquid-catalog-update.lock", "kai-model-readiness-update.lock", "kai-provider-qualification-update.lock", "kai-purchase-quotes-update.lock", "kai-wallet-access-update.lock"];
const ALLOWED = new Set(["lib/scheduler.js","lib/koin-network/additive-catalog.js", "lib/koin-network/gguf-tokenizer.js", "lib/koin-network/model-catalog.js", "lib/koin-network/prepaid-ledger.js", "lib/koin-network/prepaid-router.js", "lib/koin-network/provider-devices.js", "lib/koin-network/provider-qualification-set.js", "lib/koin-network/provider-readiness.js", "lib/koin-network/qualification-evidence.js", "lib/koin-network/test-config.js", "lib/koin-network/test-runtime.js", "scripts/probe-koin-gguf-tokenizer.js", "scripts/measure-koin-lfm3-readiness.js", "scripts/probe-koin-additive-catalog.js", "deploy/koin-mainnet/candidates/LIQUID_LFM3.md", "deploy/koin-mainnet/candidates/liquid-lfm3-1.7b.json", "deploy/koin-mainnet/candidates/liquid-lfm3-1.7b.observation.json", "deploy/koin-mainnet/liquid-catalog.js", "deploy/koin-mainnet/qualification/liquid-lfm3-1.7b.review.json", "deploy/koin-mainnet/update-liquid-catalog.js", "deploy/koin-mainnet/update-liquid-catalog.test.js", "deploy/koin-mainnet/LIQUID_CATALOG_UPDATE.md"]);
const REQUIRED = [...ALLOWED];
const PROBES = ["scripts/probe-koin-additive-catalog.js", "scripts/probe-koin-gguf-tokenizer.js", "scripts/probe-koin-model-readiness.js", "scripts/probe-koin-model-catalog.js", "scripts/probe-koin-provider-devices.js", "scripts/probe-koin-prepaid.js", "scripts/probe-koin-credit-priority.js", "scripts/probe-wallet-credit-auth.js", "scripts/probe-wallet-credit-router.js", "deploy/koin-mainnet/update-liquid-catalog.test.js"];
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
  const old=JSON.parse(before),next=JSON.parse(after);
  delete old.catalogExtension; delete next.catalogExtension;
  if (old.freePolicy?.eligibleModels && next.freePolicy?.eligibleModels) {
    const expected=[...old.freePolicy.eligibleModels];if(!expected.includes("lfm3-1.7b"))expected.push("lfm3-1.7b");
    if(JSON.stringify(expected)!==JSON.stringify(next.freePolicy.eligibleModels))throw Error("Existing free model eligibility changed");
    next.freePolicy.eligibleModels=old.freePolicy.eligibleModels;
  }
  if(JSON.stringify(old)!==JSON.stringify(next))throw Error("Liquid update may only add its reviewed catalog and free eligibility");
}
async function prepareTokenizer(p, repo) {
  const manifest=require("./liquid-catalog").reviewed().review.tokenizer, parent=path.join(p.config,"tokenizer"), destination=path.join(parent,manifest.model);
  realDirectory(parent);
  if(fs.existsSync(destination)){require("../../lib/koin-network/tokenizer").loadTokenizer(destination,manifest);return;}
  const temporary=fs.mkdtempSync(path.join(p.work,"kai-liquid-tokenizer-"));fs.chmodSync(temporary,0o700);
  try {
    await require("../../lib/koin-network/tokenizer-pack").install(temporary,manifest);
    const staged=fs.mkdtempSync(path.join(parent,".liquid-")),owner=fs.statSync(parent);
    try {
      for(const name of ["tokenizer.json","tokenizer_config.json"]){
        const file=path.join(staged,name);fs.copyFileSync(path.join(temporary,name),file,fs.constants.COPYFILE_EXCL);
        fs.chownSync(file,owner.uid,owner.gid);fs.chmodSync(file,0o640);const fd=fs.openSync(file,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      }
      fs.chownSync(staged,owner.uid,owner.gid);fs.chmodSync(staged,0o750);syncDirectory(staged);
      require("../../lib/koin-network/tokenizer").loadTokenizer(staged,manifest);
      if(fs.existsSync(destination))throw Error("Concurrent Liquid tokenizer installation preserved");
      fs.renameSync(staged,destination);syncDirectory(parent);
    } finally {if(fs.existsSync(staged))fs.rmSync(staged,{recursive:true});}
  } finally {fs.rmSync(temporary,{recursive:true});}
}
async function health({fetchImpl=fetch,catalogPolicyHash,...options}={}) {
  const checked=await require("./update-model-readiness").health({...options,fetchImpl});
  if(catalogPolicyHash) for(const origin of ["http://127.0.0.1:3109","https://credits.koinosai.com"]){
    const response=await fetchImpl(origin+"/scheduler/koin/provider/device/capabilities",{headers:{"x-kai-catalog-policy":catalogPolicyHash},redirect:"error",signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error("Extended catalog is not reachable");const text=await response.text();if(Buffer.byteLength(text)>262144)throw Error("Extended catalog too large");
    const value=JSON.parse(text),catalog=value.catalog,r=require("./liquid-catalog").reviewed();
    if(value.ok!==true||value.target?.policyHash!==options.expected?.policyHash||catalog?.policyHash!==catalogPolicyHash||catalog.tariffs?.length!==16||!catalog.models?.some(m=>m.model===r.review.model))throw Error("Running Liquid catalog differs");
    const tariffs=[...catalog.tariffs].sort((a,b)=>`${a.model}:${a.version}`<`${b.model}:${b.version}`?-1:1);
    if(require("../../lib/koin-network/job-protocol").hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1",...tariffs]))!==catalogPolicyHash)throw Error("Running catalog commitment differs");
  }
  return checked;
}
async function update({ approve, repo = process.cwd(), paths: p = PATHS, run = command, checkHealth = health, log = console.log,
  prepare = prepareTokenizer, reviewRuntime = bytes => require("./liquid-catalog").nextRuntime(bytes) } = {}) {
  if (!/^[a-f0-9]{64}$/.test(approve || "")) throw Error("Exact reviewed liquid-catalog approval hash required");
  for (const dir of [p.work, p.releases, p.config, p.state]) realDirectory(dir);
  const locks = [];
  try {
    // Exclude old reviewed updaters as well as another copy of this updater.
    for (const name of LOCKS) { const lock = path.join(p.work, name); fs.mkdirSync(lock, { mode: 0o700 }); locks.push(lock); }
    const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
    if (!/^[a-f0-9]{40}$/.test(target) || INSTALLED.includes(target) || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Use the clean reviewed liquid-catalog checkout");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (REQUIRED.some(name => !changed.includes(name)) || changed.some(name => !ALLOWED.has(name))) throw Error("Only the reviewed liquid-catalog update can be installed");
    const show = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key], undefined, true).trim();
    const current = show("WorkingDirectory"), targetDir = path.join(p.releases, target);
    if (![...INSTALLED.map(c => path.join(p.releases, c)), targetDir].includes(current) || show("ActiveState") !== "active" || show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected prepaid service version or overrides; service unchanged");
    realDirectory(current);
    const beforeUnit = snapshot(p.unit), afterUnit = { ...beforeUnit, bytes: validateUnit(beforeUnit.bytes, p, current, targetDir) };
    const runtimeFile = path.join(p.config, "runtime.json"), before = snapshot(runtimeFile), reviewed = reviewRuntime(before.bytes);
    if (reviewed.review?.reviewHash !== approve || reviewed.review?.eligibilityCreated !== false || !Array.isArray(reviewed.review?.models) || !Buffer.isBuffer(reviewed.bytes)) throw Error("Model-readiness approval does not match the reviewed policy");
    onlyAdmissionChanged(before.bytes, reviewed.bytes);
    const after = { ...before, bytes: reviewed.bytes }, expected = runtimeTarget(runtimeFile), tokenizerPath=path.join(p.config,"tokenizer","lfm3-1.7b"), priorDigest=configDigest(p.config,tokenizerPath);
    // Downloads and native tokenizer vectors finish while the old service runs.
    await prepare(p,repo);
    if(!sameFile(p.unit,beforeUnit)||!sameFile(runtimeFile,before)||configDigest(p.config,tokenizerPath)!==priorDigest)throw Error("Configuration changed during tokenizer preparation");
    const digest = configDigest(p.config);
    const ready = { admission: true, recovery: true, catalogPolicyHash: reviewed.review.catalogPolicyHash, expected, expectedQualification: reviewed.review.models, paths: p };
    const unchanged = (unit, runtime, ownTemporary) => sameFile(p.unit, unit) && sameFile(runtimeFile, runtime) && configDigest(p.config, ownTemporary) === digest;
    if (current === targetDir) {
      if (!reviewed.already || !after.bytes.equals(before.bytes)) throw Error("Installed code has a different readiness policy; preserve it for review");
      await checkHealth(ready);
      if (!unchanged(beforeUnit, before)) throw Error("Configuration changed during readiness check");
      log("Reviewed Liquid model catalog is already installed and verified: " + target);
      return { installed: true, unchanged: true, commit: target, reviewHash: approve, eligibilityCreated: false };
    }
    if (reviewed.already) throw Error("Existing code has an unexpected readiness policy; preserve it for review");
    if (fs.existsSync(targetDir)) throw Error("Target release already exists; preserve it for review");
    run(process.execPath, ["--test", ...PROBES], repo);
    const backup = fs.mkdtempSync(path.join(p.work, "kai-liquid-catalog-code-")); fs.chmodSync(backup, 0o700);
    for (const [name, bytes] of [["previous.service", beforeUnit.bytes], ["previous-runtime.json", before.bytes], ["next-runtime.json", after.bytes], ["liquid-catalog-review.json", JSON.stringify(reviewed.review, null, 2) + "\n"]]) {
      const fd = fs.openSync(path.join(backup, name), "wx", 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    syncDirectory(backup);
    const archive = path.join(backup, "source.tar"); run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
    const preserveUnused = () => {
      if (fs.existsSync(targetDir) && unchanged(beforeUnit, before) && show("WorkingDirectory") === current && show("ActiveState") === "active") {
        fs.renameSync(targetDir, path.join(backup, "unused-release")); syncDirectory(p.releases);
      }
    };
    const stage = fs.mkdtempSync(path.join(p.releases, ".liquid-catalog-" + target + "-")); fs.chmodSync(stage, 0o755);
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
    let attemptedStop = false, attemptedStart = false;
    try {
      attemptedStop = true; run("systemctl", ["stop", UNIT]); stopped();
      if (!unchanged(beforeUnit, before)) throw Error("Concurrent service configuration change preserved");
      // A stopped, consistent private snapshot is recovery evidence only.
      // It must never be restored over newer financial records.
      run("tar",["-cpf",path.join(backup,"state-before-update.tar"),"-C",p.state,"."]);
      const fd=fs.openSync(path.join(backup,"state-before-update.tar"),"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(backup);
      if (!after.bytes.equals(before.bytes)) atomicFile(runtimeFile, after, before, temporary => unchanged(beforeUnit, before, temporary));
      atomicFile(p.unit, afterUnit, beforeUnit, temporary => unchanged(beforeUnit, after, temporary));
      run("systemctl", ["daemon-reload"]); attemptedStart = true; run("systemctl", ["start", UNIT]);
      if (!unchanged(afterUnit, after) || show("WorkingDirectory") !== targetDir || show("ActiveState") !== "active") throw Error("Updated service identity or configuration changed");
      await checkHealth(ready);
      if (!unchanged(afterUnit, after)) throw Error("Configuration changed during readiness check");
    } catch (error) {
      if(attemptedStart){
        // New jobs may already reference Liquid. Older code cannot recover
        // those receipts; never roll its catalog or money records backwards.
        log("New code and catalog retained for recovery; no financial records were restored. Check systemctl status "+UNIT+". Private backup: "+backup);
        throw error;
      }
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
          await checkHealth({ admission: false, recovery: true, expected, paths: p });
          if (!unchanged(beforeUnit, before)) throw Error("Configuration changed during recovery check");
          log("Previous code and admission policy restored. Current accounts, payments, rewards and qualification evidence were retained.");
        } else if (attemptedStop) log("Concurrent changes preserved; service recovery needs attention. Previous unit: " + path.join(backup, "previous.service"));
      } catch { log("Automatic recovery could not finish. Previous unit: " + path.join(backup, "previous.service")); }
      try { preserveUnused(); } catch { log("Prepared source retained at " + targetDir); }
      throw error;
    }
    log("Reviewed Liquid model catalog installed and verified on loopback and HTTPS: " + target);
    log("Each model requires fresh signed readiness checks. Old quality evidence was retained; no existing failure was promoted to eligibility.");
    log("Existing prices, reward budgets, wallet keys, accounts and transaction records were preserved. Liquid requires each provider to pass fresh readiness checks.");
    return { installed: true, unchanged: false, commit: target, reviewHash: approve, backup, eligibilityCreated: false };
  } finally { for (const lock of locks.reverse()) fs.rmdirSync(lock); }
}
if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== "--approve" || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root: update-liquid-catalog.js --approve <reviewed policy hash>");
  process.umask(0o077); update({ approve: process.argv[3] }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, BASE, INSTALLED, LOCKS, ALLOWED, REQUIRED, PROBES, UNIT, PATHS, onlyAdmissionChanged, prepareTokenizer };
