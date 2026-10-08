#!/usr/bin/env node
"use strict";
// Operator-machine bootstrap only. No signer is attached to an RPC provider,
// no transactions are prepared, and the Test runtime remains mainnet-disabled.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { Provider, Signer } = require("koilib");
const { boundedRpc } = require("../../lib/payouts");
const { settings: testSettings } = require("../koin-test/setup");
const { atoms, hash, decimal } = require("../../lib/kai-earned-snapshot");
const { KoinChain } = require("../../lib/koin-network/chain");
const MAINNET_CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const MAINNET_TOKEN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
const ROLES = ["admin", "credits", "rewards", "verifier", "mining", "operations", "settlement", "lifecycle", "claims"];
const ACTIVE = ["credits", "rewards", "verifier", "settlement", "lifecycle", "claims"];
function configuration(c) {
  if (!c || Object.keys(c).sort().join() !== "funding,mode,rpc,settings" || c.mode !== "mainnet-pilot-plan") throw Error("Explicit mainnet pilot plan required");
  testSettings(c.settings);
  const u = new URL(c.settings.schedulerUrl);
  if (u.protocol !== "https:" || u.pathname !== "/scheduler" || u.username || u.password || u.search || u.hash || u.href !== c.settings.schedulerUrl) throw Error("Dedicated canonical HTTPS scheduler URL required");
  if (!Array.isArray(c.rpc) || c.rpc.length !== 2 || new Set(c.rpc.map(url => new URL(url).hostname)).size !== 2) throw Error("Two distinct HTTPS RPC hosts required for mainnet identity checks");
  for (const url of c.rpc) {
    const r = new URL(url);
    if (r.protocol !== "https:" || r.username || r.password || r.search || r.hash) throw Error("Public HTTPS RPC pins required; no credentials in the plan");
  }
  const f = c.funding;
  if (!f || Object.keys(f).sort().join() !== "buyerCreditsAtoms,maxTotalKoinAtoms,rewardPoolAtoms,roles" ||
      !f.roles || Object.keys(f.roles).sort().join() !== [...ROLES].sort().join()) throw Error("Explicit per-role and pilot pool funding budgets required");
  for (const n of [f.buyerCreditsAtoms, f.rewardPoolAtoms, f.maxTotalKoinAtoms, ...Object.values(f.roles)]) atoms(n);
  if (!atoms(f.maxTotalKoinAtoms) || !atoms(f.buyerCreditsAtoms) || !atoms(f.rewardPoolAtoms) || ACTIVE.some(r => !atoms(f.roles[r]))) throw Error("Fund each custody/runtime role and both pilot balances explicitly");
  const total = atoms(f.buyerCreditsAtoms) + atoms(f.rewardPoolAtoms) + Object.values(f.roles).reduce((a, b) => a + atoms(b), 0n);
  if (total > atoms(f.maxTotalKoinAtoms)) throw Error("Planned funding exceeds the approved total KOIN budget");
  if (atoms(c.settings.limits.amount) > atoms(f.buyerCreditsAtoms)) throw Error("Session budget exceeds the planned buyer credit balance");
  return { config: structuredClone(c), total: String(total) };
}
async function verifyIdentity(rpc, providerFactory = url => { const p = new Provider([url]); p.call = boundedRpc(url); return p; }) {
  const evidence = [];
  for (const url of rpc) {
    const p = providerFactory(url), chainId = await p.getChainId(), token = (await p.invokeGetContractAddress("koin"))?.value?.address;
    if (chainId !== MAINNET_CHAIN || token !== MAINNET_TOKEN) throw Error("Mainnet chain/native-token identity mismatch");
    const tokenHash = (await p.invokeGetContractMetadata(token))?.value?.hash;
    if (!/^0x1220[a-f0-9]{64}$/.test(tokenHash || "")) throw Error("Native KOIN bytecode pin missing");
    evidence.push({ rpc: url, chainId, token, tokenHash });
  }
  if (new Set(evidence.map(e => e.tokenHash)).size !== 1) throw Error("RPC native-token code hashes disagree");
  return evidence;
}
function save(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function prepare(directory, settingsFile, wasmDirectory, dependencies = {}) {
  if (!path.isAbsolute(directory) || fs.existsSync(directory)) throw Error("Use a new absolute private bootstrap directory");
  const { config: c, total } = configuration(JSON.parse(fs.readFileSync(settingsFile, "utf8")));
  const artifacts = {};
  for (const kind of ["credits", "rewards"]) {
    const file = path.join(wasmDirectory, kind + ".wasm"), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 2000000) throw Error("Built custody WASM required");
    const bytes = fs.readFileSync(file);
    if (bytes.subarray(0, 8).toString("hex") !== "0061736d01000000") throw Error("Valid WASM v1 header required");
    artifacts[kind] = { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  }
  const evidence = await verifyIdentity(c.rpc, dependencies.providerFactory);
  // Keys are generated only after all supplied inputs and chain pins pass.
  const keys = Object.fromEntries(ROLES.map(role => [role, Signer.fromSeed(crypto.randomBytes(32).toString("hex"))]));
  const addresses = Object.fromEntries(ROLES.map(role => [role, keys[role].getAddress()]));
  const deployment = { schema: 1, network: "mainnet", chainId: MAINNET_CHAIN, decimals: 8, rpc: c.rpc, token: MAINNET_TOKEN,
    ...Object.fromEntries(["admin", "credits", "rewards", "verifier", "mining", "operations"].map(r => [r, addresses[r]])),
    tokenHash: evidence[0].tokenHash, creditsHash: "0x1220" + artifacts.credits.sha256, rewardsHash: "0x1220" + artifacts.rewards.sha256 };
  new KoinChain(deployment); // Validate the complete public deployment shape.
  const plan = { schema: 1, mode: "mainnet-pilot-plan", runtimeReady: false, deployment, settings: c.settings, artifacts,
    funding: { ...c.funding, totalAtoms: total, totalKoin: decimal(total) }, roleAddresses: addresses, identityEvidence: evidence,
    remaining: ["Implement and verify explicit mainnet signing, worker, session and reward modes", "Confirm server and DNS configuration",
      "Review exact custody deployment transactions and measured resource requirements", "Fund reviewed role addresses and pilot balances", "Complete real Test acceptance before Alpha"] };
  const planHash = hash(plan);
  fs.mkdirSync(directory, { mode: 0o700 });
  save(path.join(directory, "offline-keys.json"), Object.fromEntries(ROLES.map(r => [r, keys[r].getPrivateKey("wif")])));
  save(path.join(directory, "plan.json"), plan);
  save(path.join(directory, "plan-hash.json"), { algorithm: "sha256-json", sha256: planHash });
  return { planHash, mode: plan.mode, runtimeReady: false, totalKoin: decimal(total), roleAddresses: addresses,
    next: "Back up the private keys offline. Review the plan. No transaction has been signed or sent; this plan cannot enable payments." };
}
if (require.main === module) {
  const [directory, settingsFile, wasmDirectory, ...extra] = process.argv.slice(2);
  if (!directory || !settingsFile || !wasmDirectory || extra.length) { console.error("Usage: node deploy/koin-mainnet/prepare.js ABS_PRIVATE_DIR SETTINGS_JSON BUILT_WASM_DIR"); process.exitCode = 1; }
  else prepare(directory, settingsFile, wasmDirectory).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { configuration, verifyIdentity, prepare, MAINNET_CHAIN, MAINNET_TOKEN, ROLES };
