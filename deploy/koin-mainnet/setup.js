#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { Signer, Provider, Contract, utils } = require("koilib");
const { boundedRpc } = require("../../lib/payouts");
const { configuration: budget, verifyIdentity, MAINNET_CHAIN, MAINNET_TOKEN, ROLES } = require("./prepare");
const { configuration, read } = require("../../lib/koin-network/test-config");
const { KoinChain } = require("../../lib/koin-network/chain");
const { TestDeployer } = require("../../lib/koin-network/test-deployer");
const { assertPaymentMode } = require("../../lib/koin-network/payment-mode");
const P = require("../../lib/koin-network/job-protocol"), shared = require("../koin-test/setup");
const tokenizer = require("../../lib/koin-network/tokenizers/qwen25-1.5b.json");
const json = v => JSON.stringify(v, null, 2) + "\n";
function save(file, value) {
  if (fs.existsSync(file)) { if (read(file) !== json(value)) throw Error("Existing mainnet configuration changed: " + path.basename(file)); return; }
  const fd = fs.openSync(file, "wx", 0o600); try { fs.writeFileSync(fd, json(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function reviewedPlan(directory) {
  if (!path.isAbsolute(directory)) throw Error("Absolute private bootstrap directory required");
  const p = JSON.parse(read(path.join(directory, "plan.json"))), hash = P.hash(JSON.stringify(p));
  if (JSON.parse(read(path.join(directory, "plan-hash.json"))).sha256 !== hash || p.mode !== "mainnet-pilot-plan") throw Error("Original mainnet plan hash mismatch");
  const c = budget({ mode: p.mode, rpc: p.deployment.rpc, settings: p.settings,
    funding: Object.fromEntries(["buyerCreditsAtoms", "rewardPoolAtoms", "maxTotalKoinAtoms", "roles"].map(k => [k, p.funding[k]])) });
  if (c.total !== p.funding.totalAtoms) throw Error("Mainnet funding total changed");
  assertPaymentMode("mainnet-pilot", new KoinChain(p.deployment));
  for (const kind of ["credits", "rewards"]) if (p.deployment[kind + "Hash"] !== "0x1220" + p.artifacts[kind].sha256) throw Error("Custody code differs from the bootstrap plan");
  return p;
}
async function configure(directory, approved, providerFactory) {
  const p = reviewedPlan(directory);
  if (P.hash(JSON.stringify(p)) !== approved) throw Error("Pass the exact reviewed bootstrap --approve hash");
  const evidence = await verifyIdentity(p.deployment.rpc, providerFactory);
  if (evidence[0].tokenHash !== p.deployment.tokenHash) throw Error("Native token code changed after bootstrap review");
  const keys = JSON.parse(read(path.join(directory, "offline-keys.json"), 16384, true));
  if (Object.keys(keys).sort().join() !== [...ROLES].sort().join()) throw Error("Exact offline role keys required");
  for (const role of ROLES) {
    if (Signer.fromWif(keys[role]).getAddress() !== p.roleAddresses[role] ||
        (p.deployment[role] !== undefined && p.deployment[role] !== p.roleAddresses[role])) throw Error("Mainnet role key changed");
  }
  const s = p.settings, tariff = Object.fromEntries(Object.entries({ ...s.tariff, version: 1, model: tokenizer.model,
    modelHash: tokenizer.modelHash, tokenizerHash: tokenizer.tokenizerHash, templateHash: tokenizer.templateHash }).sort(([a], [b]) => a.localeCompare(b)));
  const runtime = configuration({ schema: 1, mode: "mainnet-pilot", deployment: p.deployment,
    roles: Object.fromEntries(["settlement", "lifecycle", "claims"].map(r => [r, p.roleAddresses[r]])), schedulerUrl: s.schedulerUrl,
    version: 1, tokenizer, tariff, policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", tariff])),
    maxRcPerTransaction: s.maxRcPerTransaction, maxRcPerDay: s.maxRcPerDay });
  const plan = { schema: 1, mode: runtime.mode, runtime, owner: s.owner, limits: s.limits, deployRcLimit: s.deployRcLimit,
    artifacts: p.artifacts, fundingAddresses: p.roleAddresses, funding: p.funding, bootstrapHash: approved };
  save(path.join(directory, "deployment-plan.json"), plan);
  const planHash = P.hash(JSON.stringify(plan)), hashFile = path.join(directory, "deployment-plan.sha256");
  if (!fs.existsSync(hashFile)) fs.writeFileSync(hashFile, planHash + "\n", { mode: 0o600, flag: "wx" });
  else if (read(hashFile).trim() !== planHash) throw Error("Deployment plan hash changed");
  save(path.join(directory, "runtime.json"), runtime);
  save(path.join(directory, "runtime-keys.json"), Object.fromEntries(["verifier", "settlement", "lifecycle", "claims"].map(r => [p.roleAddresses[r], keys[r]])));
  const secret = path.join(directory, "operator-secret");
  if (!fs.existsSync(secret)) fs.writeFileSync(secret, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  if (!/^[a-f0-9]{64}$/.test(read(secret, 256, true).trim())) throw Error("Invalid operator secret");
  if (!fs.existsSync(path.join(directory, "qualifications.json"))) save(path.join(directory, "qualifications.json"), []);
  const accessFile = path.join(directory, "owner-access.json");
  if (!fs.existsSync(accessFile)) save(accessFile, { schema: 1, mode: "test-access", owner: s.owner, schedulerUrl: s.schedulerUrl,
    accountId: "test_" + crypto.randomBytes(8).toString("hex"), grantId: "grant_" + crypto.randomBytes(8).toString("hex"),
    expiresAt: Date.now() + 30 * 86400000, token: "test_" + crypto.randomBytes(32).toString("base64url") });
  const a = JSON.parse(read(accessFile, 16384, true));
  if (a.owner !== s.owner || a.schedulerUrl !== s.schedulerUrl || !/^test_[A-Za-z0-9_-]{43}$/.test(a.token)) throw Error("Owner invitation changed");
  const invitations = path.join(directory, "invitations.json");
  if (!fs.existsSync(invitations)) save(invitations, [{ accountId: a.accountId, grantId: a.grantId, owner: a.owner, tokenHash: P.hash(a.token), expiresAt: a.expiresAt, enabled: true }]);
  return { mode: runtime.mode, planHash, deployed: false, next: "Review deployment-plan.json. Fund the reviewed role addresses, then run check-funding and deploy with this exact deployment plan hash. No transaction was signed." };
}
function deploymentJournal(directory, p, provider) {
  const plan = JSON.parse(read(path.join(directory, "deployment-plan.json"))), hash = P.hash(JSON.stringify(plan));
  if (read(path.join(directory, "deployment-plan.sha256"), 100).trim() !== hash || plan.bootstrapHash !== P.hash(JSON.stringify(p))) throw Error("Original deployment plan hash mismatch");
  return { plan, hash, journal: new TestDeployer(path.join(directory, "deployment-journal"), { provider, identity: hash, tokenHash: p.deployment.tokenHash, mode: "mainnet-pilot" }) };
}
function currentResourceRevision(directory, p) {
  if (!fs.existsSync(path.join(directory, "deployment-journal"))) return null;
  const { journal } = deploymentJournal(directory, p);
  try { return journal.resourceRevision(); } finally { journal.close(); }
}
async function reviseResources(directory, approved, rcLimit, custodyAtoms, providerFactory = url => { const p = new Provider(url); p.call = boundedRpc(url); return p; }) {
  const p = reviewedPlan(directory);
  if (!fs.existsSync(path.join(directory, "deployment-journal", "deployment.sqlite"))) throw Error("Existing deployment journal required; do not regenerate wallets");
  const providers = p.deployment.rpc.map(providerFactory), { plan, hash, journal } = deploymentJournal(directory, p, providers[0]);
  try {
    if (approved !== hash) throw Error("Supply the original deployment plan hash for resource revision");
    const revision = await journal.reviseResources(plan, rcLimit, custodyAtoms, providers);
    return { mode: "mainnet-resource-revision", planHash: revision.planHash, originalPlanHash: hash,
      deployRcLimit: revision.plan.deployRcLimit, funding: revision.plan.funding, roleAddresses: p.roleAddresses,
      supersededTxId: revision.supersededTxId,
      next: "No new transaction was signed or broadcast. The original envelope is retained. Review this revision, fund the same custody addresses, and deploy using this new planHash." };
  } finally { journal.close(); }
}
async function checkFunding(directory) {
  const p = reviewedPlan(directory), evidence = await verifyIdentity(p.deployment.rpc);
  if (evidence[0].tokenHash !== p.deployment.tokenHash) throw Error("Native KOIN bytecode changed");
  const revision = currentResourceRevision(directory, p);
  const funding = revision?.plan.funding || p.funding, deployRcLimit = revision?.plan.deployRcLimit || p.settings.deployRcLimit;
  const provider = new Provider(p.deployment.rpc); provider.call = boundedRpc(p.deployment.rpc[0]);
  const token = new Contract({ id: MAINNET_TOKEN, abi: utils.tokenAbi, provider }), roles = [];
  for (const role of ROLES) {
    const address = p.roleAddresses[role], response = await token.functions.balanceOf({ owner: address });
    const balance = String(response.result?.value || "0"), rc = String(await provider.getAccountRc(address)), planned = funding.roles[role];
    const neededRc = ["credits", "rewards"].includes(role) ? deployRcLimit : ["verifier", "settlement", "lifecycle", "claims"].includes(role) ? p.settings.maxRcPerTransaction : "0";
    roles.push({ role, address, balanceAtoms: balance, plannedAtoms: planned, availableRc: rc, requiredRc: neededRc, ready: BigInt(balance) >= BigInt(planned) && BigInt(rc) >= BigInt(neededRc) });
  }
  return { chainId: MAINNET_CHAIN, ready: roles.every(r => r.ready), roles, buyerCreditsAtoms: funding.buyerCreditsAtoms,
    rewardPoolAtoms: funding.rewardPoolAtoms, maxTotalKoinAtoms: funding.maxTotalKoinAtoms, ...(revision ? { planHash: revision.planHash, totalKoin: funding.totalKoin } : {}) };
}
async function main() {
  const [command, ...args] = process.argv.slice(2), o = {};
  for (let i = 0; i < args.length; i += 2) { if (!/^--(dir|approve|wasm-dir|owner|deploy-rc-limit|custody-atoms)$/.test(args[i]) || args[i + 1] === undefined || args[i] in o) throw Error("Use explicit --name value arguments"); o[args[i]] = args[i + 1]; }
  if (!o["--dir"] || !path.isAbsolute(o["--dir"])) throw Error("Absolute --dir required");
  const d = o["--dir"];
  if (command === "configure") return console.log(json(await configure(d, o["--approve"])));
  if (command === "check-funding") return console.log(json(await checkFunding(d)));
  if (command === "tokenizer") return shared.tokenizerPack(d);
  if (command === "invite") return shared.invite(d, o["--owner"]);
  if (command === "revise-resources") return console.log(json(await reviseResources(d, o["--approve"], o["--deploy-rc-limit"], o["--custody-atoms"])));
  if (command === "deploy") {
    const p = JSON.parse(read(path.join(d, "deployment-plan.json")));
    const revision = currentResourceRevision(d, reviewedPlan(d));
    if (p.mode !== "mainnet-pilot" || o["--approve"] !== (revision?.planHash || P.hash(JSON.stringify(p)))) throw Error("Review the exact current mainnet deployment plan hash first");
    if (revision) {
      const { journal } = deploymentJournal(d, reviewedPlan(d));
      let pendingRevision;
      try { pendingRevision = journal.get("credits:upload")?.state === "superseded"; } finally { journal.close(); }
      if (pendingRevision && !(await checkFunding(d)).ready) throw Error("Revised custody funding or available Mana is insufficient");
    }
    if (!fs.existsSync(path.join(d, "deployment-journal")) && !(await checkFunding(d)).ready) throw Error("Planned role funding or available Mana is insufficient");
    return shared.deploy(d, o["--wasm-dir"], o["--approve"], { planFile: "deployment-plan.json", hashFile: "deployment-plan.sha256" });
  }
  throw Error("Choose configure, check-funding, revise-resources, deploy, tokenizer or invite");
}
if (require.main === module) main().catch(e => { console.error(String(e.message).slice(0, 240)); process.exitCode = 1; });
module.exports = { configure, reviewedPlan, checkFunding, reviseResources, currentResourceRevision };
