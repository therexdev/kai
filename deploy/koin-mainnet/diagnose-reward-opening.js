"use strict";
// Read-only diagnostics: no runtime, journal constructor, key loader or sender.
const fs = require("node:fs"), path = require("node:path"), { DatabaseSync } = require("node:sqlite");
const { setTimeout: delay } = require("node:timers/promises");
const { Serializer, utils } = require("koilib");
const { KoinChain } = require("../../lib/koin-network/chain");
const { PinnedRpcProvider, rpcDiagnostics } = require("../../lib/koin-network/rpc-provider");
const { RewardObserver } = require("../../lib/koin-network/reward-observer");
const { readGroup } = require("../../lib/koin-network/read-group");
const M = require("../../lib/koin-network/reward-manifest"), O = require("../../lib/koin-network/settlement-outbox");
const P = require("../../lib/koin-network/job-protocol"), ABI = require("../../lib/koin-network/rewards-abi.json");
const { isUsd } = require("../../lib/koin-network/product");
const DAY = 86400000;
function targetFor(config) {
  const d = config.deployment;
  return M.target({ ...Object.fromEntries(["chainId", "credits", "creditsHash", "rewards", "rewardsHash", "token", "tokenHash", "verifier"].map(k => [k, d[k]])),
    version: String(config.version), workCapBps: 8000, ...(isUsd(d) ? { rewardBasis: "usd-pool" } : {}) });
}
function readPending(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA query_only=ON; BEGIN");
    const identity = db.prepare("SELECT data FROM identity WHERE id=1").get()?.data;
    const row = db.prepare("SELECT * FROM steps WHERE method='finalize_root' AND tx_id IS NOT NULL AND state NOT IN ('complete','observed_external') ORDER BY length(epoch),epoch LIMIT 1").get();
    if (!row) throw Error("No unresolved signed reward finalization was found");
    const day = db.prepare("SELECT manifest,hash FROM days WHERE epoch=?").get(row.epoch);
    return { identity, row, day };
  } finally { db.close(); }
}
async function validateSaved(saved, config) {
  const target = targetFor(config), identity = JSON.parse(saved.identity), { row, day } = saved;
  if (identity.mode !== config.mode || JSON.stringify(M.target(identity.target)) !== JSON.stringify(target) ||
      identity.policy?.payer !== config.roles.lifecycle || identity.policy.verifier !== target.verifier ||
      identity.policy.maxRcPerTransaction !== config.maxRcPerTransaction || identity.policy.maxRcPerDay !== config.maxRcPerDay ||
      identity.policy.maxAttempts !== 3 || identity.policy.minRetryMs !== 10000 ||
      identity.budgetPolicy?.dailyBps !== 500 || identity.budgetPolicy.availabilityBps !== 7000)
    throw Error("Saved lifecycle identity differs from configured deployment or policy");
  if (!row || row.method !== "finalize_root" || !/^(0|[1-9][0-9]*)$/.test(row.epoch) || row.hash !== P.hash(row.data))
    throw Error("Damaged saved lifecycle row");
  const step = JSON.parse(row.data), tx = step.outbox?.transaction;
  if (step.id !== row.id || step.id !== P.hash(saved.identity + ":" + row.epoch + ":finalize_root") ||
      step.epoch !== row.epoch || step.method !== row.method || step.state !== row.state ||
      !["staged", "unknown", "pending", "reversible", "needs_review"].includes(step.state) ||
      !tx || tx.id !== row.tx_id || step.outbox.hash !== P.hash(JSON.stringify(tx)))
    throw Error("Saved lifecycle transaction binding differs");
  const admitted = M.verify(JSON.parse(day?.manifest), target);
  if (admitted.hash !== day.hash || admitted.envelope.manifest.epoch !== row.epoch) throw Error("Saved lifecycle manifest binding differs");
  const root = admitted.envelope.manifest.root;
  const args = { ...(row.epoch !== "0" && { epoch: row.epoch }), root: {
    hash: Buffer.from(root.hash, "hex").toString("base64url"),
    ...(root.availability !== "0" && { availability: root.availability }), ...(root.work !== "0" && { work: root.work }) } };
  const operation = { contract_id: target.rewards, entry_point: ABI.methods.finalize_root.entry_point,
    args: utils.encodeBase64url(await new Serializer(ABI.types).serialize(args, "koin.Request")) };
  // Signature recovery/commitment validation only: this never signs or submits.
  const checked = await O.validateSigned(tx, { target, policy: { ...O.policy(identity.policy), verifier: identity.policy.payer }, operation });
  if (checked.nonce !== step.outbox.nonce || checked.rcLimit !== step.outbox.rcLimit) throw Error("Saved lifecycle nonce or Mana binding differs");
  P.integer(step.updatedAt); P.integer(step.outbox.createdAt); P.integer(step.outbox.attempts, 0, identity.policy.maxAttempts);
  if (step.outbox.lastAttemptAt !== null) P.integer(step.outbox.lastAttemptAt, step.outbox.createdAt, step.updatedAt);
  return { target, step, transaction: checked.transaction, operation, nonce: checked.nonce };
}
const publicProof = proof => ({ state: proof.state,
  ...Object.fromEntries(["height", "irreversibleHeight", "blockTime"].filter(k => proof[k] !== undefined).map(k => [k, proof[k]])) });
function epochSummary(value, root) {
  if (!value) return { found: false };
  return { found: true, openedAt: value.opened_at || null, finalized: value.finalized === true, expired: value.expired === true,
    reviewUntil: value.review_until || null,
    rootMatchesSaved: !!value.root && Buffer.from(value.root.hash || "", "base64url").toString("hex") === root.hash &&
      (value.root.availability || "0") === root.availability && (value.root.work || "0") === root.work };
}
async function endpointProbe({ endpoint, config, saved, clock = Date.now, timeoutMs = 45000, samples = 3, sampleDelayMs = 10000,
  createClient = (deployment, url) => new KoinChain(deployment, new PinnedRpcProvider([url], deployment.chainId)), log = console.log }) {
  const origin = new URL(endpoint).origin, client = createClient(config.deployment, endpoint);
  const observer = new RewardObserver(client.provider, { target: saved.target, clock });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs), startedAt = clock();
  const today = String(Math.floor(startedAt / DAY)), oldEpoch = saved.step.epoch;
  const emit = value => log(JSON.stringify({ probe: "reward opening", endpoint: origin, at: clock(), ...value }));
  let phase = "contract_verification";
  try {
    await client.provider.withSignal(controller.signal, async () => {
      const verified = await client.verify();
      phase = "exact_transaction_finality";
      const finality = await observer.verifyCycle(saved.transaction.id, saved.operation);
      emit({ phase, epoch: oldEpoch, txId: saved.transaction.id, finality: publicProof(finality) });
      phase = "epoch_and_nonce";
      const [old, current, pool, nonce, mana] = await readGroup(client.provider, [
        () => client.read("rewards", "get_epoch", { epoch: oldEpoch }),
        () => client.read("rewards", "get_epoch", { epoch: today }), () => client.read("rewards", "balances"),
        () => client.provider.getNonce(saved.transaction.header.payee || saved.transaction.header.payer),
        () => client.provider.getAccountRc(saved.transaction.header.payer),
      ]);
      if (!Number.isSafeInteger(nonce) || nonce < 0 || !/^[0-9]+$/.test(String(mana))) throw Error("Invalid lifecycle resources response");
      const root = (await new Serializer(ABI.types).deserialize(saved.operation.args, "koin.Request")).root;
      const summaryRoot = { hash: Buffer.from(root.hash, "base64url").toString("hex"), availability: root.availability || "0", work: root.work || "0" };
      emit({ phase, epoch: oldEpoch, paused: verified.paused === true, oldEpoch: epochSummary(old.epoch, summaryRoot),
        today: { epoch: today, found: !!current.epoch, openedAt: current.epoch?.opened_at || null },
        poolAvailable: BigInt(pool.liquid || "0") > BigInt(pool.liabilities || "0"),
        savedNonce: saved.nonce, chainNonce: String(nonce), nonceIsNext: BigInt(nonce) + 1n === BigInt(saved.nonce),
        nonceConsumedOrPassed: BigInt(nonce) >= BigInt(saved.nonce), manaCoversSavedLimit: BigInt(mana) >= BigInt(saved.transaction.header.rc_limit) });
      for (let sample = 1; sample <= samples; sample++) {
        phase = "coherent_epoch_evidence";
        const evidence = await observer.inspectCycle({ epoch: oldEpoch,
          minimumHeight: ["finalized", "reverted"].includes(finality.state) ? finality.height : "0" });
        emit({ phase, epoch: oldEpoch, sample, state: evidence.state,
          ...(evidence.state === "verified" && { epochFinalized: evidence.epoch?.finalized === true }) });
        if (evidence.state === "verified" || sample === samples) break;
        await delay(sampleDelayMs, undefined, { signal: controller.signal });
      }
    });
  } catch (error) {
    // Arbitrary upstream text and saved payloads never enter diagnostic output.
    emit({ phase, ok: false, failure: controller.signal.aborted ? "probe_deadline" : "read_or_validation_failed", rpc: rpcDiagnostics(error) });
  } finally { clearTimeout(timer); controller.abort(); }
}
async function diagnose({ configFile = "/etc/kai-koin-prepaid/runtime.json", stateDir = "/var/lib/kai-koin-prepaid", log = console.log, ...options } = {}) {
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const saved = await validateSaved(readPending(path.join(stateDir, "cycle", "reward-cycle.sqlite")), config);
  const endpoints = config.deployment.rpc;
  if (!Array.isArray(endpoints) || !endpoints.length || endpoints.length > 3) throw Error("Bounded configured endpoints required");
  log(JSON.stringify({ probe: "saved lifecycle fence", epoch: saved.step.epoch, method: saved.step.method, state: saved.step.state,
    txId: saved.transaction.id, attempts: saved.step.outbox.attempts, updatedAt: saved.step.updatedAt,
    lastAttemptAt: saved.step.outbox.lastAttemptAt, createdAt: saved.step.outbox.createdAt }));
  await Promise.all(endpoints.map(endpoint => endpointProbe({ endpoint, config, saved, log, ...options })));
}
if (require.main === module) diagnose().catch(() => {
  console.error(JSON.stringify({ probe: "saved lifecycle fence", ok: false, failure: "configuration_or_saved_binding_invalid" })); process.exitCode = 1;
});
module.exports = { targetFor, readPending, validateSaved, endpointProbe, diagnose };
