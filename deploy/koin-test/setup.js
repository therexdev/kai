"use strict";
// Run on the operator's machine. Creates fresh Test keys; prints public pins only.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { Provider, Signer, Serializer, utils } = require("koilib");
const { KoinChain } = require("../../lib/koin-network/chain"), { TestDeployer } = require("../../lib/koin-network/test-deployer");
const { FOUNDATION_CHAIN, FOUNDATION_TOKEN } = require("../../lib/koin-network/payment-mode");
const { read, configuration } = require("../../lib/koin-network/test-config");
const { amount } = require("../../lib/koin-network/session-delegation"), P = require("../../lib/koin-network/job-protocol");
const tokenizer = require("../../lib/koin-network/tokenizers/qwen25-1.5b.json"), abi = require("../../lib/koin-network/credits-abi.json");
const RPC = "https://testnet.koinosfoundation.org/jsonrpc", roles = ["admin", "credits", "rewards", "verifier", "mining", "operations", "settlement", "lifecycle", "claims"];
const json = value => JSON.stringify(value, null, 2) + "\n";
function save(file, value) { const fd = fs.openSync(file, "wx", 0o600); try { fs.writeFileSync(fd, typeof value === "string" || Buffer.isBuffer(value) ? value : json(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function settings(s) {
  if (!s || Object.keys(s).sort().join() !== "deployRcLimit,limits,maxRcPerDay,maxRcPerTransaction,owner,schedulerUrl,tariff" || !utils.isChecksumAddress(s.owner)) throw Error("Fill the explicit Test setup settings first");
  for (const key of ["deployRcLimit", "maxRcPerTransaction", "maxRcPerDay"]) amount(s[key]);
  const t = s.tariff;
  if (!t || Object.keys(t).sort().join() !== "contextTokens,inputAtomsPerMillion,maxLatencyMs,maxOutputTokens,outputAtomsPerMillion") throw Error("Explicit Test tariff and resource limits required");
  amount(t.inputAtomsPerMillion); amount(t.outputAtomsPerMillion); P.integer(t.contextTokens, 1, 32768); P.integer(t.maxOutputTokens, 1, t.contextTokens); P.integer(t.maxLatencyMs, 1, 180000);
  if (!s.limits || Object.keys(s.limits).sort().join() !== "amount,durationMs,maxJobs,perJob") throw Error("Explicit bounded session limits required");
  amount(s.limits.amount); amount(s.limits.perJob); P.integer(s.limits.maxJobs, 1, 10000); P.integer(s.limits.durationMs, 60000, 86400000);
  if (BigInt(s.limits.perJob) > BigInt(s.limits.amount)) throw Error("Per-request limit exceeds session budget");
  return s;
}
async function prepare(directory, settingsFile, wasmDir) {
  const s = settings(JSON.parse(read(settingsFile))), artifacts = {};
  if (fs.existsSync(directory)) throw Error("Choose a new private bootstrap directory; never replace an existing deployment");
  for (const kind of ["credits", "rewards"]) {
    const bytes = fs.readFileSync(path.join(wasmDir, kind + ".wasm"));
    if (bytes.length > 2000000 || bytes.subarray(0, 4).toString("hex") !== "0061736d") throw Error("Built custody WASM required"); artifacts[kind] = { sha256: P.hash(bytes) };
  }
  const provider = new Provider([RPC]);
  if (await provider.getChainId() !== FOUNDATION_CHAIN || (await provider.invokeGetContractAddress("koin"))?.value?.address !== FOUNDATION_TOKEN) throw Error("Foundation testnet pins changed");
  const tokenHash = (await provider.invokeGetContractMetadata(FOUNDATION_TOKEN))?.value?.hash;
  const keys = Object.fromEntries(roles.map(role => [role, Signer.fromSeed(crypto.randomBytes(32).toString("hex"))]));
  const address = role => keys[role].getAddress();
  const deployment = { schema: 1, network: "foundation-testnet", chainId: FOUNDATION_CHAIN, decimals: 8, rpc: [RPC], token: FOUNDATION_TOKEN,
    ...Object.fromEntries(["admin", "credits", "rewards", "verifier", "mining", "operations"].map(r => [r, address(r)])), tokenHash,
    creditsHash: "0x1220" + artifacts.credits.sha256, rewardsHash: "0x1220" + artifacts.rewards.sha256 };
  const tariff = Object.fromEntries(Object.entries({ ...s.tariff, version: 1, model: tokenizer.model, modelHash: tokenizer.modelHash,
    tokenizerHash: tokenizer.tokenizerHash, templateHash: tokenizer.templateHash }).sort(([a], [b]) => a.localeCompare(b)));
  const runtime = configuration({ schema: 1, mode: "test-deployment", deployment, roles: Object.fromEntries(["settlement", "lifecycle", "claims"].map(r => [r, address(r)])),
    schedulerUrl: s.schedulerUrl, version: 1, tokenizer, tariff, policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", tariff])),
    maxRcPerTransaction: s.maxRcPerTransaction, maxRcPerDay: s.maxRcPerDay });
  const plan = { schema: 1, mode: "test-deployment", runtime, owner: s.owner, limits: s.limits, deployRcLimit: s.deployRcLimit, artifacts,
    fundingAddresses: Object.fromEntries(roles.map(r => [r, address(r)])) };
  const planHash = P.hash(JSON.stringify(plan));
  fs.mkdirSync(directory, { mode: 0o700 });
  save(path.join(directory, "plan.json"), plan); save(path.join(directory, "plan.sha256"), planHash + "\n");
  save(path.join(directory, "offline-keys.json"), Object.fromEntries(roles.map(r => [r, keys[r].getPrivateKey("wif")])));
  save(path.join(directory, "runtime-keys.json"), Object.fromEntries(["verifier", "settlement", "lifecycle", "claims"].map(r => [address(r), keys[r].getPrivateKey("wif")])));
  save(path.join(directory, "operator-secret"), crypto.randomBytes(32).toString("hex") + "\n");
  save(path.join(directory, "runtime.json"), runtime); save(path.join(directory, "qualifications.json"), []);
  const token = "test_" + crypto.randomBytes(32).toString("base64url"), accountId = "test_" + crypto.randomBytes(8).toString("hex"), grantId = "grant_" + crypto.randomBytes(8).toString("hex"), expiresAt = Date.now() + 30 * 86400000;
  save(path.join(directory, "invitations.json"), [{ accountId, grantId, owner: s.owner, tokenHash: P.hash(token), expiresAt, enabled: true }]);
  save(path.join(directory, "owner-access.json"), { schema: 1, mode: "test-access", owner: s.owner, schedulerUrl: s.schedulerUrl, accountId, grantId, expiresAt, token });
  console.log(json({ planHash, mode: "test-deployment", fundingAddresses: plan.fundingAddresses,
    next: "Review plan.json, fund the custody and runtime role addresses with testnet KOIN, then deploy using this exact plan hash. No transaction has been signed." }));
}
async function deploy(directory, wasmDir, approved, { planFile = "plan.json", hashFile = "plan.sha256" } = {}) {
  const plan = JSON.parse(read(path.join(directory, planFile))), hash = P.hash(JSON.stringify(plan));
  if (approved !== hash || read(path.join(directory, hashFile), 100).trim() !== hash) throw Error("Review plan.json and supply its exact --approve hash");
  const c = configuration(plan.runtime), keys = JSON.parse(read(path.join(directory, "offline-keys.json"), 16384, true));
  const provider = new Provider(c.deployment.rpc), serializer = new Serializer(abi.types), journal = new TestDeployer(path.join(directory, "deployment-journal"), { provider, identity: hash, tokenHash: c.deployment.tokenHash, mode: c.mode });
  const encoded = role => utils.encodeBase64url(utils.decodeBase58(c.deployment[role]));
  const config = { chain_id: c.deployment.chainId, token: encoded("token"), credits: encoded("credits"), treasury: encoded("rewards"),
    admin: encoded("admin"), verifier: encoded("verifier"), mining: encoded("mining"), operations: encoded("operations"), version: "1",
    daily_bps: 500, availability_bps: 7000, reward_bps: 6000, mining_bps: 2500, operations_bps: 1500, work_cap_bps: 8000 };
  try {
    for (const kind of ["credits", "rewards"]) for (const action of ["upload", "initialize"]) {
      const signer = Signer.fromWif(keys[kind]); if (signer.getAddress() !== c.deployment[kind]) throw Error("Custody key does not match the plan");
      const bytecode = fs.readFileSync(path.join(wasmDir, kind + ".wasm"));
      if (P.hash(bytecode) !== plan.artifacts[kind].sha256) throw Error("Custody build changed after review");
      const operations = action === "upload" ? [{ upload_contract: { contract_id: c.deployment[kind], bytecode: utils.encodeBase64url(bytecode) } }] :
        [{ call_contract: { contract_id: c.deployment[kind], entry_point: abi.methods.initialize.entry_point, args: utils.encodeBase64url(await serializer.serialize({ config }, "koin.Request")) } }];
      const id = kind + ":" + action; let state = await journal.prepare(id, operations, signer, plan.deployRcLimit);
      state = await journal.reconcile(id);
      if (state.state !== "finalized") {
        state = await journal.submit(id, approved);
        const until = Date.now() + 600000;
        while (state.state === "signed" && Date.now() < until) { await new Promise(r => setTimeout(r, 3000)); state = await journal.reconcile(id); }
      }
      console.log(json({ step: id, state: state.state, txId: state.draft.id, attempts: state.attempts }));
      if (state.state !== "finalized") throw Error("Deployment remains unresolved. Re-run the same reviewed command to recover its original transaction");
    }
    await new KoinChain(c.deployment).verify();
    const desktop = { schema: 1, mode: c.mode, deployment: c.deployment, schedulerUrl: c.schedulerUrl, owner: plan.owner,
      policyHash: c.policyHash, version: c.version, model: c.tariff.model, maxOutput: c.tariff.maxOutputTokens,
      maxRcPerTransaction: c.maxRcPerTransaction, maxRcPerDay: c.maxRcPerDay, limits: plan.limits };
    const file = path.join(directory, "desktop-manifest.json");
    if (!fs.existsSync(file)) save(file, desktop); else if (JSON.stringify(JSON.parse(read(file))) !== JSON.stringify(desktop)) throw Error("Existing desktop manifest changed");
    console.log(json({ verified: true, manifest: file, next: "Install the separate Test service. Import desktop-manifest.json and private owner-access.json in Test, then fund the Test reward pool before starting its daily payout cycle." }));
  } finally { journal.close(); }
}
async function tokenizerPack(directory) {
  const out = path.join(directory, "tokenizer"); fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const [name, hash] of [["tokenizer.json", tokenizer.tokenizerHash], ["tokenizer_config.json", tokenizer.configHash]]) {
    const file = path.join(out, name); if (fs.existsSync(file)) { if (P.hash(fs.readFileSync(file)) !== hash) throw Error("Installed tokenizer checksum changed"); continue; }
    const response = await fetch(`https://huggingface.co/${tokenizer.repository}/resolve/${tokenizer.revision}/${name}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error("Pinned tokenizer download failed"); const parts = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > 16000000) throw Error("Tokenizer download too large"); parts.push(part); }
    const bytes = Buffer.concat(parts); if (P.hash(bytes) !== hash) throw Error("Tokenizer download checksum mismatch"); save(file, bytes);
  }
  require("../../lib/koin-network/tokenizer").loadTokenizer(out, tokenizer); console.log("Pinned Test tokenizer verified");
}
function invite(directory, owner) {
  if (!utils.isChecksumAddress(owner || "")) throw Error("A Test participant's public wallet address is required");
  const c = configuration(JSON.parse(read(path.join(directory, "runtime.json"))));
  const desktop = JSON.parse(read(path.join(directory, "desktop-manifest.json")));
  if (JSON.stringify(desktop.deployment) !== JSON.stringify(c.deployment) || desktop.schedulerUrl !== c.schedulerUrl) throw Error("Verified Test deployment manifest required");
  const file = path.join(directory, "invitations.json"), accounts = new (require("../../lib/koin-network/test-accounts").TestAccounts)(file), rows = accounts.rows();
  const out = path.join(directory, "invites", owner), accessFile = path.join(out, "test-access.json");
  let access;
  if (fs.existsSync(accessFile)) access = JSON.parse(read(accessFile, 16384, true));
  else {
    if (rows.some(r => r.owner === owner)) throw Error("This wallet already has a Test invitation; use its original private file");
    if (rows.length >= 64) throw Error("Test invitation capacity reached");
    access = { schema: 1, mode: "test-access", owner, schedulerUrl: c.schedulerUrl,
      accountId: "test_" + crypto.randomBytes(8).toString("hex"), grantId: "grant_" + crypto.randomBytes(8).toString("hex"),
      expiresAt: Date.now() + 30 * 86400000, token: "test_" + crypto.randomBytes(32).toString("base64url") };
    fs.mkdirSync(out, { recursive: true, mode: 0o700 }); save(accessFile, access);
  }
  if (access.owner !== owner || access.schedulerUrl !== c.schedulerUrl || access.expiresAt <= Date.now() || !/^test_[A-Za-z0-9_-]{43}$/.test(access.token)) throw Error("Existing private invitation differs or expired");
  const manifest = { ...desktop, owner }, manifestFile = path.join(out, "desktop-manifest.json");
  if (!fs.existsSync(manifestFile)) save(manifestFile, manifest);
  else if (JSON.stringify(JSON.parse(read(manifestFile))) !== JSON.stringify(manifest)) throw Error("Participant deployment manifest changed");
  const row = { accountId: access.accountId, grantId: access.grantId, owner, tokenHash: P.hash(access.token), expiresAt: access.expiresAt, enabled: true };
  const prior = rows.find(r => r.owner === owner);
  if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw Error("Existing Test invitation cannot be replaced by this command");
  if (!prior) {
    const temp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
    save(temp, [...rows, row]); new (require("../../lib/koin-network/test-accounts").TestAccounts)(temp);
    fs.renameSync(temp, file);
  }
  console.log(json({ owner, manifestFile, accessFile, expiresAt: access.expiresAt,
    next: "Install the updated invitations.json on the separate Test service and transfer only this participant's two files privately. No invitation was sent and no transaction was signed." }));
  return { owner, manifestFile, accessFile };
}
async function main() {
  const [command, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) { if (!/^--[a-z-]+$/.test(args[i]) || args[i + 1] === undefined) throw Error("Use --name value arguments"); options[args[i].slice(2)] = args[i + 1]; }
  if (!options.dir || !path.isAbsolute(options.dir)) throw Error("Use an absolute --dir for private Test configuration");
  if (command === "prepare") return prepare(options.dir, options.settings, options["wasm-dir"]);
  if (command === "deploy") return deploy(options.dir, options["wasm-dir"], options.approve);
  if (command === "tokenizer") return tokenizerPack(options.dir);
  if (command === "invite") return invite(options.dir, options.owner);
  throw Error("Choose prepare, deploy, tokenizer or invite");
}
if (require.main === module) main().catch(e => { console.error(String(e.message).slice(0, 240)); process.exitCode = 1; });
module.exports = { settings, prepare, deploy, tokenizerPack, invite };
