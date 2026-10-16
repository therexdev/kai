"use strict";
// Install compatible code while exhausted reward envelopes stay frozen.
// No extra retries, qualification renewal, or payment database restoration.
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto"), { isDeepStrictEqual: equal } = require("node:util");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const OLD = "07629b24e91f32af8abafc2ebdf0bdca8771e936", TARGET = "ab9660a1184b17ea637105eb54bf54db1b34cf4d";
const UNIT = "kai-koin-mainnet-pilot.service", CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const PATHS = { work: "/root", releases: "/opt/kai-koin-mainnet-pilot/releases", bootstrap: "/root/kai-mainnet-bootstrap",
  config: "/etc/kai-koin-mainnet-pilot", state: "/var/lib/kai-koin-mainnet-pilot", unit: "/etc/systemd/system/" + UNIT };
const CONFIG = ["runtime.json", "runtime-keys.json", "operator-secret", "invitations.json", "qualifications.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"];
function command(exe, args, cwd, capture = false) {
  return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) || "";
}
function record(row) {
  if (!row || hash(row.data) !== row.hash) throw Error("Payment journal integrity check failed");
  const value = JSON.parse(row.data);
  if (value.id !== row.id || value.state !== row.state || (row.owner && value.owner !== row.owner) ||
      ("tx_id" in row && (value.outbox?.transaction.id ?? null) !== row.tx_id)) throw Error("Payment journal binding changed");
  return value;
}
function readDb(state, file, callback) {
  const db = new DatabaseSync(path.join(state, file), { readOnly: true });
  try { return callback(db); } finally { db.close(); }
}
function drained(state, config, now = Date.now()) {
  readDb(state, "scheduler/koin-funded-sessions/funded-reservations.sqlite", db => {
    const open = db.prepare("SELECT state, count(*) AS count FROM holds WHERE state NOT IN ('settled','cancelled') GROUP BY state").all();
    if (open.length) throw Error("Unfinished paid requests; update was not installed: " + open.map(r => `${r.state}=${r.count}`).join(", "));
    for (const row of db.prepare("SELECT data FROM holds WHERE state='settled'").all()) {
      const at = JSON.parse(row.data).receipt?.completedAt;
      if (!Number.isSafeInteger(at) || at > now || now - at < 300000) throw Error("A recent reply may still need recovery. Save/recover it, then wait five minutes before updating.");
    }
  });
  const rows = readDb(state, "signing/test-signing.sqlite", db => db.prepare("SELECT * FROM signatures WHERE state NOT IN ('finalized','reverted')").all());
  const frozen = [];
  for (const row of rows) {
    const r = record(row), tx = r.transaction;
    if (r.state !== "signed" || r.owner !== config?.roles?.lifecycle || !tx || tx.operations?.length !== 1)
      throw Error("Unresolved transaction is not an exhausted reward cycle; no update installed. " + JSON.stringify({ state: r.state, record: r.id, txId: tx?.id ?? null }));
    const step = readDb(state, "cycle/reward-cycle.sqlite", db => record(db.prepare("SELECT * FROM steps WHERE tx_id=?").get(tx.id)));
    const expectedSigners = step.method === "propose_root" ? [r.owner, config.deployment.verifier] : [r.owner];
    if (step.state !== "needs_review" || step.reason !== "attempt_limit" || step.outbox?.attempts !== 3 ||
        r.id !== hash(`cycle:${step.epoch}:${step.method}`) || !equal(step.outbox.transaction, tx) ||
        step.outbox.hash !== hash(JSON.stringify(tx)) || tx.header.chain_id !== CHAIN || tx.header.payer !== r.owner ||
        tx.header.payee || tx.header.rc_limit !== config.maxRcPerTransaction ||
        tx.operations[0].call_contract?.contract_id !== config.deployment.rewards ||
        !["open_epoch", "propose_root", "finalize_root"].includes(step.method) || !Array.isArray(r.signers) ||
        !equal([...r.signers].sort(), expectedSigners.sort()))
      throw Error("Unresolved reward transaction is not safely frozen at its existing retry limit. " + JSON.stringify({ txId: tx.id, epoch: step.epoch, method: step.method, state: step.state, reason: step.reason, attempts: step.outbox?.attempts }));
    frozen.push({ signingId: r.id, owner: r.owner, signers: r.signers, epoch: step.epoch, method: step.method,
      txId: tx.id, transaction: tx, attempts: step.outbox.attempts });
  }
  return frozen;
}
async function verifyFrozen(frozen, base) {
  if (!frozen.length) return;
  const { Transaction, Signer } = require(path.join(base, "node_modules/koilib"));
  const abi = require(path.join(base, "lib/koin-network/rewards-abi.json"));
  for (const r of frozen) {
    if (r.transaction.operations[0].call_contract.entry_point !== abi.methods[r.method]?.entry_point ||
        (await Transaction.prepareTransaction(structuredClone(r.transaction))).id !== r.txId ||
        !equal((await Signer.recoverAddresses(r.transaction)).sort(), [...r.signers].sort()))
      throw Error("Frozen transaction signature or commitment mismatch");
  }
}
async function reportFrozen(frozen, config, base, log) {
  if (!frozen.length) return;
  const { KoinChain } = require(path.join(base, "lib/koin-network/chain"));
  const { inspectFinality } = require(path.join(base, "lib/koin-network/finality"));
  const { nonce } = require(path.join(base, "lib/koin-network/settlement-outbox"));
  const { safeError } = require(path.join(base, "lib/koin-network/rpc-transport"));
  for (const r of frozen) await Promise.all(config.deployment.rpc.map(async url => {
    try {
      const c = new KoinChain({ ...config.deployment, rpc: [url] });
      const proof = await inspectFinality(c.provider, { chainId: CHAIN, txId: r.txId, expectedOperation: r.transaction.operations[0].call_contract });
      const [currentNonce, availableMana] = await Promise.all([c.provider.getNonce(r.owner), c.provider.getAccountRc(r.owner)]);
      log(JSON.stringify({ rpc: new URL(url).hostname, txId: r.txId, state: proof.state,
        currentNonce, savedNonce: nonce(r.transaction.header.nonce), availableMana, manaLimit: r.transaction.header.rc_limit }));
    } catch (e) { log(JSON.stringify({ rpc: new URL(url).hostname, txId: r.txId, state: "unverified", error: safeError(e) })); }
  }));
}
function preserved(frozen, state) {
  for (const prior of frozen) {
    const r = readDb(state, "signing/test-signing.sqlite", db => record(db.prepare("SELECT * FROM signatures WHERE id=?").get(prior.signingId)));
    const step = readDb(state, "cycle/reward-cycle.sqlite", db => record(db.prepare("SELECT * FROM steps WHERE tx_id=?").get(prior.txId)));
    if (!equal(r.transaction, prior.transaction) || !equal(step.outbox.transaction, prior.transaction) ||
        step.outbox.attempts !== prior.attempts || !["signed", "finalized", "reverted"].includes(r.state) ||
        !["needs_review", "complete"].includes(step.state)) throw Error("Frozen transaction changed unexpectedly; preserve journals for review");
  }
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
async function update({ paths: p = PATHS, run = command, checkHealth = health, checkFrozen = verifyFrozen, report = reportFrozen, log = console.log } = {}) {
  const show = property => run("systemctl", ["show", UNIT, "--value", "--property=" + property], undefined, true).trim();
  const oldDir = show("WorkingDirectory"), targetDir = path.join(p.releases, TARGET);
  if (![path.join(p.releases, OLD), targetDir].includes(oldDir) || show("ActiveState") !== "active" ||
      show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected service version or overrides; no service changes made.");
  const configs = configurations(p), config = JSON.parse(configs.get("runtime.json"));
  if (oldDir === targetDir) { await checkHealth(); log("Reward-processing update is already installed."); qualification(p, log); return; }
  drained(p.state, config);
  const work = fs.mkdtempSync(path.join(p.work, "kai-reward-processing-")); fs.chmodSync(work, 0o700);
  log("Preparing update. Private backup directory: " + work);
  const repo = path.join(work, "code");
  run("git", ["clone", "--quiet", "--single-branch", "--branch", "codex/koin-mainnet-pilot", "https://github.com/therexdev/kai.git", repo]);
  run("git", ["checkout", "--quiet", "--detach", TARGET], repo);
  if (run("git", ["rev-parse", "HEAD"], repo, true).trim() !== TARGET) throw Error("Downloaded code does not match the reviewed update.");
  run("npm", ["ci", "--ignore-scripts"], repo);
  run(process.execPath, ["scripts/probe-koin-provider-readiness.js"], repo);
  run(process.execPath, ["--test", "scripts/probe-koin-funded-session.js", "scripts/probe-koin-mainnet-session-response.js", "scripts/probe-koin-session-delegation.js", "scripts/probe-koin-funded-reservations.js", "scripts/probe-koin-reward-observer.js", "scripts/probe-koin-rpc-transport.js", "scripts/probe-koin-reward-cycle.js", "scripts/probe-koin-automatic-claims.js"], repo);
  drained(p.state, config);
  const oldUnit = fs.readFileSync(p.unit), oldMode = fs.statSync(p.unit).mode & 0o777;
  fs.writeFileSync(path.join(work, "previous.service"), oldUnit, { mode: 0o600 });
  let stopped = false, frozen = [];
  try {
    stopped = true; run("systemctl", ["stop", UNIT]);
    if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("The old service did not shut down cleanly.");
    frozen = drained(p.state, config); // Inspect again after the old writer has stopped.
    await checkFrozen(frozen, oldDir);
    run("tar", ["--numeric-owner", "-czf", path.join(work, "before-update.tgz"), "-C", "/",
      ...[p.config, p.state, p.bootstrap, p.unit].map(f => f.replace(/^\//, ""))]);
    fs.chmodSync(path.join(work, "before-update.tgz"), 0o600);
    run("bash", ["deploy/koin-mainnet/install.sh", p.bootstrap], repo);
    for (const [name, bytes] of configs) for (const root of [p.config, p.bootstrap])
      if (!fs.readFileSync(path.join(root, name)).equals(bytes)) throw Error("Configuration changed unexpectedly: " + name);
    if (show("WorkingDirectory") !== targetDir || show("ActiveState") !== "active") throw Error("The expected updated service is not running.");
    await checkHealth();
    preserved(frozen, p.state);
    for (const r of frozen) log(JSON.stringify({ preservedReward: r.txId, epoch: r.epoch, method: r.method, attempts: r.attempts, extraRetriesAuthorized: false }));
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
  log("REWARD PROCESSING UPDATE INSTALLED: " + TARGET);
  log("HTTPS health and current processing heartbeat verified. Existing configuration and payment records preserved.");
  await report(frozen, config, targetDir, log);
  qualification(p, log);
  log("Reopen Test 181.1. Turn on Share AI capacity and wait for ONLINE. Check the existing reservation in normal Chat; do not add another deposit just to retry.");
}
if (require.main === module) {
  if (process.getuid?.() !== 0 || process.argv.slice(2).join(" ") !== "--apps-stopped") {
    console.error("Quit both Test apps after saving/recovering any reply, then run as root with --apps-stopped."); process.exitCode = 1;
  } else if (Number(process.versions.node.split(".")[0]) < 22 || /^\/(root|home)\//.test(process.execPath)) {
    console.error("Use the system Node 22 or newer installation accessible to the service."); process.exitCode = 1;
  } else { process.umask(0o077); update().catch(e => { console.error("Update stopped: " + e.message); process.exitCode = 1; }); }
}
module.exports = { update, drained, configurations, preserved, verifyFrozen, OLD, TARGET, UNIT, CHAIN, CONFIG };
