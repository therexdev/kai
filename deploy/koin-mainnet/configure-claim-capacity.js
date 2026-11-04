"use strict";
// Operator configuration only: no keys, signing, database writes or broadcasts.
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process"), { DatabaseSync } = require("node:sqlite");
const { FILE, plan, allowance } = require("../../lib/koin-network/claim-sponsorship");
const P = require("../../lib/koin-network/job-protocol"), { uint } = require("../../lib/koin-network/policy");
const { PATHS, UNIT } = require("./update-wallet-access");
const { configDigest } = require("./update-prepaid-web");
function ledgerIdentity(state, config) {
  const file = path.join(state, "claims", "reward-claims.sqlite"), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Existing regular claims journal required");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    const raw = db.prepare("SELECT data FROM identity WHERE id=1").get()?.data, value = JSON.parse(raw || "null");
    if (value?.schema !== 1 || value.mode !== "reward-mainnet-pilot") throw Error("Mainnet claim ledger identity required");
    for (const key of ["chainId", "credits", "creditsHash", "rewards", "rewardsHash", "token", "tokenHash", "verifier"])
      if (value.target?.[key] !== config.deployment[key]) throw Error("Claim ledger deployment mismatch");
    const policy = value.policy;
    if (policy?.payer !== config.roles.claims || policy.verifier !== config.roles.claims ||
        policy.maxRcPerTransaction !== config.maxRcPerTransaction || policy.maxRcPerDay !== config.maxRcPerDay ||
        policy.maxAttempts !== 3 || policy.minRetryMs !== 10000 || value.target.version !== String(config.version) ||
        value.target.workCapBps !== 8000 || value.target.rewardBasis !== "usd-pool") throw Error("Claim ledger sponsorship policy mismatch");
    return raw;
  } finally { db.close(); }
}
async function operator(configDir, fetchImpl = fetch) {
  const secret = fs.readFileSync(path.join(configDir, "operator-secret"), "utf8").trim();
  const response = await fetchImpl("http://127.0.0.1:3109/operator/status", { headers: { "x-operator-secret": secret },
    redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error("Operator status unavailable; claim allowance was not verified");
  const body = await response.text(); if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw Error("Operator response too large");
  return JSON.parse(body);
}
function atomicAuthorization(file, value, configFile, expectedDigest) {
  const directory = path.dirname(file), stat = fs.statSync(configFile);
  const temporary = fs.mkdtempSync(path.join(path.dirname(directory), ".kai-claim-capacity-"));
  try {
    const staged = path.join(temporary, FILE), fd = fs.openSync(staged, "wx", 0o640);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fs.fchownSync(fd, 0, stat.gid); fs.fchmodSync(fd, 0o640); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (configDigest(directory) !== expectedDigest) throw Error("Concurrent configuration change preserved");
    fs.renameSync(staged, file);
    const dirfd = fs.openSync(directory, "r"); try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function funding(config, capacity) {
  const { KoinChain } = require("../../lib/koin-network/chain"), { Contract, utils } = require("koilib");
  const client = new KoinChain(config.deployment); await client.verify();
  const token = new Contract({ id: config.deployment.token, abi: utils.tokenAbi, provider: client.provider });
  const owner = config.roles.claims, response = await token.functions.balanceOf({ owner });
  const balance = uint(response.result?.value), available = uint(String(await client.provider.getAccountRc(owner)));
  const target = uint(capacity.sponsorBalanceTargetAtoms);
  return { address: owner, balanceAtoms: String(balance), availableManaAtoms: String(available),
    targetBalanceAtoms: String(target), topUpAtoms: String(target > balance ? target - balance : 0n),
    transferSubmitted: false };
}
async function configure({ providers = 100, apply = false, paths: p = PATHS, readOperator = operator, inspectFunding = funding,
  validate = require("../../lib/koin-network/test-config").configuration,
  show = key => execFileSync("systemctl", ["show", UNIT, "--value", "--property=" + key], { encoding: "utf8" }).trim() } = {}) {
  const locks = [];
  try {
    for (const name of require("./update-claim-capacity").LOCKS) {
      const lock = path.join(p.work, name); fs.mkdirSync(lock, { mode: 0o700 }); locks.push(lock);
    }
    if (show("ActiveState") !== "active") throw Error("Start and verify the scheduler before configuring claim capacity");
    const configFile = path.join(p.config, "runtime.json"), digest = configDigest(p.config);
    const config = validate(JSON.parse(fs.readFileSync(configFile, "utf8")));
    if (config.mode !== "mainnet-pilot" || config.deployment.product !== "prepaid-usd-v1") throw Error("Mainnet prepaid configuration required");
    const identity = ledgerIdentity(p.state, config), identityHash = P.hash(identity);
    const capacity = plan(providers, config.maxRcPerTransaction);
    const authorization = { schema: 1, ledgerIdentityHash: identityHash, maxRcPerDay: capacity.maxRcPerDay };
    allowance(authorization, identity, config.maxRcPerDay);
    const before = await readOperator(p.config), status = before.claimSponsorship;
    if (status?.version !== 1 || status.ledgerIdentityHash !== identityHash || status.payer !== config.roles.claims ||
        status.maxRcPerTransaction !== config.maxRcPerTransaction || before.chainId !== config.deployment.chainId)
      throw Error("Install and verify claim capacity support before changing the allowance");
    let funds;
    try { funds = await inspectFunding(config, capacity); }
    catch { funds = { address: config.roles.claims, state: "unavailable", transferSubmitted: false }; }
    const result = { applied: false, capacity, funding: funds, current: status };
    if (!apply) return result;
    if (show("ActiveState") !== "active" || ledgerIdentity(p.state, config) !== identity) throw Error("Service or claim identity changed; allowance unchanged");
    atomicAuthorization(path.join(p.config, FILE), authorization, configFile, digest);
    // The running service reads this protected file for each new reservation.
    // A failed verification must not claim the write was undone or retry a tx.
    let after;
    try { after = (await readOperator(p.config)).claimSponsorship; }
    catch { throw Error("Allowance file installed, but operator verification failed. Re-run --plan; no payment was submitted by this command"); }
    if (after?.ledgerIdentityHash !== identityHash || after.maxRcPerDay !== capacity.maxRcPerDay)
      throw Error("Allowance file installed, but the running service has not verified it. Re-run --plan");
    return { ...result, applied: true, current: after };
  } finally { for (const lock of locks.reverse()) fs.rmdirSync(lock); }
}
if (require.main === module) {
  const [mode, count] = process.argv.slice(2);
  if (process.getuid?.() !== 0 || !["--plan", "--apply"].includes(mode) || !/^[1-9][0-9]{0,3}$/.test(count || "") || process.argv.length !== 4)
    throw Error("Run as root: node deploy/koin-mainnet/configure-claim-capacity.js --plan|--apply PROVIDERS (1..1000)");
  process.umask(0o077);
  configure({ providers: Number(count), apply: mode === "--apply" }).then(v => console.log(JSON.stringify(v, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { ledgerIdentity, atomicAuthorization, configure, funding };
