"use strict";
// Code-only update for the first USD service. Account and payment databases,
// configuration, tokenizer packs and private keys are never copied or restored.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const OLD = "1e224ff1298cd7166ba775f82887bf8dfad6635b", UNIT = "kai-koin-prepaid.service";
const ALLOWED = new Set(["test-server.js", "lib/credit-account-web.js", "public/account.html", "scripts/probe-credit-account-web.js", "scripts/probe-prepaid-web-update.js", "deploy/koin-mainnet/update-prepaid-web.js"]);
const DEPENDENCIES = {
  base: "39a44fe1935d20c37f44c98bc4fcc59f90f28725",
  allowed: new Set(["package.json", "package-lock.json", "scripts/probe-prepaid-web-update.js", "deploy/koin-mainnet/update-prepaid-web.js"]),
  required: ["package.json", "package-lock.json"],
  label: "Credit service dependency fix",
};
// The running service still uses the dependency release; the later Smart
// admission change touched configuration only. Review new code against that
// source branch while preserving every live configuration byte and ledger.
const PREFERENCES = {
  base: "5e3403bbe28982315e522602e264f62c72dadf1b",
  installedBase: "cbdb3a581bf6b1e188379f18b99654a496626142",
  allowed: new Set(["lib/koin-network/credit-funding.js", "lib/koin-network/credit-runs.js", "lib/koin-network/prepaid-ledger.js",
    "lib/koin-network/prepaid-router.js", "lib/koin-network/purchase-price.js", "lib/koin-network/test-runtime.js",
    "scripts/probe-koin-credit-priority.js", "scripts/probe-koin-purchase-journal.js",
    "scripts/fixtures/credit-preferences/prepaid-ledger-cbdb3a5.js.txt", "scripts/fixtures/credit-preferences/credit-runs-cbdb3a5.js.txt",
    "scripts/probe-prepaid-preferences-update.js", "deploy/koin-mainnet/update-prepaid-web.js", "deploy/koin-mainnet/CREDIT_PREFERENCES.md"]),
  required: ["lib/koin-network/credit-funding.js", "lib/koin-network/prepaid-ledger.js", "lib/koin-network/prepaid-router.js",
    "lib/koin-network/purchase-price.js", "lib/koin-network/test-runtime.js", "scripts/probe-koin-credit-priority.js"],
  label: "Credit preview and spending preference update",
};
const PATHS = { work: "/root", releases: "/opt/kai-koin-prepaid/releases", config: "/etc/kai-koin-prepaid", unit: "/etc/systemd/system/" + UNIT };
function command(exe, args, cwd, capture = false) {
  return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || "";
}
function configDigest(root) {
  const hash = crypto.createHash("sha256");
  function visit(file, relative) {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink()) throw Error("Configuration contains a symbolic link");
    hash.update(JSON.stringify([relative, s.mode, s.uid, s.gid]));
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    else if (s.isFile()) hash.update(fs.readFileSync(file));
    else throw Error("Unexpected configuration file type");
  }
  visit(root, ""); return hash.digest("hex");
}
function replacementUnit(bytes, oldDir, targetDir) {
  const text = bytes.toString("utf8"), work = "WorkingDirectory=" + oldDir;
  const lines = text.split("\n"), starts = lines.filter(s => s.startsWith("ExecStart="));
  if (lines.filter(s => s === work).length !== 1 || starts.length !== 1 || !/^ExecStart=\/[^\s]+ /.test(starts[0]) || !starts[0].endsWith(" " + oldDir + "/test-server.js")) throw Error("Unexpected service command; no unit was changed");
  return Buffer.from(lines.map(s => s === work ? "WorkingDirectory=" + targetDir : s === starts[0] ? s.slice(0, -(oldDir + "/test-server.js").length) + targetDir + "/test-server.js" : s).join("\n"));
}
async function health() {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    try {
      const r = await fetch("http://127.0.0.1:3109/health", { redirect: "error", signal: AbortSignal.timeout(8000) }), h = await r.json();
      if (!r.ok || h.product !== "prepaid-usd-v1" || h.mode !== "mainnet-pilot" || h.mainnetPaymentsEnabled !== true || h.chainId !== "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==" || !Number.isSafeInteger(h.lastSuccess) || h.lastSuccess > Date.now() || Date.now() - h.lastSuccess > 60000) throw Error("Service not ready");
      const page = await fetch("https://credits.koinosai.com/account", { redirect: "error", signal: AbortSignal.timeout(8000) });
      if (!page.ok || !(await page.text()).includes('<body data-account-service="credits">')) throw Error("Updated account page not visible");
      const dashboard = await fetch("https://credits.koinosai.com/dashboard", { redirect: "manual", signal: AbortSignal.timeout(8000) });
      if (dashboard.status !== 302 || dashboard.headers.get("location") !== "https://koinosai.com/dashboard") throw Error("Dashboard handoff not visible");
      return;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw Error("Updated HTTPS account page, dashboard handoff or service heartbeat did not verify");
}
async function update({ repo = process.cwd(), paths: p = PATHS, run = command, checkHealth = health, log = console.log, kind = "web" } = {}) {
  if (!["web", "dependencies", "preferences"].includes(kind)) throw Error("Unknown update kind");
  const review = kind === "preferences" ? PREFERENCES : kind === "dependencies" ? DEPENDENCIES : { base: OLD, allowed: ALLOWED, required: ["test-server.js"], label: "Credit account web fix" };
  const target = run("git", ["rev-parse", "HEAD"], repo, true).trim();
  if (!/^[a-f0-9]{40}$/.test(target) || target === review.base || run("git", ["status", "--porcelain"], repo, true).trim()) throw Error("Use the clean reviewed fix checkout");
  const changed = run("git", ["diff", "--name-only", review.base, target], repo, true).trim().split("\n");
  if (review.required.some(name => !changed.includes(name)) || changed.some(name => !review.allowed.has(name))) throw Error("This updater accepts only the reviewed " + (kind === "web" ? "web-page" : kind === "preferences" ? "credit-preference" : "dependency") + " change, not unrelated changes");
  const show = prop => run("systemctl", ["show", UNIT, "--value", "--property=" + prop], undefined, true).trim();
  const oldDir = path.join(p.releases, review.installedBase || review.base), targetDir = path.join(p.releases, target), current = show("WorkingDirectory");
  if (![oldDir, targetDir].includes(current) || show("ActiveState") !== "active" || show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected prepaid service version or overrides; no service changes made");
  if (current === targetDir) { await checkHealth(); log(review.label + " already installed."); return; }
  for (const dir of [p.releases, p.config]) if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error("Expected real service directories");
  if (!fs.lstatSync(p.unit).isFile() || fs.lstatSync(p.unit).isSymbolicLink()) throw Error("Expected a regular systemd unit");
  if (fs.existsSync(targetDir)) throw Error("Target release directory already exists; preserve it for review");
  // Run accounting, backwards-recovery and read-only pricing checks before
  // preparing or stopping the installed service. The probes use fixtures only.
  if (kind === "preferences") run(process.execPath, ["--test", "scripts/probe-koin-credit-priority.js", "scripts/probe-koin-purchase-journal.js"], repo);
  const digest = configDigest(p.config), oldUnit = fs.readFileSync(p.unit), mode = fs.statSync(p.unit).mode & 0o777;
  const nextUnit = replacementUnit(oldUnit, oldDir, targetDir), backup = fs.mkdtempSync(path.join(p.work, "kai-credit-web-"));
  fs.chmodSync(backup, 0o700); fs.writeFileSync(path.join(backup, "previous.service"), oldUnit, { mode: 0o600 });
  const archive = path.join(backup, "source.tar");
  run("git", ["archive", "--format=tar", "--output=" + archive, target], repo);
  fs.mkdirSync(targetDir, { mode: 0o755 }); fs.chmodSync(targetDir, 0o755);
  const mask = process.umask(0o022);
  try { run("tar", ["-xf", archive, "-C", targetDir]); run("npm", ["ci", "--omit=dev", "--ignore-scripts"], targetDir); }
  finally { process.umask(mask); }
  run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, "-e", "require(process.argv[1])", path.join(targetDir, "test-server.js")]);
  if (kind === "dependencies") run("runuser", ["-u", "kai-koin-prepaid", "--", process.execPath, "-e",
    'for (const [name, version] of [["body-parser", "1.20.9"], ["nodemailer", "10.1.4"]]) { const installed = require(require.resolve(name + "/package.json", { paths: [process.argv[1]] })); if (installed.version !== version) throw Error("Unexpected dependency version: " + name); }', targetDir]);
  if (configDigest(p.config) !== digest || !fs.readFileSync(p.unit).equals(oldUnit)) throw Error("Service configuration changed during preparation");
  const writeUnit = bytes => { const temporary = p.unit + ".web-update"; fs.writeFileSync(temporary, bytes, { flag: "wx", mode }); fs.chmodSync(temporary, mode); fs.renameSync(temporary, p.unit); };
  let stopped = false;
  try {
    stopped = true; run("systemctl", ["stop", UNIT]);
    if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Service did not shut down cleanly");
    writeUnit(nextUnit); run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
    if (configDigest(p.config) !== digest || show("WorkingDirectory") !== targetDir) throw Error("Updated service identity or configuration differs");
    await checkHealth();
  } catch (error) {
    if (stopped) {
      try { run("systemctl", ["stop", UNIT]);
        if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Updated service did not shut down cleanly; keep its current code and records");
        writeUnit(oldUnit); run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]); log("Previous code restored using the current account and payment databases."); }
      catch { log("Service recovery needs attention. Original unit: " + path.join(backup, "previous.service")); }
    }
    throw error;
  }
  log(review.label + " installed: " + target);
  log("HTTPS account page and dashboard handoff verified. Account databases, keys, configuration and payment records preserved.");
}
if (require.main === module) {
  if (process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) throw Error("Use system Node 22+ as root");
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || !["--dependencies", "--preferences"].includes(args[0]))) throw Error("Usage: node deploy/koin-mainnet/update-prepaid-web.js [--dependencies|--preferences]");
  process.umask(0o077); update({ kind: args.length ? args[0].slice(2) : "web" }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { update, replacementUnit, configDigest, OLD, UNIT, ALLOWED, DEPENDENCIES, PREFERENCES };
