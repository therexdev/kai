"use strict";
// Code-only installation into the separate prepaid service. This program never
// copies/restores account databases, payment records, runtime keys or policy.
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { configDigest, replacementUnit } = require("./update-prepaid-web");
const BASE = "9d4ad205cf06fe54cc1a38f7088e87443eb7e87b";
const INSTALLED = ["cbdb3a581bf6b1e188379f18b99654a496626142", BASE];
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
  "scripts/probe-koin-provider-devices.js", "scripts/probe-wallet-credit-auth.js", "scripts/probe-wallet-credit-router.js",
  "deploy/koin-mainnet/update-wallet-access.js", "deploy/koin-mainnet/update-wallet-access.test.js", "deploy/koin-mainnet/WALLET_ACCESS.md",
]);
const REQUIRED = ["lib/accounts.js", "lib/wallet-credit-auth.js", "lib/koin-network/provider-devices.js", "lib/koin-network/provider-device-protocol.js", "lib/koin-network/test-runtime.js", "test-server.js", "scripts/probe-koin-provider-devices.js", "scripts/probe-wallet-credit-auth.js"];
const PROBES = ["scripts/probe-koin-provider-devices.js", "scripts/probe-wallet-credit-auth.js", "scripts/probe-wallet-credit-router.js", "scripts/probe-koin-credit-priority.js", "scripts/probe-koin-purchase-journal.js", "deploy/koin-mainnet/update-wallet-access.test.js"];
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
async function json(url, fetchImpl) {
  const r = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Error("Service readiness HTTP " + r.status);
  const text = await r.text(); if (Buffer.byteLength(text) > 32768) throw Error("Oversized readiness response");
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
async function health({ capabilities = true, expected, fetchImpl = fetch, clock = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 90000 } = {}) {
  const until = clock() + timeoutMs;
  do {
    try {
      for (const origin of ["http://127.0.0.1:3109", ORIGIN]) {
        assertHealth(await json(origin + "/health", fetchImpl), clock());
        if (capabilities) assertCapabilities(await json(origin + "/scheduler/koin/provider/device/capabilities", fetchImpl), await json(origin + "/auth/wallet-credit/capabilities", fetchImpl), expected);
      }
      return;
    } catch (e) { if (clock() >= until) throw Error("Wallet service health check failed: " + e.message); }
    await wait(2000);
  } while (clock() < until);
  throw Error("Wallet service readiness timed out");
}
async function update({ repo = process.cwd(), paths: p = PATHS, run = command, checkHealth = health, log = console.log } = {}) {
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
    const expected = runtimeTarget(path.join(p.config, "runtime.json"));
    if (current === targetDir) { await checkHealth({ capabilities: true, expected }); log("Wallet access is already installed and verified: " + target); return { installed: true, unchanged: true, commit: target }; }
    if (fs.existsSync(targetDir)) throw Error("Target release already exists; preserve it for review");
    // These fixture probes cannot submit payments or read the running databases.
    run(process.execPath, ["--test", ...PROBES], repo);
    const digest = configDigest(p.config), mode = fs.statSync(p.unit).mode & 0o777;
    const backup = fs.mkdtempSync(path.join(p.work, "kai-wallet-code-")); fs.chmodSync(backup, 0o700);
    fs.writeFileSync(path.join(backup, "previous.service"), oldUnit, { mode: 0o600 });
    const archive = path.join(backup, "source.tar"); run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
    fs.mkdirSync(targetDir, { mode: 0o755 }); fs.chmodSync(targetDir, 0o755);
    const mask = process.umask(0o022);
    try { run("tar", ["-xf", archive, "-C", targetDir]); run("npm", ["ci", "--omit=dev", "--ignore-scripts"], targetDir); }
    finally { process.umask(mask); }
    run("runuser", ["-u", USER, "--", process.execPath, "-e", "require(process.argv[1])", path.join(targetDir, "test-server.js")]);
    const unchanged = expected => { real(p.unit, false); return fs.readFileSync(p.unit).equals(expected) && configDigest(p.config) === digest; };
    if (!unchanged(oldUnit)) throw Error("Configuration changed during preparation; service unchanged");
    const writeUnit = (bytes, expected) => {
      if (!unchanged(expected)) throw Error("Concurrent service configuration change preserved");
      const temp = fs.mkdtempSync(path.join(path.dirname(p.unit), ".kai-wallet-unit-"));
      try { const file = path.join(temp, "service"); fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode); fs.renameSync(file, p.unit); }
      finally { fs.rmSync(temp, { recursive: true, force: true }); }
    };
    let attemptedStop = false, switched = false;
    try {
      attemptedStop = true; run("systemctl", ["stop", UNIT]);
      if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Prepaid service did not stop cleanly");
      writeUnit(nextUnit, oldUnit); switched = true;
      run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
      if (!unchanged(nextUnit) || show("WorkingDirectory") !== targetDir) throw Error("Updated service identity or configuration changed");
      await checkHealth({ capabilities: true, expected });
      if (!unchanged(nextUnit)) throw Error("Configuration changed during readiness check");
    } catch (error) {
      try {
        if (switched && unchanged(nextUnit)) {
          run("systemctl", ["stop", UNIT]);
          if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Updated service did not stop cleanly");
          writeUnit(oldUnit, nextUnit); run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
          await checkHealth({ capabilities: false });
          log("Previous code restored. New account, device, payment and usage records were retained.");
        } else if (attemptedStop && !switched && unchanged(oldUnit) && show("ActiveState") === "inactive") {
          run("systemctl", ["start", UNIT]);
        } else if (attemptedStop) log("Concurrent changes or incomplete shutdown preserved; service recovery needs attention. Previous unit: " + path.join(backup, "previous.service"));
      } catch { log("Automatic code recovery could not finish. Previous unit: " + path.join(backup, "previous.service")); }
      throw error;
    }
    log("Wallet access code installed and HTTPS capabilities verified: " + target);
    log("Runtime settings, free-credit policy, account balances, keys and transaction records were preserved.");
    return { installed: true, unchanged: false, commit: target, backup };
  } finally { fs.rmdirSync(lock); }
}
if (require.main === module) {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Run with system Node 22+ as root, with no arguments");
  process.umask(0o077); update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, health, assertHealth, assertCapabilities, validateUnit, runtimeTarget, BASE, INSTALLED, UNIT, PATHS, REQUIRED, ALLOWED, PROBES };
