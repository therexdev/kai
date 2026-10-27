"use strict";
// Read-only post-install report. Never load signers, import a runtime, or invoke
// a transaction method. Public addresses and fixed diagnostic categories only.
const fs = require("node:fs"), path = require("node:path");
const UINT = /^(0|[1-9][0-9]{0,19})$/;
const integer = value => { if (typeof value !== "string" || !UINT.test(value)) throw Error("Invalid observed amount"); return value; };
const PAYOUT_STATES = new Set(["queued", "signing", "staged", "unknown", "pending", "reversible", "needs_review", "paid", "paid_elsewhere"]);
function payoutJournal(stateDir, deployment) {
  const file = path.join(stateDir, "claims", "reward-claims.sqlite");
  if (!fs.existsSync(file)) return { state: "not-created", confirmed: 0, pending: 0, needsReview: 0, recent: [], chainRechecked: false };
  let db;
  try {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink()) throw Error("Invalid ledger path");
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true }); db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    const identity = JSON.parse(db.prepare("SELECT data FROM identity WHERE id=1").get()?.data || "null");
    for (const key of ["chainId", "credits", "creditsHash", "rewards", "rewardsHash", "token", "tokenHash"])
      if (!deployment[key] || identity?.target?.[key] !== deployment[key]) throw Error("Different reward deployment");
    const counts = db.prepare("SELECT state, COUNT(*) AS count FROM claims GROUP BY state").all();
    if (counts.some(row => !PAYOUT_STATES.has(row.state) || !Number.isSafeInteger(row.count) || row.count < 0)) throw Error("Invalid claim summary");
    const total = states => counts.filter(row => states.includes(row.state)).reduce((n, row) => n + row.count, 0);
    const recent = db.prepare("SELECT state, tx_id AS txId, json_extract(data,'$.epoch') AS epoch FROM claims ORDER BY rowid DESC LIMIT 8").all();
    if (recent.some(row => !PAYOUT_STATES.has(row.state) || typeof row.epoch !== "string" || !UINT.test(row.epoch) || (row.txId !== null && !/^0x1220[a-f0-9]{64}$/.test(row.txId)))) throw Error("Invalid claim summary");
    return { state: "read", source: "existing payout journal", confirmed: total(["paid", "paid_elsewhere"]),
      pending: total([...PAYOUT_STATES].filter(state => !["paid", "paid_elsewhere", "needs_review"].includes(state))),
      needsReview: total(["needs_review"]), recent, chainRechecked: false };
  } catch { return { state: "unavailable", reason: "payout_journal_could_not_be_verified", chainRechecked: false }; }
  finally { db?.close(); }
}
async function chainReadiness(config, { client, signal = AbortSignal.timeout(30000) } = {}) {
  if (!client) {
    const { KoinChain } = require("../../lib/koin-network/chain"), { PinnedRpcProvider } = require("../../lib/koin-network/rpc-provider");
    client = new KoinChain(config.deployment, new PinnedRpcProvider(config.deployment.rpc, config.deployment.chainId, { timeoutMs: 30000, attemptTimeoutMs: 12000 }));
  }
  const check = async () => {
    const verified = await client.verify(); signal.throwIfAborted();
    const roles = Object.entries(config.roles);
    const [pool, available] = await Promise.all([client.read("rewards", "balances"), Promise.all(roles.map(async ([role, address]) => ({
      role, address, availableManaAtoms: integer(String(await client.provider.getAccountRc(address))),
      configuredTransactionCeiling: integer(config.maxRcPerTransaction),
    }))) ]);
    signal.throwIfAborted();
    const liquid = integer(pool.liquid || "0"), liabilities = integer(pool.liabilities || "0");
    const free = config.freePolicy, accountLimit = integer(verified.credits?.sponsor_account_daily_limit || "0"), networkLimit = integer(verified.credits?.sponsor_daily_limit || "0");
    const unallocated = BigInt(liquid) > BigInt(liabilities) ? BigInt(liquid) - BigInt(liabilities) : 0n;
    const fundedWork = ((unallocated * 500n / 10000n) * 3000n / 10000n) > 0n;
    const sponsored = !!free && !verified.paused && verified.credits?.reward_basis === 1 && String(verified.credits?.version) === String(config.version) &&
      BigInt(accountLimit) >= BigInt(free.accountDaily) && BigInt(networkLimit) >= BigInt(free.networkDaily) && fundedWork;
    return { state: "verified", observedAt: Date.now(), paused: verified.paused === true,
      rewardPool: { address: config.deployment.rewards, liquidAtoms: liquid, liabilitiesAtoms: liabilities, unallocatedAtoms: String(unallocated), fundedForDailyWork: fundedWork },
      sponsorship: { chainAccountDailyUsdAtoms: accountLimit, chainNetworkDailyUsdAtoms: networkLimit, configuredPolicyCovered: sponsored },
      mana: available.map(row => ({ ...row, coversConfiguredCeiling: BigInt(row.availableManaAtoms) >= BigInt(row.configuredTransactionCeiling) })) };
  };
  return client.provider.withSignal ? client.provider.withSignal(signal, check) : check();
}
async function readiness({ config, observed, paths, commit, inspectChain = chainReadiness, inspectPayouts = payoutJournal, clock = Date.now }) {
  const now = clock(), operator = observed?.operator;
  let chain;
  try { chain = await inspectChain(config); }
  catch { chain = { state: "unavailable", reason: "read_only_chain_checks_unavailable" }; }
  const payouts = inspectPayouts(paths.state, config.deployment), free = config.freePolicy;
  const policies = config.qualificationPolicies || (config.qualificationPolicy ? [config.qualificationPolicy] : []);
  const admission = policies.map(p => p.model), freeEligible = free?.eligibleModels || [];
  const blocked = [];
  if (chain.state !== "verified") blocked.push("Current chain balances and Mana could not be verified; existing records were left unchanged.");
  else {
    if (chain.paused) blocked.push("The on-chain service is paused.");
    if (!chain.rewardPool.fundedForDailyWork) blocked.push("The reward pool has no unallocated funding for daily work rewards. Fund the reward contract through its funding action before expecting payouts or free usage.");
    if (free && !chain.sponsorship.configuredPolicyCovered) blocked.push("The configured free allowance is not currently backed by the contract sponsorship limits and funded reward pool.");
    for (const role of chain.mana.filter(row => !row.coversConfiguredCeiling)) blocked.push(role.role + " Mana is below the configured transaction ceiling at " + role.address + ". Allow Mana to recharge or fund that role; no transfer was made.");
  }
  if (!free) blocked.push("Free credits are not configured on this service.");
  if (freeEligible.some(model => !admission.includes(model))) blocked.push("At least one free-eligible model lacks qualification criteria.");
  if (operator?.sponsorship?.configured && !operator.sponsorship.ready) blocked.push("The running service has not yet observed fresh sponsorship readiness.");
  if (payouts.needsReview) blocked.push("Existing reward claims need review; saved transactions were preserved.");
  if (payouts.state === "unavailable") blocked.push("The existing payout journal could not be verified read-only.");
  const last = operator?.lastSuccess;
  return { schema: 1, installed: true, status: blocked.length ? "installed-attention-needed" : "installed-ready-for-app-update", commit, readOnly: true, transactionsSubmittedByCheck: false,
    walletConnection: "No mandatory email/password signup", earning: "Authorize this device once, then the wallet may remain locked",
    qualification: { configuredModels: admission, freshDeviceQualificationRequired: true, eligibilityCreatedByUpdate: false },
    freeCredits: { configured: !!free, ...(free ? { accountDailyUsdAtoms: free.accountDaily, networkDailyUsdAtoms: free.networkDaily, eligibleModels: freeEligible } : {}),
      serviceReady: operator?.sponsorship?.ready === true },
    rewards: { automaticPayouts: operator?.automaticPayouts === true, lastSettlementSuccess: Number.isSafeInteger(last) ? last : null,
      recentSettlementPass: Number.isSafeInteger(last) && last <= now && now - last <= 60000, payouts },
    chain, blockers: blocked, next: blocked.length
      ? "Software is installed. Address the listed operating conditions before expecting the complete free-credit and reward flow to work. No payment should be repeated to fix these conditions."
      : "Update Koinos AI Test, connect your wallet, enable earning on the provider, then test Buy credits and Network chat." };
}
module.exports = { readiness, chainReadiness, payoutJournal };
