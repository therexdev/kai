"use strict";
// One-time rollout for the reviewed owner pilot. No qualification renewal,
// transaction submission, or restoration of payment databases.
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const OLD = "07629b24e91f32af8abafc2ebdf0bdca8771e936", TARGET = "b88bbbcce99cd13dead6d3e262cf61fd888de0f1";
const UNIT = "kai-koin-mainnet-pilot.service", CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const PATHS = { work: "/root", releases: "/opt/kai-koin-mainnet-pilot/releases", bootstrap: "/root/kai-mainnet-bootstrap",
  config: "/etc/kai-koin-mainnet-pilot", state: "/var/lib/kai-koin-mainnet-pilot", unit: "/etc/systemd/system/" + UNIT };
const CONFIG = ["runtime.json", "runtime-keys.json", "operator-secret", "invitations.json", "qualifications.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"];
function command(exe, args, cwd, capture = false) {
  return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || "";
}
function drained(state, now = Date.now()) {
  const inspect = (file, read) => { const db = new DatabaseSync(path.join(state, file), { readOnly: true }); try { read(db); } finally { db.close(); } };
  inspect("scheduler/koin-funded-sessions/funded-reservations.sqlite", db => {
    const open = db.prepare("SELECT state, count(*) AS count FROM holds WHERE state NOT IN ('settled','cancelled') GROUP BY state").all();
    if (open.length) throw Error("Unfinished paid requests; update was not installed: " + open.map(r => `${r.state}=${r.count}`).join(", "));
    for (const row of db.prepare("SELECT data FROM holds WHERE state='settled'").all()) {
      const at = JSON.parse(row.data).receipt?.completedAt;
      if (!Number.isSafeInteger(at) || at > now || now - at < 300000) throw Error("A recent reply may still need recovery. Save/recover it, then wait five minutes before updating.");
    }
  });
  inspect("signing/test-signing.sqlite", db => {
    if (db.prepare("SELECT 1 FROM signatures WHERE state NOT IN ('finalized','reverted') LIMIT 1").get())
      throw Error("A saved payment transaction is unresolved. Keep the existing service and reconcile it before updating.");
  });
}
function configurations(p) {
  const saved = new Map();
  for (const name of CONFIG) {
    const live = fs.readFileSync(path.join(p.config, name)), original = fs.readFileSync(path.join(p.bootstrap, name));
    if (!live.equals(original)) throw Error("Bootstrap and service configuration differ: " + name + ". No configuration was replaced.");
    saved.set(name, live);
  }
  const c = JSON.parse(saved.get("runtime.json"));
  if (c.mode !== "mainnet-pilot" || c.schedulerUrl !== "https://payments.koinosai.com/scheduler" || c.deployment?.chainId !== CHAIN)
    throw Error("This updater only supports the reviewed mainnet pilot.");
  return saved;
}
async function health() {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    try {
      const r = await fetch("https://payments.koinosai.com/health", { redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(10000, until - Date.now()))) });
      const h = await r.json();
      if (r.ok && h.mode === "mainnet-pilot" && h.mainnetPaymentsEnabled === true && h.chainId === CHAIN &&
          Number.isSafeInteger(h.lastSuccess) && h.lastSuccess <= Date.now() && Date.now() - h.lastSuccess < 60000) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw Error("The updated service did not confirm a fresh processing heartbeat through HTTPS.");
}
function qualification(p, log) {
  const rows = JSON.parse(fs.readFileSync(path.join(p.config, "qualifications.json"), "utf8"));
  for (const q of rows) log(JSON.stringify({ provider: q.address, model: q.model, qualification: q.expires > Date.now() && q.expires <= Date.now() + 86400000 ? "current" : "renewal required", expiresAt: new Date(q.expires).toISOString() }));
}
async function update({ paths: p = PATHS, run = command, checkHealth = health, log = console.log } = {}) {
  const show = property => run("systemctl", ["show", UNIT, "--value", "--property=" + property], undefined, true).trim();
  const oldDir = show("WorkingDirectory"), targetDir = path.join(p.releases, TARGET);
  if (![path.join(p.releases, OLD), targetDir].includes(oldDir) || show("ActiveState") !== "active" ||
      show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected service version or overrides; no service changes made.");
  const configs = configurations(p);
  if (oldDir === targetDir) { await checkHealth(); log("Session-approval update is already installed."); qualification(p, log); return; }
  drained(p.state);
  const work = fs.mkdtempSync(path.join(p.work, "kai-session-approval-")); fs.chmodSync(work, 0o700);
  log("Preparing update. Private backup directory: " + work);
  const repo = path.join(work, "code");
  run("git", ["clone", "--quiet", "--single-branch", "--branch", "codex/koin-mainnet-pilot", "https://github.com/therexdev/kai.git", repo]);
  run("git", ["checkout", "--quiet", "--detach", TARGET], repo);
  if (run("git", ["rev-parse", "HEAD"], repo, true).trim() !== TARGET) throw Error("Downloaded code does not match the reviewed update.");
  run("npm", ["ci", "--ignore-scripts"], repo);
  run(process.execPath, ["scripts/probe-koin-provider-readiness.js"], repo);
  run(process.execPath, ["--test", "scripts/probe-koin-funded-session.js", "scripts/probe-koin-mainnet-session-response.js", "scripts/probe-koin-session-delegation.js", "scripts/probe-koin-funded-reservations.js"], repo);
  drained(p.state);
  const oldUnit = fs.readFileSync(p.unit), oldMode = fs.statSync(p.unit).mode & 0o777;
  fs.writeFileSync(path.join(work, "previous.service"), oldUnit, { mode: 0o600 });
  let stopped = false;
  try {
    stopped = true; run("systemctl", ["stop", UNIT]);
    if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("The old service did not shut down cleanly.");
    drained(p.state); // Catch a request admitted between the first check and shutdown.
    run("tar", ["--numeric-owner", "-czf", path.join(work, "before-update.tgz"), "-C", "/",
      ...[p.config, p.state, p.bootstrap, p.unit].map(f => f.replace(/^\//, ""))]);
    fs.chmodSync(path.join(work, "before-update.tgz"), 0o600);
    run("bash", ["deploy/koin-mainnet/install.sh", p.bootstrap], repo);
    for (const [name, bytes] of configs) for (const root of [p.config, p.bootstrap])
      if (!fs.readFileSync(path.join(root, name)).equals(bytes)) throw Error("Configuration changed unexpectedly: " + name);
    if (show("WorkingDirectory") !== targetDir || show("ActiveState") !== "active") throw Error("The expected updated service is not running.");
    await checkHealth();
  } catch (error) {
    if (stopped) {
      // Only roll back the unit/code. Never replace newer payment journals
      // with backup copies, even if the new process ran before health failed.
      try {
        run("systemctl", ["stop", UNIT]); fs.writeFileSync(p.unit, oldUnit, { mode: oldMode }); fs.chmodSync(p.unit, oldMode);
        run("systemctl", ["daemon-reload"]); run("systemctl", ["start", UNIT]);
        log("Previous service restored using the current payment records. Backup retained at " + work);
      } catch { log("Service recovery needs operator attention. Current records and backup remain at " + work); }
    }
    throw error;
  }
  log("SESSION APPROVAL UPDATE INSTALLED: " + TARGET);
  log("HTTPS health and current processing heartbeat verified. Existing configuration and payment records preserved.");
  qualification(p, log);
  log("Reopen the updated Test apps. Turn on Share AI capacity and wait for ONLINE, then send the same buyer message using its existing reservation.");
}
if (require.main === module) {
  if (process.getuid?.() !== 0 || process.argv.slice(2).join(" ") !== "--apps-stopped") {
    console.error("Quit both Test apps after saving/recovering any reply, then run as root with --apps-stopped."); process.exitCode = 1;
  } else if (Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) {
    console.error("Use the system Node 22 or newer installation accessible to the service."); process.exitCode = 1;
  } else { process.umask(0o077); update().catch(e => { console.error("Update stopped: " + e.message); process.exitCode = 1; }); }
}
module.exports = { update, drained, configurations, OLD, TARGET, UNIT, CHAIN, CONFIG };
