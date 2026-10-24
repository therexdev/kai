"use strict";
// One reviewed policy addition to the separate prepaid runtime. No code/unit,
// private key, account, payment journal, bootstrap plan or qualification edits.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const { configuration } = require("../../lib/koin-network/test-config");
const { policy: validatePolicy } = require("../../lib/koin-network/provider-qualification");
const Models = require("../../lib/koin-network/model-configuration");
const BASE = "cbdb3a581bf6b1e188379f18b99654a496626142", UNIT = "kai-koin-prepaid.service";
const ROOT = path.resolve(__dirname, "../.."), EVIDENCE = path.join(__dirname, "qualification"), PREFIX = "smart-2026-10-24";
const PATHS = { config: "/etc/kai-koin-prepaid", work: "/root", state: "/var/lib/kai-koin-prepaid", release: "/opt/kai-koin-prepaid/releases/" + BASE, unit: "/etc/systemd/system/" + UNIT };
const ALLOWED = new Set(["deploy/koin-mainnet/install-smart-qualification.js", "scripts/probe-prepaid-qualification-install.js",
  ...["observation.json", "review.json", "policy.json", "md"].map(x => "deploy/koin-mainnet/qualification/" + PREFIX + "." + x)]);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function command(exe, args, cwd) { return execFileSync(exe, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function evidence(directory = EVIDENCE) {
  const get = suffix => fs.readFileSync(path.join(directory, PREFIX + "." + suffix));
  const reviewBytes = get("review.json"), observationBytes = get("observation.json"), policyBytes = get("policy.json");
  const review = JSON.parse(reviewBytes), observation = JSON.parse(observationBytes), policy = JSON.parse(policyBytes), r = observation.report;
  const expectedCases = require("./qualification/fast-candidate-v1.json").cases;
  if (hash(reviewBytes) !== policy.reviewedEvidenceHash || hash(observationBytes) !== review.observationSha256 ||
      observation.sourceReportSha256 !== review.originalReportSha256 || policy.model !== "koinos-smart" ||
      policy.modelHash !== review.model.modelHash || JSON.stringify(policy.cases) !== JSON.stringify(expectedCases) ||
      policy.minPass !== 12 || policy.maxLatencyMs !== 30000 || policy.modelWeight !== String(require("../../lib/koin-network/policy").modelWeight(7)) ||
      policy.coverageBps !== 10000 || policy.renewBeforeMs !== 3600000 || policy.retryMs !== 300000 ||
      r.app.version !== "0.54.12-test.206.1" || r.model.id !== policy.model || r.model.modelHash !== policy.modelHash ||
      r.modelFile.sha256 !== policy.modelHash || r.modelFile.hashVerified !== true || r.runtime.stable !== true ||
      r.signed !== false || r.providerEligibilityCreated !== false || r.networkReady !== false || r.outcome.state !== "complete" ||
      r.calibration.complete !== true || r.calibration.vectors.length !== 32 || r.calibration.vectors.some(v => !v.passed || v.count !== v.expectedCount || v.idsHash !== v.expectedIdsHash) ||
      r.measurement.complete !== true || r.measurement.results.length !== 12) throw Error("Reviewed Smart evidence does not match");
  for (let i = 0; i < expectedCases.length; i++) {
    const c = expectedCases[i], result = r.measurement.results[i];
    if (result.id !== c.id || !result.passed || result.stoppedByLimit !== false || !c.expected.includes(result.output.trim()) ||
        hash(result.output) !== result.outputHash || !result.tokenizer.passed || result.tokenizer.count !== result.inputTokens ||
        result.tokenizer.idsHash !== result.inputIdsHash || result.inferenceInput.format !== "token-ids" ||
        result.inferenceInput.count !== result.inputTokens || result.inferenceInput.idsHash !== result.inputIdsHash) throw Error("Measured Smart answer or input differs");
  }
  return { review, policy, approvalHash: hash(JSON.stringify(policy)), files: { "review.json": reviewBytes, "observation.json": observationBytes, "policy.json": policyBytes } };
}
function nextRuntime(bytes, e) {
  const c = configuration(JSON.parse(bytes)), s = e.review.scope;
  if (c.schema !== 2 || c.mode !== s.mode || c.schedulerUrl !== s.schedulerUrl || c.policyHash !== s.policyHash || c.accountMode !== "public" ||
      Object.entries(s.deployment).some(([k, v]) => c.deployment[k] !== v)) throw Error("Runtime is not the reviewed separate prepaid deployment");
  const tariff = Models.tariffs(c).find(t => t.model === e.policy.model);
  validatePolicy(e.policy, tariff);
  if (c.qualificationPolicy !== undefined || (c.qualificationPolicies !== undefined && JSON.stringify(c.qualificationPolicies) !== JSON.stringify([e.policy])))
    throw Error("Existing qualification policy differs; no policy was replaced");
  if (c.qualificationPolicies !== undefined) return { bytes, already: true };
  c.qualificationPolicies = [e.policy]; configuration(c);
  return { bytes: Buffer.from(JSON.stringify(c, null, 2) + "\n"), already: false };
}
function trustedDirectory(directory) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const s = fs.lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink() || ![0, process.getuid()].includes(s.uid) || ((s.mode & 0o022) && !(s.uid === 0 && s.mode & 0o1000))) throw Error("Untrusted configuration directory");
    if (current === path.dirname(current)) break;
  }
}
function readRuntime(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o022) || s.size > 1048576) throw Error("Untrusted runtime file");
    return { bytes: fs.readFileSync(fd), mode: s.mode & 0o777, uid: s.uid, gid: s.gid };
  } finally { fs.closeSync(fd); }
}
function sameRuntime(file, snapshot) {
  const now = readRuntime(file);
  if (!now.bytes.equals(snapshot.bytes) || now.mode !== snapshot.mode || now.uid !== snapshot.uid || now.gid !== snapshot.gid) throw Error("Runtime changed during admission update");
}
function otherConfigDigest(directory) {
  const digest = crypto.createHash("sha256");
  function visit(file, relative) {
    if (["runtime.json", ".smart-qualification-lock"].includes(relative)) return;
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink()) throw Error("Unexpected configuration symlink");
    digest.update(JSON.stringify([relative, s.mode, s.uid, s.gid]));
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    else if (s.isFile()) digest.update(fs.readFileSync(file));
    else throw Error("Unexpected configuration file type");
  }
  visit(directory, ""); return digest.digest("hex");
}
function replace(file, bytes, snapshot) {
  const temporary = file + ".qualification-" + crypto.randomBytes(8).toString("hex");
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fchownSync(fd, snapshot.uid, snapshot.gid); fs.fchmodSync(fd, snapshot.mode); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
async function health({ paths: p }) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    try {
      for (const origin of ["http://127.0.0.1:3109", "https://credits.koinosai.com"]) {
        const response = await fetch(origin + "/health", { redirect: "error", signal: AbortSignal.timeout(8000) }), h = await response.json();
        if (!response.ok || h.mode !== "mainnet-pilot" || h.product !== "prepaid-usd-v1" || h.mainnetPaymentsEnabled !== true ||
            h.chainId !== "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==" || !Number.isSafeInteger(h.lastSuccess) || h.lastSuccess > Date.now() || Date.now() - h.lastSuccess > 60000) throw Error("Service heartbeat unavailable");
      }
      // The secret stays in memory and is sent only to loopback, never printed.
      const secret = require("../../lib/koin-network/test-config").read(path.join(p.config, "operator-secret"), 256, true).trim();
      if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("Invalid operator credential");
      const response = await fetch("http://127.0.0.1:3109/operator/status", { redirect: "error", signal: AbortSignal.timeout(8000), headers: { "x-operator-secret": secret } }), status = await response.json();
      if (!response.ok || status.product !== "prepaid-usd-v1" || !status.qualityPolicy?.startsWith("Providers must pass the explicitly reviewed quality and latency cases.")) throw Error("Running qualifier not confirmed");
      return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw Error("Prepaid HTTPS health or running qualification policy did not verify");
}
async function install({ approve, repo = ROOT, paths: p = PATHS, run = command, checkHealth = health, log = console.log, evidenceDirectory = EVIDENCE } = {}) {
  const e = evidence(evidenceDirectory);
  if (approve !== e.approvalHash) throw Error("Review the Smart policy and supply its exact --approve hash: " + e.approvalHash);
  if (run("git", ["status", "--porcelain"], repo)) throw Error("Use a clean reviewed checkout");
  run("git", ["merge-base", "--is-ancestor", BASE, "HEAD"], repo);
  const changed = run("git", ["diff", "--name-only", BASE, "HEAD"], repo).split("\n");
  if (changed.some(file => !ALLOWED.has(file)) || !changed.includes("deploy/koin-mainnet/install-smart-qualification.js")) throw Error("Unexpected source changes; admission update stopped");
  const show = property => run("systemctl", ["show", UNIT, "--value", "--property=" + property]);
  const unit = readRuntime(p.unit), lines = unit.bytes.toString("utf8").split("\n");
  for (const [name, value] of Object.entries({ KAI_KOIN_TEST_CONFIG_DIR: p.config, KAI_KOIN_TEST_STATE_DIR: p.state, KAI_KOIN_TEST_PORT: "3109" })) {
    if (lines.filter(line => line === "Environment=" + name + "=" + value).length !== 1) throw Error("Unexpected prepaid service environment");
  }
  const identity = () => {
    if (show("WorkingDirectory") !== p.release || show("FragmentPath") !== p.unit || show("DropInPaths")) throw Error("Unexpected prepaid service identity");
    sameRuntime(p.unit, unit);
  };
  identity(); if (show("ActiveState") !== "active") throw Error("Prepaid service is not active");
  trustedDirectory(p.config); trustedDirectory(p.work);
  const file = path.join(p.config, "runtime.json"), before = readRuntime(file), next = nextRuntime(before.bytes, e);
  if (next.already) { await checkHealth({ paths: p }); log(JSON.stringify({ alreadyInstalled: true, policyHash: e.approvalHash, providerEligibilityCreated: false })); return; }
  const lock = path.join(p.config, ".smart-qualification-lock"); fs.mkdirSync(lock, { mode: 0o700 });
  let stopped = false, written = false, backup;
  try {
    const untouched = otherConfigDigest(p.config);
    backup = fs.mkdtempSync(path.join(p.work, "kai-smart-admission-")); fs.chmodSync(backup, 0o700);
    for (const [name, bytes] of Object.entries({ "previous-runtime.json": before.bytes, "next-runtime.json": next.bytes, ...e.files })) fs.writeFileSync(path.join(backup, name), bytes, { mode: 0o600, flag: "wx" });
    sameRuntime(file, before); identity();
    stopped = true; run("systemctl", ["stop", UNIT]);
    if (show("ActiveState") !== "inactive" || show("ExecMainStatus") !== "0") throw Error("Prepaid service did not shut down cleanly");
    sameRuntime(file, before); identity();
    if (otherConfigDigest(p.config) !== untouched) throw Error("Other configuration changed during update");
    written = true; replace(file, next.bytes, before);
    run("systemctl", ["start", UNIT]); identity();
    await checkHealth({ paths: p }); sameRuntime(file, { ...before, bytes: next.bytes });
    if (show("ActiveState") !== "active") throw Error("Prepaid service is not running after admission update");
    if (otherConfigDigest(p.config) !== untouched) throw Error("Other configuration changed during update");
    log(JSON.stringify({ installed: true, policyHash: e.approvalHash, model: e.policy.model, minPass: 12, total: 12, maxLatencyMs: 30000,
      backup, smartFreeEligible: JSON.parse(next.bytes).freePolicy?.eligibleModels?.includes(e.policy.model) === true,
      providerEligibilityCreated: false, next: "Keep Smart loaded. Sign in to the AI credit account, link the existing wallet, then turn on Share AI capacity for fresh signed qualification." }, null, 2));
  } catch (error) {
    if (stopped) {
      try {
        run("systemctl", ["stop", UNIT]);
        if (show("ActiveState") !== "inactive") throw Error("Cannot restore configuration while service is running");
        if (written && !readRuntime(file).bytes.equals(before.bytes)) { sameRuntime(file, { ...before, bytes: next.bytes }); replace(file, before.bytes, before); }
        else sameRuntime(file, before);
        run("systemctl", ["start", UNIT]);
        log("Previous runtime settings restored; current payment and qualification journals retained.");
      } catch { log("Recovery needs operator attention; preserve current state and backup at " + backup); }
    }
    throw error;
  } finally { fs.rmdirSync(lock); }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) { const e = evidence(); console.log(JSON.stringify({ proposalOnly: true, policyHash: e.approvalHash, policy: e.policy, measured: e.review.measured }, null, 2)); }
  else if (args.length !== 2 || args[0] !== "--approve" || process.getuid?.() !== 0 || Number(process.versions.node.split(".")[0]) < 22) {
    console.error("Use system Node 22+ as root: node deploy/koin-mainnet/install-smart-qualification.js --approve POLICY_HASH"); process.exitCode = 1;
  } else { process.umask(0o077); install({ approve: args[1] }).catch(error => { console.error(error.message); process.exitCode = 1; }); }
}
module.exports = { evidence, nextRuntime, install, BASE, UNIT, PATHS, ALLOWED };
