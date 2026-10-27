"use strict";
// Coordinated code and reviewed model-admission installation. Account and
// payment databases, runtime keys, tariffs and reward budgets are never copied
// or restored. Rollback restores only the previous code and runtime policy.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { replacementUnit } = require("./update-prepaid-web");
const BASE = "9d4ad205cf06fe54cc1a38f7088e87443eb7e87b";
const INSTALLED = ["cbdb3a581bf6b1e188379f18b99654a496626142", BASE, "11474a9d851769bccfb56008b2a3d4cbd6521ff3"];
const UNIT = "kai-koin-prepaid.service", USER = "kai-koin-prepaid";
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const ORIGIN = "https://credits.koinosai.com";
const PATHS = { work: "/root", releases: "/opt/kai-koin-prepaid/releases", config: "/etc/kai-koin-prepaid", state: "/var/lib/kai-koin-prepaid", unit: "/etc/systemd/system/" + UNIT };
const ALLOWED = new Set([
  "lib/accounts.js", "lib/wallet-credit-auth.js", "lib/scheduler.js", "test-server.js",
  "lib/koin-network/provider-devices.js", "lib/koin-network/provider-device-protocol.js",
  "lib/koin-network/test-runtime.js", "lib/koin-network/prepaid-router.js", "lib/koin-network/prepaid-ledger.js",
  "lib/koin-network/provider-qualification.js", "lib/koin-network/qualification-evidence.js", "lib/koin-network/shadow-router.js",
  "lib/koin-network/provider-qualification-set.js", "lib/koin-network/provider-readiness.js", "lib/koin-network/network-overview.js",
  "lib/koin-network/qualification-protocol.js",
  "lib/koin-network/model-catalog.js", "scripts/probe-koin-model-catalog.js",
  "scripts/probe-koin-provider-devices.js", "scripts/probe-wallet-credit-auth.js", "scripts/probe-wallet-credit-router.js",
  "deploy/koin-mainnet/update-wallet-access.js", "deploy/koin-mainnet/update-wallet-access.test.js", "deploy/koin-mainnet/WALLET_ACCESS.md",
  "deploy/koin-mainnet/catalog-qualification.js", "deploy/koin-mainnet/qualification/catalog-2026-10-27.review.json", "scripts/probe-catalog-qualification.js",
  "deploy/koin-mainnet/wallet-access-readiness.js", "deploy/koin-mainnet/wallet-access-readiness.test.js",
  "scripts/probe-koin-on-demand-readiness.js",
  "scripts/probe-koin-multi-model-readiness.js", "scripts/probe-koin-qualification-preparation.js",
]);
const REQUIRED = ["lib/accounts.js", "lib/wallet-credit-auth.js", "lib/koin-network/provider-devices.js", "lib/koin-network/provider-device-protocol.js", "lib/koin-network/test-runtime.js", "test-server.js", "scripts/probe-koin-provider-devices.js", "scripts/probe-wallet-credit-auth.js", "deploy/koin-mainnet/catalog-qualification.js", "scripts/probe-catalog-qualification.js", "deploy/koin-mainnet/wallet-access-readiness.js"];
const PROBES = ["scripts/probe-koin-provider-devices.js", "scripts/probe-wallet-credit-auth.js", "scripts/probe-wallet-credit-router.js", "scripts/probe-koin-model-catalog.js", "scripts/probe-koin-credit-priority.js", "scripts/probe-koin-purchase-journal.js", "scripts/probe-catalog-qualification.js", "scripts/probe-koin-on-demand-readiness.js", "scripts/probe-koin-multi-model-readiness.js", "scripts/probe-koin-qualification-preparation.js", "deploy/koin-mainnet/update-wallet-access.test.js", "deploy/koin-mainnet/wallet-access-readiness.test.js"];
function command(exe, args, cwd, capture = false) {
  return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || "";
}
function real(file, directory) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw Error("Expected a real service " + (directory ? "directory" : "file"));
}
function validateUnit(bytes, p, oldDir, targetDir) {
  const lines = bytes.toString("utf8").split("\n");
  const exact = ["User=" + USER, "Group=" + USER, "ExecStart=" + process.execPath + " " + oldDir + "/test-server.js", "Environment=KAI_KOIN_TEST_CONFIG_DIR=" + p.config,
    "Environment=KAI_KOIN_TEST_STATE_DIR=" + p.state, "Environment=KAI_KOIN_TEST_PORT=3109",
    "EnvironmentFile=" + p.config + "/account.env", "ReadWritePaths=" + p.state, "ReadOnlyPaths=" + p.config,
    "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "UMask=0077"];
  for (const line of exact) {
    const name = line.slice(0, line.indexOf("=")), matches = lines.filter(v => v.startsWith(name + "="));
    if (lines.filter(v => v === line).length !== 1 || (name !== "Environment" && matches.length !== 1)) throw Error("Unexpected prepaid service identity or storage paths");
  }
  if (lines.filter(v => v.startsWith("Environment=")).length !== 3 || lines.some(v => /^Exec(StartPre|StartPost|Stop|StopPost|Reload)=/.test(v))) throw Error("Unexpected prepaid service commands or environment");
  return replacementUnit(bytes, oldDir, targetDir);
}
async function json(url, fetchImpl, headers, maxBytes = 32768) {
  const r = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(8000), ...(headers ? { headers } : {}) });
  if (!r.ok) throw Error("Service readiness HTTP " + r.status);
  const text = await r.text(); if (Buffer.byteLength(text) > maxBytes) throw Error("Oversized readiness response");
  return JSON.parse(text);
}
function assertHealth(h, now = Date.now()) {
  if (h.product !== "prepaid-usd-v1" || h.mode !== "mainnet-pilot" || h.mainnetPaymentsEnabled !== true || h.chainId !== CHAIN ||
      !Number.isSafeInteger(h.lastSuccess) || h.lastSuccess > now || now - h.lastSuccess > 60000) throw Error("Prepaid service heartbeat did not verify");
}
function assertCapabilities(provider, buyer, expected) {
  const p = provider.capabilities, b = buyer.capabilities;
  if (provider.ok !== true || p?.walletFirstEarning !== 1 || p?.delegatedProvider !== 1 || buyer.ok !== true || b?.walletCredits !== 1 || b.freeOnlySessions !== 1 || b.scope !== "wallet-credits" ||
      b.serviceOrigin !== ORIGIN || b.schedulerUrl !== ORIGIN + "/scheduler" || b.target?.chainId !== CHAIN) throw Error("Wallet access capabilities did not verify");
  if (expected && (provider.schedulerUrl !== ORIGIN + "/scheduler" || Object.entries(expected).some(([key, value]) => provider.target?.[key] !== value || b.target?.[key] !== value))) throw Error("Wallet capability deployment differs from existing runtime");
}
function runtimeTarget(file) {
  const c = JSON.parse(fs.readFileSync(file, "utf8")), d = c.deployment;
  if (c.schedulerUrl !== ORIGIN + "/scheduler" || c.mode !== "mainnet-pilot" || c.accountMode !== "public" || d?.chainId !== CHAIN || d.product !== "prepaid-usd-v1" || !d.credits || !d.creditsHash || !c.policyHash) throw Error("Unexpected prepaid runtime deployment");
  return { chainId: d.chainId, credits: d.credits, creditsHash: d.creditsHash, domain: require("../../lib/koin-network/payment-mode").testDomain(d, c.schedulerUrl), policyHash: c.policyHash };
}
async function health({ capabilities = true, expected, expectedQualification, paths: p = PATHS, fetchImpl = fetch, clock = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 90000 } = {}) {
  const until = clock() + timeoutMs;
  do {
    try {
      let observed;
      for (const origin of ["http://127.0.0.1:3109", ORIGIN]) {
        observed = await json(origin + "/health", fetchImpl); assertHealth(observed, clock());
        if (capabilities) assertCapabilities(await json(origin + "/scheduler/koin/provider/device/capabilities", fetchImpl), await json(origin + "/auth/wallet-credit/capabilities", fetchImpl), expected);
      }
      let operator;
      if (expectedQualification) {
        const secret = require("../../lib/koin-network/test-config").read(path.join(p.config, "operator-secret"), 256, true).trim();
        if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("Invalid operator credential");
        operator = await json("http://127.0.0.1:3109/operator/status", fetchImpl, { "x-operator-secret": secret }, 524288);
        if (operator.product !== "prepaid-usd-v1" || operator.chainId !== CHAIN ||
            JSON.stringify(operator.qualificationModels) !== JSON.stringify(expectedQualification)) throw Error("Running model qualification policies did not verify");
      }
      return { health: observed, operator };
    } catch (e) { if (clock() >= until) throw Error("Wallet service health check failed: " + e.message); }
    await wait(2000);
  } while (clock() < until);
  throw Error("Wallet service readiness timed out");
}
function readRuntime(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o022) || s.size > 2097152) throw Error("Untrusted runtime configuration");
    return { bytes: fs.readFileSync(fd), mode: s.mode & 0o777, uid: s.uid, gid: s.gid };
  } finally { fs.closeSync(fd); }
}
function sameRuntime(file, expected) {
  const now = readRuntime(file);
  return now.bytes.equals(expected.bytes) && now.mode === expected.mode && now.uid === expected.uid && now.gid === expected.gid;
}
function otherConfigDigest(root) {
  const digest = crypto.createHash("sha256");
  const visit = (file, relative) => {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink()) throw Error("Unexpected configuration symlink");
    if (relative === "runtime.json") return;
    digest.update(JSON.stringify([relative, s.mode, s.uid, s.gid]));
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    else if (s.isFile()) digest.update(fs.readFileSync(file));
    else throw Error("Unexpected configuration file type");
  };
  visit(root, ""); return digest.digest("hex");
}
function replaceRuntime(file, next, expected) {
  if (!sameRuntime(file, expected)) throw Error("Concurrent runtime configuration change preserved");
  const temporary = file + ".wallet-" + crypto.randomBytes(8).toString("hex"), fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, next.bytes); fs.fchownSync(fd, next.uid, next.gid); fs.fchmodSync(fd, next.mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (!sameRuntime(file, expected)) throw Error("Concurrent runtime configuration change preserved"); fs.renameSync(temporary, file);
  }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  const directory = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
async function update({ repo = process.cwd(), paths: p = PATHS, run = command, checkHealth = health, log = console.log,
  reviewRuntime = bytes => require("./catalog-qualification").nextRuntime(bytes),
  reportReadiness = options => require("./wallet-access-readiness").readiness(options) } = {}) {
  for (const dir of [p.work, p.releases, p.config, p.state]) real(dir, true);
  const lock = path.join(p.work, "kai-wallet-access-update.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
    if (!/^[a-f0-9]{40}$/.test(target) || target === BASE || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Use the clean reviewed wallet-access checkout");
    run("git", ["merge-base", "--is-ancestor", BASE, target], repo);
    const changed = run("git", ["diff", "--name-only", BASE, target], repo, true).trim().split("\n");
    if (REQUIRED.some(f => !changed.includes(f)) || changed.some(f => !ALLOWED.has(f))) throw Error("Only the reviewed wallet-access source change can be installed");
    const show = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key], undefined, true).trim();
    const targetDir = path.join(p.releases, target), current = show("WorkingDirectory");
    if (![...INSTALLED.map(s => path.join(p.releases, s)), targetDir].includes(current) || show("ActiveState") !== "active" || show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected prepaid service version or overrides; service unchanged");
    real(p.unit, false); real(current, true);
    const oldUnit = fs.readFileSync(p.unit), nextUnit = validateUnit(oldUnit, p, current, targetDir);
    const runtimeFile = path.join(p.config, "runtime.json"), before = readRuntime(runtimeFile), reviewed = reviewRuntime(before.bytes);
    const after = { ...before, bytes: reviewed.bytes }, expected = runtimeTarget(runtimeFile);
    const readyOptions = { capabilities: true, expected, expectedQualification: reviewed.review.models, paths: p };
    const report = async observed => {
      const summary = await reportReadiness({ config: JSON.parse(after.bytes), observed, paths: p, commit: target });
      log(JSON.stringify(summary, null, 2)); return summary;
    };
    if (current === targetDir) {
      if (!reviewed.already) throw Error("Installed code has a different admission policy; preserve it for review");
      const observed = await checkHealth(readyOptions); log("Wallet access is already installed and verified: " + target);
      return { installed: true, unchanged: true, commit: target, readiness: await report(observed) };
    }
    if (fs.existsSync(targetDir)) throw Error("Target release already exists; preserve it for review");
    // These fixture probes cannot submit payments or read the running databases.
    run(process.execPath, ["--test", ...PROBES], repo);
    const digest = otherConfigDigest(p.config), mode = fs.statSync(p.unit).mode & 0o777;
    const backup = fs.mkdtempSync(path.join(p.work, "kai-wallet-code-")); fs.chmodSync(backup, 0o700);
    fs.writeFileSync(path.join(backup, "previous.service"), oldUnit, { mode: 0o600 });
    fs.writeFileSync(path.join(backup, "previous-runtime.json"), before.bytes, { mode: 0o600 });
    fs.writeFileSync(path.join(backup, "next-runtime.json"), after.bytes, { mode: 0o600 });
    fs.writeFileSync(path.join(backup, "model-admission-review.json"), JSON.stringify(reviewed.review, null, 2) + "\n", { mode: 0o600 });
    const archive = path.join(backup, "source.tar"); run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
    const unchanged = (expectedUnit, expectedRuntime) => { real(p.unit, false); return fs.readFileSync(p.unit).equals(expectedUnit) && sameRuntime(runtimeFile, expectedRuntime) && otherConfigDigest(p.config) === digest; };
    const stage = fs.mkdtempSync(path.join(p.releases, ".wallet-" + target + "-")); fs.chmodSync(stage, 0o755);
    try {
      const mask = process.umask(0o022);
      try { run("tar", ["-xf", archive, "-C", stage]); run("npm", ["ci", "--omit=dev", "--ignore-scripts"], stage); }
      finally { process.umask(mask); }
      run("runuser", ["-u", USER, "--", process.execPath, "-e", "require(process.argv[1])", path.join(stage, "test-server.js")]);
      if (!unchanged(oldUnit, before)) throw Error("Configuration changed during preparation; service unchanged");
      fs.renameSync(stage, targetDir);
    } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
    const writeUnit = (bytes, expectedUnit, expectedRuntime) => {
      if (!unchanged(expectedUnit, expectedRuntime)) throw Error("Concurrent service configuration change preserved");
      const temp = fs.mkdtempSync(path.join(path.dirname(p.unit), ".kai-wallet-unit-"));
      try { const file = path.join(temp, "service"); fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode); fs.renameSync(file, p.unit); }
      finally { fs.rmSync(temp, { recursive: true, force: true }); }
    };
    let attemptedStop = false, switched = false, runtimeWritten = false, observed;
    try {
      attemptedStop = true; run("systemctl", ["stop", UNIT]);
      if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Prepaid service did not stop cleanly");
      if (!unchanged(oldUnit, before)) throw Error("Concurrent service configuration change preserved");
      if (!reviewed.already) { runtimeWritten = true; replaceRuntime(runtimeFile, after, before); }
      writeUnit(nextUnit, oldUnit, after); switched = true;
      run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
      if (!unchanged(nextUnit, after) || show("WorkingDirectory") !== targetDir) throw Error("Updated service identity or configuration changed");
      observed = await checkHealth(readyOptions);
      if (!unchanged(nextUnit, after)) throw Error("Configuration changed during readiness check");
    } catch (error) {
      try {
        if ((switched || runtimeWritten) && unchanged(switched ? nextUnit : oldUnit, after)) {
          run("systemctl", ["stop", UNIT]);
          if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Updated service did not stop cleanly");
          if (switched) writeUnit(oldUnit, nextUnit, after);
          if (runtimeWritten) replaceRuntime(runtimeFile, before, after);
          run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
          await checkHealth({ capabilities: false });
          log("Previous code and model admission restored. New account, device, payment and usage records were retained.");
        } else if (attemptedStop && !switched && unchanged(oldUnit, before) && show("ActiveState") === "inactive") {
          run("systemctl", ["start", UNIT]);
        } else if (attemptedStop) log("Concurrent changes or incomplete shutdown preserved; service recovery needs attention. Previous unit: " + path.join(backup, "previous.service"));
      } catch { log("Automatic code recovery could not finish. Previous unit: " + path.join(backup, "previous.service")); }
      // Preserve the prepared source for inspection, while allowing an exact
      // retry after a confirmed return to the previous running release.
      try { if (unchanged(oldUnit, before) && show("WorkingDirectory") === current && show("ActiveState") === "active") fs.renameSync(targetDir, path.join(backup, "unused-release")); }
      catch { log("Prepared source was retained at " + targetDir); }
      throw error;
    }
    log("Wallet access code installed and HTTPS capabilities verified: " + target);
    log("All configured models now have reviewed qualification criteria; each device must still pass fresh signed checks.");
    log("Prices, free-credit budgets, account balances, keys and transaction records were preserved.");
    const readiness = await report(observed);
    fs.writeFileSync(path.join(backup, "readiness.json"), JSON.stringify(readiness, null, 2) + "\n", { mode: 0o600 });
    return { installed: true, unchanged: false, commit: target, backup, readiness };
  } finally { fs.rmdirSync(lock); }
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root, with no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, assertHealth, assertCapabilities, validateUnit, runtimeTarget, BASE, INSTALLED, UNIT, PATHS, REQUIRED, ALLOWED, PROBES };
