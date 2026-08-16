"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Signer } = require("koilib");
const { PriceOracle, parseSources } = require("./oracle");

/*
 * Koinos AI scheduler — M2/M3 alpha, mounted into the koinosai.com website
 * (mirrored from therexdev/kaiapp server/scheduler.js — keep in sync).
 * (§12/§13/§16/§17/§46.5). Project-operated;
 * workers connect OUTBOUND only (register + long-poll + submit), never accept
 * inbound connections. Job types are profile-approved (§31): "inference-eval"
 * (protocol-funded) and "chat" (relayed consumer demand via /consume).
 * Receipts are signed by the worker's wallet key and verified here by address
 * recovery; a sampling rate of hidden known-answer challenges (§17) flags
 * dishonest providers. Epochs aggregate receipts into a Merkle root that
 * anchors on-chain (M2 step 5).
 *
 *   node server/scheduler.js          (PORT, KAI_OPERATOR_SECRET env)
 */

const LONG_POLL_MS = 20000;
const CHALLENGE_RATE = 0.2; // §17 sampling
// §14/§15/§23 alpha token economics — every number here is PROVISIONAL and
// env-overridable pending the §52 economic simulations. One chat request is
// one LLM-CU (flat placeholder formula); compute value is USD-denominated and
// KAI is the settlement asset via a reference price (fixed config now, oracle
// + smoothing later). Charge order per request: free allowance (§16 disclosed
// bootstrap subsidy) -> deposited KAI credits (§23) -> current-epoch earnings.
const CONSUME_SIG_WINDOW_MS = 120000;
// Four-layer economics (spec amendment A1, all rates PROVISIONAL / §52):
//   TOKENS  — AI usage is metered in input/output tokens, per model class,
//             exactly as OpenAI-compatible runtimes already report it.
//   CU      — internal provider-work normalization (flat per-token alpha).
//   USD     — per-1M-token rates make cost legible (µ$ integers internally).
//   KAI     — the settlement asset; USD value converts at the reference price.
// There is no per-chat credit unit. The prepaid balance is a plain USD
// billing abstraction funded by KAI deposits at the reference price.
const KAI_REF_USD = Number(process.env.KAI_REF_USD || 0.01); // §51 oracle ANCHOR (and sole price when no sources)
const RECEIPT_KAI_SAT = 100000000n; // provider reward rate (contract: 1 KAI/receipt)
const FREE_TOKENS_PER_EPOCH = Number(process.env.KAI_FREE_TOKENS || 25000); // §16 bootstrap subsidy
// §51 consumption-side Sybil limit: the free allowance is per ADDRESS and
// addresses are free to create, so one machine could farm wallets for
// unlimited free GPU time. A per-IP ceiling (default 3× the per-address
// allowance, so a shared household NAT isn't punished) bounds what one
// origin can draw per epoch regardless of wallet count. ≤0 disables.
const FREE_TOKENS_PER_IP = Number(process.env.KAI_FREE_TOKENS_PER_IP || 3 * 25000);

/** §28 royalty routes from KAI_MODEL_ROYALTIES, e.g.
 *  {"koinos-fast":{"bps":500,"addr":"1Creator..."}}. Malformed input is
 *  ignored entry-by-entry — a typo must not take the scheduler down. */
function parseRoyaltiesEnv() {
  const out = {};
  try {
    const raw = JSON.parse(process.env.KAI_MODEL_ROYALTIES || "{}");
    for (const [model, r] of Object.entries(raw)) {
      const bps = Math.floor(Number(r?.bps));
      if (Number.isFinite(bps) && bps > 0 && typeof r?.addr === "string" && r.addr.length > 0) {
        out[model] = { bps, addr: r.addr };
      }
    }
  } catch {
    /* unreadable JSON -> no routes */
  }
  return out;
}
// Model-class token rates in micro-dollars per 1M tokens (illustrative).
const MODEL_RATES = {
  // royaltyBps 0: protocol-funded Koinos-native model — providers still earn
  // for compute, no creator royalty (§28). Registered third-party models add
  // royaltyBps + royaltyAddr here (bounded by ROYALTY_MAX_BPS at split time).
  // ctxTokens: the class's context window, advertised via /pricing so §7
  // routers can tell whether an oversized local prompt would actually fit
  // on the network before spending money to find out.
  //
  // Multi-class serving: workers advertise which of these they hold and
  // dispatch is model-matched; a consumer names a class (or "auto") and is
  // billed at that class's rate. The ladder scales with model size —
  // bigger weights, more provider compute per token (PROVISIONAL pending
  // §52 per-class sims).
  "koinos-fast": { inMicroPerM: 100000, outMicroPerM: 400000, royaltyBps: 0, ctxTokens: 4096 }, // $0.10 / $0.40 per 1M
  "koinos-balanced": { inMicroPerM: 150000, outMicroPerM: 600000, royaltyBps: 0, ctxTokens: 4096 },
  "gemma3-4b": { inMicroPerM: 200000, outMicroPerM: 800000, royaltyBps: 0, ctxTokens: 4096 },
  "koinos-smart": { inMicroPerM: 250000, outMicroPerM: 1000000, royaltyBps: 0, ctxTokens: 4096 },
  "mistral-7b": { inMicroPerM: 250000, outMicroPerM: 1000000, royaltyBps: 0, ctxTokens: 4096 },
  "qwen-coder-7b": { inMicroPerM: 250000, outMicroPerM: 1000000, royaltyBps: 0, ctxTokens: 4096 },
  "llama31-8b": { inMicroPerM: 250000, outMicroPerM: 1000000, royaltyBps: 0, ctxTokens: 4096 },
  "gemma3-12b": { inMicroPerM: 400000, outMicroPerM: 1600000, royaltyBps: 0, ctxTokens: 4096 },
  "qwen25-14b": { inMicroPerM: 500000, outMicroPerM: 2000000, royaltyBps: 0, ctxTokens: 4096 },
  "phi-4": { inMicroPerM: 500000, outMicroPerM: 2000000, royaltyBps: 0, ctxTokens: 4096 },
  "mistral-small-24b": { inMicroPerM: 700000, outMicroPerM: 2800000, royaltyBps: 0, ctxTokens: 4096 },
  "gemma3-27b": { inMicroPerM: 800000, outMicroPerM: 3200000, royaltyBps: 0, ctxTokens: 4096 },
  "qwen25-32b": { inMicroPerM: 1000000, outMicroPerM: 4000000, royaltyBps: 0, ctxTokens: 4096 },
  "qwen-coder-32b": { inMicroPerM: 1000000, outMicroPerM: 4000000, royaltyBps: 0, ctxTokens: 4096 },
  "deepseek-r1-32b": { inMicroPerM: 1000000, outMicroPerM: 4000000, royaltyBps: 0, ctxTokens: 4096 },
};
const DEFAULT_MODEL_CLASS = "koinos-fast";
// §51 CU groundwork: provider capability = generation tok/s vs this baseline
// (a 1.0-CU provider). Ratings inform scheduling/§52 modeling — not rewards.
const CU_BASELINE_TPS = Number(process.env.KAI_CU_BASELINE_TPS || 20);
// §16/§54: the bootstrap subsidy is a CAPPED budget, not a permanent faucet.
// Eval receipts beyond this many per worker per epoch still count for honesty
// stats but mint nothing (econ-sim-01 finding: uncapped eval mint dominates
// provider income at every KAI price and scales with a runaway seed loop).
const EVAL_CAP_PER_EPOCH = Number(process.env.KAI_EVAL_CAP_PER_EPOCH || 8);
// §54 unified bootstrap budget (§51 F3 mitigation): ALL protocol-funded
// value one worker can mint per epoch — flat eval subsidies AND the unpaid
// free-allowance fraction of chat receipts. Without this, fresh addresses
// (free to create) could route free-tier chats to their own worker and
// mint indefinitely. Paid chat value is real revenue and is never capped.
// Default preserves the historical eval budget exactly (evalCap × 1 KAI).
const BOOTSTRAP_CAP_SAT = process.env.KAI_BOOTSTRAP_CAP_SAT ? BigInt(process.env.KAI_BOOTSTRAP_CAP_SAT) : null;
// §20 settlement splits (PROVISIONAL bps pending the §52 role/royalty sims):
// each chat receipt's minted value divides among settlement roles — compute
// provider, model-creator royalty (per-model, §28-bounded), verification
// pool, scheduler/protocol. The free-allowance fraction is included: the
// protocol pays it on the consumer's behalf, and one rule for every receipt
// keeps claims auditable. With KAI_TREASURY_ADDR unset the verification and
// protocol shares fold back into compute — bit-identical to the alpha full
// pass-through — so splits activate only when the operator opts in (the same
// safe-default posture as the §51 oracle's anchor mode). The verification
// share accrues to the treasury until independent verifiers exist (§17).
const SPLIT_VERIFY_BPS = Number(process.env.KAI_SPLIT_VERIFY_BPS || 300); // 3%
const SPLIT_PROTOCOL_BPS = Number(process.env.KAI_SPLIT_PROTOCOL_BPS || 700); // 7%
const ROYALTY_MAX_BPS = Number(process.env.KAI_ROYALTY_MAX_BPS || 1000); // §28 bound: creator royalty ≤10%
const TREASURY_ADDR = process.env.KAI_TREASURY_ADDR || null;

/** Cost of a request in micro-dollars from actual token usage. */
function usageCostMicro(usage, modelClass = DEFAULT_MODEL_CLASS) {
  const r = MODEL_RATES[modelClass] || MODEL_RATES[DEFAULT_MODEL_CLASS];
  const inTok = Math.max(0, Number(usage?.prompt_tokens ?? 0));
  const outTok = Math.max(0, Number(usage?.completion_tokens ?? 0));
  return Math.ceil((inTok * r.inMicroPerM + outTok * r.outMicroPerM) / 1e6);
}
// A dispatched job whose result never arrives goes back to the queue after
// this lease, so one dropped worker connection can't strand a consumer (§13).
const PENDING_LEASE_MS = 60000;

class Scheduler {
  constructor({ dataDir, operatorSecret, chain, settlement, epoch, leaseMs, priceSources, evalCapPerEpoch, bootstrapCapSat, freeTokensPerIp, royalties, splits, jobModel, onEvent } = {}) {
    this.chain = chain || null; // ChainClient — when set, epoch roots anchor on-chain (§20)
    this.settlement = settlement || null; // {settleEpoch, kaiBalance} — closed epochs settle to KAI (§20-§22)
    this._balanceCache = new Map(); // address -> {at, kai}
    this._dispatchSeq = 0; // distinguishes re-dispatches of the same job
    this.leaseMs = leaseMs ?? PENDING_LEASE_MS;
    this._consumers = new Map(); // consume jobId -> resolve(output) (§46.5 relay)
    this.dataDir = dataDir || path.join(process.cwd(), "scheduler-data");
    this.operatorSecret = operatorSecret || null;
    this.onEvent = onEvent || (() => {});
    this.workers = new Map(); // token -> {address, capabilities, lastSeen}
    // Split-brain detector: if the host ever runs two scheduler processes
    // (rolling deploys, scale>1), each has its own in-memory roster and
    // clients see different worlds by which instance they land on. The
    // boot id in /network/models makes that visible in two samples.
    this.instanceId = "i_" + crypto.randomBytes(4).toString("hex");
    this._streams = new Map(); // jobId -> SSE response of a streaming consumer
    // Roster survives restarts: every deploy was amputating the whole
    // network (in-memory tokens died, workers 401-churned, consumers saw
    // "no providers" — field finding). Tokens stay valid; staleness is
    // still governed by lastSeen exactly as before.
    this._workersPath = path.join(dataDir, "workers.json");
    try {
      for (const [token, w] of Object.entries(JSON.parse(fs.readFileSync(this._workersPath, "utf8")))) {
        // Same trust rule as registration: rosters persisted before the
        // catalog-class filter existed may carry private imports.
        w.models = (Array.isArray(w.models) ? w.models : []).filter((m) => MODEL_RATES[m]);
        this.workers.set(token, w);
      }
    } catch {
      /* first boot */
    }
    this.queue = []; // pending jobs
    this.pending = new Map(); // jobId -> job (dispatched, awaiting result)
    this.waiters = []; // long-poll resolvers
    this.receipts = []; // current epoch receipts
    this.consumed = {}; // address -> requests served for them this epoch
    this.usage = {}; // address -> { inTok, outTok, costMicro } this epoch
    this.freeUsed = {}; // address -> free-allowance tokens used this epoch
    this.spentSat = {}; // address -> KAI satoshis charged to epoch earnings
    // Prepaid USD balance ledger (billing abstraction, µ$ integers): funded
    // by on-chain KAI deposits at the reference price; persisted on disk.
    // depositHwmSat is the cumulative deposits_of high-water mark.
    this._creditsPath = path.join(this.dataDir, "credits.json");
    this.balances = {};
    try {
      this.balances = JSON.parse(fs.readFileSync(this._creditsPath, "utf8"));
    } catch {
      /* fresh ledger */
    }
    this._depositSync = new Map(); // address -> last sync ms (throttle)
    // Unix-minute epochs: unique + monotonic across restarts so on-chain
    // submit_root can never collide. Tests may pin an explicit epoch.
    this.epoch = epoch ?? Math.floor(Date.now() / 60000);
    // §51 reference price: an oracle (median -> EMA -> step/bound breakers)
    // whose state is PINNED per epoch — this.price only moves at epoch close,
    // so every µ$<->sat conversion inside one epoch uses one rate. With no
    // KAI_PRICE_SOURCES configured it anchors at KAI_REF_USD forever.
    this.oracle = new PriceOracle({
      anchorUsd: KAI_REF_USD,
      sources: priceSources ?? parseSources(process.env.KAI_PRICE_SOURCES),
      alpha: process.env.KAI_PRICE_ALPHA,
      maxStepPct: process.env.KAI_PRICE_MAX_STEP_PCT,
      floorUsd: process.env.KAI_PRICE_FLOOR_USD,
      ceilUsd: process.env.KAI_PRICE_CEIL_USD,
      statePath: path.join(this.dataDir, "oracle.json"),
    });
    this.price = this.oracle.snapshot(); // {usd, microPerKai, satPerMicro, status}
    this.perf = {}; // address -> {jobs, tokPerSec, cuRating} rolling capability (§51 CU)
    this.evalCap = evalCapPerEpoch ?? EVAL_CAP_PER_EPOCH; // §16 capped bootstrap budget
    // The model class consumer chat jobs run as (and bill as). Stays on the
    // launch class by default; KAI_JOB_MODEL pins something else.
    this.jobModel = jobModel ?? (process.env.KAI_JOB_MODEL || DEFAULT_MODEL_CLASS);
    // §54: one budget for all protocol-funded mint per worker per epoch.
    this.bootstrapCapSat =
      bootstrapCapSat != null ? BigInt(bootstrapCapSat) : (BOOTSTRAP_CAP_SAT ?? BigInt(this.evalCap) * RECEIPT_KAI_SAT);
    this.freeTokensPerIp = freeTokensPerIp ?? FREE_TOKENS_PER_IP; // §51 per-origin free ceiling
    this.freeUsedByIp = {}; // ip -> free tokens drawn this epoch (all addresses combined)
    // §32 kill switch: model packages (by pinned §27 sha256) the operator
    // has revoked. Served publicly at /policy; nodes quarantine matching
    // local packages and stop serving them. Persisted — a compromised
    // package must stay dead across scheduler restarts.
    this._revokedPath = path.join(this.dataDir, "revoked.json");
    this.revoked = {};
    try {
      this.revoked = JSON.parse(fs.readFileSync(this._revokedPath, "utf8"));
    } catch {
      /* nothing revoked yet */
    }
    try {
      // Seed/merge from env: JSON [{sha256, reason}] or bare sha256 strings.
      for (const e of JSON.parse(process.env.KAI_REVOKED_PACKAGES || "[]")) {
        const sha = String(e?.sha256 ?? e).toLowerCase();
        if (/^[0-9a-f]{64}$/.test(sha) && !this.revoked[sha]) {
          this.revoked[sha] = { reason: String(e?.reason || "revoked by operator"), at: new Date().toISOString() };
        }
      }
    } catch {
      /* unreadable env -> ignore */
    }
    // §28: operator-registered royalty routes, {modelClass: {bps, addr}}.
    // Overrides MODEL_RATES defaults; clamped to royaltyMaxBps at split
    // time like any other royalty. Registered here (env/config) until a
    // self-serve creator registry exists.
    this.royalties = royalties ?? parseRoyaltiesEnv();
    // §20 split policy: role shares of each chat receipt's minted value.
    // Royalty bps come per-model from MODEL_RATES (clamped to royaltyMaxBps);
    // verification + protocol shares accrue to the treasury address.
    this.splits = {
      verifyBps: Math.max(0, splits?.verifyBps ?? SPLIT_VERIFY_BPS),
      protocolBps: Math.max(0, splits?.protocolBps ?? SPLIT_PROTOCOL_BPS),
      royaltyMaxBps: Math.max(0, splits?.royaltyMaxBps ?? ROYALTY_MAX_BPS),
      treasury: splits?.treasury ?? TREASURY_ADDR,
    };
    if (this.splits.verifyBps + this.splits.protocolBps + this.splits.royaltyMaxBps > 10000) {
      throw new Error("§20 split config invalid: verify + protocol + max royalty bps exceed 100%");
    }
    this.server = null;
  }

  /** Poll price sources once (no-op on an anchor oracle). The refreshed
   *  state is picked up by the NEXT epoch close — never mid-epoch. */
  async refreshPrice() {
    const s = await this.oracle.refresh();
    if (this.oracle.sources.length) this.onEvent({ type: "scheduler:price", ...this.oracle.describe() });
    return s;
  }

  enqueue(job) {
    const id = "job_" + crypto.randomBytes(8).toString("hex");
    const full = {
      id,
      type: job.type || "inference-eval",
      model: job.model || "dev-tiny",
      // Billing/settlement class — for chat jobs the served model IS the
      // class (multi-class serving); evals settle as the default class.
      modelClass: job.modelClass || (MODEL_RATES[job.model] ? job.model : undefined),
      prompt: String(job.prompt || ""),
      messages: Array.isArray(job.messages) ? job.messages : null,
      // Hidden challenge (§17): expected output known only to the scheduler.
      challenge: job.expected ? { expected: job.expected } : null,
      createdAt: new Date().toISOString(),
    };
    this.queue.push(full);
    this._wakeWaiter();
    return full;
  }

  /** Wake one parked long-poll. Entries are pruned on timeout/close, so
   *  whatever is in the list is a live, waiting request. */
  _wakeWaiter() {
    // Wake EVERY parked poll: with model-matched dispatch, the first waiter
    // may not be able to serve the new job — each woken poll re-checks and
    // either takes a matching job or parks again on its next request.
    const all = this.waiters.splice(0);
    for (const w of all) w.fire();
  }

  /** Can this worker serve this job? Workers advertise the models they hold
   *  (§27 aliases). A legacy worker that advertised nothing predates the
   *  launch catalog and holds only the dev pipeline model. */
  _canServe(w, job) {
    return w.models && w.models.length > 0 ? w.models.includes(job.model) : job.model === "dev-tiny";
  }

  _servableIndex(w) {
    return this.queue.findIndex((j) => this._canServe(w, j));
  }

  _saveBalances() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this._creditsPath, JSON.stringify(this.balances, null, 2));
    } catch {
      /* best-effort */
    }
  }

  /** Prepaid balance in µ$, migrating any older ledger denomination once. */
  _balanceMicroOf(address) {
    const entry = this.balances[address];
    if (!entry) return 0n;
    if (entry.creditSat != null) {
      // v0.5.0 ledgers stored KAI satoshis.
      entry.balanceMicro = ((BigInt(entry.creditSat) * this.price.microPerKai) / 100000000n).toString();
      delete entry.creditSat;
      this._saveBalances();
    } else if (entry.credits != null) {
      // v0.5.1 ledgers stored $0.001 credits.
      entry.balanceMicro = String(Number(entry.credits) * 1000);
      delete entry.credits;
      this._saveBalances();
    }
    return BigInt(entry.balanceMicro || 0);
  }

  /** Pull new on-chain KAI deposits into the prepaid USD balance (throttled),
   *  converting at the reference price AT DEPOSIT TIME. */
  async _syncDeposits(address, force = false) {
    if (!this.settlement?.depositsOf) return;
    const last = this._depositSync.get(address) || 0;
    if (!force && Date.now() - last < 30000) return;
    this._depositSync.set(address, Date.now());
    try {
      const total = BigInt(await this.settlement.depositsOf(address));
      this._balanceMicroOf(address); // run migrations before touching hwm
      const entry = this.balances[address] || { balanceMicro: "0", depositHwmSat: "0" };
      const hwm = BigInt(entry.depositHwmSat);
      if (total > hwm) {
        const newMicro = ((total - hwm) * this.price.microPerKai) / 100000000n;
        entry.balanceMicro = (BigInt(entry.balanceMicro || 0) + newMicro).toString();
        entry.depositHwmSat = total.toString();
        this.balances[address] = entry;
        this._saveBalances();
        this.onEvent({ type: "scheduler:balance-funded", address, balanceMicro: entry.balanceMicro });
      }
    } catch {
      /* chain read down — balances stay as persisted */
    }
  }

  /** Can this address run one more request at all? (authorization gate —
   *  exact cost is only known after execution, from actual token usage.) */
  _consumeCapacity(address, ip) {
    let freeTokensLeft = Math.max(0, FREE_TOKENS_PER_EPOCH - (this.freeUsed[address] || 0));
    if (ip && this.freeTokensPerIp > 0) {
      // §51: the per-origin ceiling binds across every address behind it.
      freeTokensLeft = Math.min(freeTokensLeft, Math.max(0, this.freeTokensPerIp - (this.freeUsedByIp[ip] || 0)));
    }
    const balanceMicro = this._balanceMicroOf(address);
    const earnedSat = this._settleFor(this.receipts.filter((r) => r.honest && r.worker === address)).workerSat;
    const earningsLeftSat = earnedSat - BigInt(this.spentSat[address] || "0");
    return { freeTokensLeft, balanceMicro, earningsLeftSat };
  }

  /** Bill ACTUAL usage after completion: free tokens first, then the prepaid
   *  USD balance, then current-epoch earnings valued at the reference price. */
  _chargeUsage(address, usage, ip, modelClass = DEFAULT_MODEL_CLASS) {
    const inTok = Math.max(0, Number(usage?.prompt_tokens ?? 0));
    const outTok = Math.max(0, Number(usage?.completion_tokens ?? 0));
    const totalTok = inTok + outTok;
    this.consumed[address] = (this.consumed[address] || 0) + 1;
    const u = (this.usage[address] ||= { inTok: 0, outTok: 0, costMicro: 0 });
    u.inTok += inTok;
    u.outTok += outTok;

    let freeLeft = Math.max(0, FREE_TOKENS_PER_EPOCH - (this.freeUsed[address] || 0));
    if (ip && this.freeTokensPerIp > 0) {
      freeLeft = Math.min(freeLeft, Math.max(0, this.freeTokensPerIp - (this.freeUsedByIp[ip] || 0)));
    }
    const freeTaken = Math.min(freeLeft, totalTok);
    this.freeUsed[address] = (this.freeUsed[address] || 0) + freeTaken;
    if (ip && this.freeTokensPerIp > 0 && freeTaken > 0) {
      this.freeUsedByIp[ip] = (this.freeUsedByIp[ip] || 0) + freeTaken;
    }
    const billableFraction = totalTok > 0 ? (totalTok - freeTaken) / totalTok : 0;
    const costMicro = BigInt(Math.ceil(usageCostMicro(usage, modelClass) * billableFraction));
    u.costMicro += Number(costMicro);
    if (costMicro <= 0n) return { paidWith: "free", costMicro: 0n, freeTaken, totalTok };

    const balance = this._balanceMicroOf(address);
    const fromBalance = balance < costMicro ? balance : costMicro;
    if (fromBalance > 0n) {
      this.balances[address].balanceMicro = (balance - fromBalance).toString();
      this._saveBalances();
    }
    const remainderMicro = costMicro - fromBalance;
    if (remainderMicro > 0n) {
      this.spentSat[address] = (BigInt(this.spentSat[address] || "0") + remainderMicro * this.price.satPerMicro).toString();
    }
    return { paidWith: fromBalance > 0n ? (remainderMicro > 0n ? "balance+earnings" : "balance") : "earnings", costMicro, freeTaken, totalTok };
  }

  _persistWorkers() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this._workersPath, JSON.stringify(Object.fromEntries(this.workers)));
    } catch {
      /* best-effort */
    }
  }

  /** Live network shape: connected computers and the classes they serve.
   *  detail:true adds per-worker rows (admin); false is the public shape. */
  statsPublic({ detail = false } = {}) {
    const now = Date.now();
    const busy = new Set(
      [...this.pending.values()].filter((p) => now - p.dispatchedAt < (p.leaseMs || PENDING_LEASE_MS)).map((p) => p.worker)
    );
    const live = [...this.workers.values()].filter((x) => now - x.lastSeen < 90000 || busy.has(x.address));
    const models = {};
    for (const w of live) {
      for (const m of w.models || []) {
        if (MODEL_RATES[m]) models[m] = (models[m] || 0) + 1;
      }
    }
    const out = {
      instance: this.instanceId,
      bootAt: this._bootAt || (this._bootAt = new Date().toISOString()),
      workersOnline: live.length,
      models: Object.entries(models)
        .sort((a, z) => (MODEL_RATES[z[0]]?.outMicroPerM || 0) - (MODEL_RATES[a[0]]?.outMicroPerM || 0))
        .map(([model, providers]) => ({ model, providers })),
      // Drop-timeline diagnosis (field): nodes seen within the hour but
      // NOT live right now, with how long ago their last contact was —
      // an abrupt age jump pinpoints the moment a node's polls stopped.
      recentOffline: [...this.workers.values()]
        .filter((x) => now - x.lastSeen >= 90000 && now - x.lastSeen < 3600000 && !busy.has(x.address))
        .map((x) => ({ addr: `${x.address.slice(0, 6)}…`, lastSeenSecs: Math.round((now - x.lastSeen) / 1000), models: (x.models || []).length })),
    };
    if (detail) {
      out.workers = live.map((w) => ({
        address: w.address,
        models: (w.models || []).filter((m) => MODEL_RATES[m]),
        lastSeenSecs: Math.round((now - w.lastSeen) / 1000),
        busy: busy.has(w.address),
        perf: this.perf[w.address] || null,
        jobsThisEpoch: this.receipts.filter((r) => r.worker === w.address).length,
      }));
      out.queueDepth = this.queue.length;
      out.pendingJobs = this.pending.size;
    }
    return out;
  }

  /** Requeue dispatched jobs whose worker went silent past the lease.
   *  Per-job leases: chat on big classes legitimately runs minutes. */
  _reapPending() {
    const now = Date.now();
    for (const [id, job] of this.pending) {
      if (now - (job.dispatchedAt ?? now) < (job.leaseMs || this.leaseMs)) continue;
      this.pending.delete(id);
      const { worker, dispatchedAt, dispatchId, leaseMs, ...fresh } = job;
      this.queue.unshift(fresh);
      this._wakeWaiter();
      this.onEvent({ type: "scheduler:job-requeued", jobId: id });
    }
  }

  _json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(data);
  }

  async _body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return {};
    }
  }

  _auth(req) {
    // Return the LIVE roster entry, never a copy. Handlers write
    // `w.lastSeen = Date.now()` to prove the worker is alive — against a
    // spread copy those writes vanish, so every worker aged off the roster
    // exactly 90s after registering no matter how many polls, heartbeats,
    // and jobs it produced (field finding: the entire presence saga's
    // deepest layer — both machines "offline" while actively serving).
    const token = new URL(req.url, "http://x").searchParams.get("token");
    const w = token ? this.workers.get(token) : null;
    if (!w) return null;
    w.token = token; // dispatch logging references it
    return w;
  }

  /** Real client origin behind the website's proxy chain. x-forwarded-for
   *  entries are client-supplied EXCEPT the last one, which the fronting
   *  proxy appended — trusting the first entry would let a caller choose
   *  its own IP bucket with a header. */
  _clientIp(req) {
    const xff = String(req.headers["x-forwarded-for"] || "");
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
    return req.socket?.remoteAddress || "unknown";
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    this._reapPending();

    if (url.pathname === "/worker/register" && req.method === "POST") {
      const b = await this._body(req);
      if (!b.address) return this._json(res, 400, { ok: false, error: "address required" });
      const token = "wt_" + crypto.randomBytes(16).toString("hex");
      this.workers.set(token, {
        address: b.address,
        capabilities: b.capabilities || {},
        // Models this machine can serve NOW (on disk, ready). Dispatch only
        // hands a worker jobs it advertised — a job for a missing model
        // would trigger a mid-lease gigabyte download and time out.
        // Only PRICED catalog classes ride the network: a worker's private
        // imports (custom GGUFs, dev builds) are weights nobody vetted or
        // priced — advertising them would put them in every consumer's
        // picker and bill them at fallback rates. They stay local.
        models: Array.isArray(b.models) ? b.models.map(String).filter((m) => MODEL_RATES[m]) : [],
        lastSeen: Date.now(),
      });
      // One live token per address: re-registration replaces, so the
      // persisted roster can't grow without bound.
      for (const [t, w] of this.workers) {
        if (t !== token && w.address === b.address) this.workers.delete(t);
      }
      this._persistWorkers();
      this.onEvent({ type: "scheduler:worker-registered", address: b.address });
      return this._json(res, 200, { ok: true, token, epoch: this.epoch });
    }

    // Live progress: workers post generation deltas as they produce them,
    // and a streaming consumer sees words appear — the network stops
    // feeling like "wait forever, then a block of text" (field finding).
    // Chunks also refresh liveness, like heartbeats.
    if (url.pathname === "/worker/chunk" && req.method === "POST") {
      const w = this._auth(req);
      if (!w) return this._json(res, 401, { ok: false, error: "bad token" });
      const b = await this._body(req);
      const job = this.pending.get(b.jobId);
      if (!job || job.worker !== w.address) return this._json(res, 404, { ok: false, error: "unknown job" });
      w.lastSeen = Date.now();
      const s = this._streams.get(b.jobId);
      if (s && !s.destroyed) {
        s.write(`data: ${JSON.stringify({ delta: String(b.delta ?? "") })}\n\n`);
      }
      return this._json(res, 200, { ok: true });
    }

    // What the network can serve RIGHT NOW — public, consumed by the app's
    // network model picker (and eventually the website).
    if (url.pathname === "/network/models" && req.method === "GET") {
      return this._json(res, 200, { ok: true, ...this.statsPublic({ detail: false }) });
    }

    // Long executions poll nothing — the heartbeat keeps a busy worker
    // visibly alive (field finding: the network's one provider "vanished"
    // whenever it was mid-answer, and consumers saw "no providers").
    if (url.pathname === "/worker/heartbeat" && req.method === "POST") {
      const w = this._auth(req);
      if (!w) return this._json(res, 401, { ok: false, error: "bad token" });
      w.lastSeen = Date.now();
      return this._json(res, 200, { ok: true });
    }

    if (url.pathname === "/worker/next-job" && req.method === "GET") {
      const w = this._auth(req);
      if (!w) return this._json(res, 401, { ok: false, error: "bad token" });
      w.lastSeen = Date.now();
      const give = () => {
        // A dead socket must never consume a job: the client that would
        // receive it is gone, and the job would strand in pending until the
        // lease reaper found it. Leave it queued and pass the wake-up on.
        if (res.destroyed || res.writableEnded) return this._wakeWaiter();
        const idx = this._servableIndex(w);
        if (idx < 0) return this._wakeWaiter();
        const job = this.queue.splice(idx, 1)[0];
        const dispatchId = ++this._dispatchSeq;
        // Chat leases scale with the class: a 12B answer legitimately takes
        // minutes, and a 60s lease was requeuing jobs mid-generation.
        const leaseMs = job.type === "chat" ? 300000 : PENDING_LEASE_MS;
        this.pending.set(job.id, { ...job, worker: w.address, dispatchedAt: Date.now(), dispatchId, leaseMs });
        this.onEvent({ type: "scheduler:job-dispatched", jobId: job.id, worker: w.address, token: w.token.slice(-6) });
        // The challenge's expected answer never leaves the scheduler.
        const { challenge, ...visible } = job;
        // TCP only reveals a dead peer on write: a poll whose client aborted
        // milliseconds ago still looks writable here. If this response can't
        // actually flush, put the job straight back for the next live poll —
        // the lease is the backstop, not the primary recovery.
        const returnJob = () => {
          const cur = this.pending.get(job.id);
          if (!cur || cur.dispatchId !== dispatchId) return; // completed or re-dispatched
          this.pending.delete(job.id);
          this.queue.unshift(job);
          this.onEvent({ type: "scheduler:job-returned", jobId: job.id });
          this._wakeWaiter();
        };
        res.once("error", returnJob);
        res.once("close", () => {
          if (!res.writableFinished) returnJob();
        });
        this._json(res, 200, { ok: true, job: visible });
      };
      if (this._servableIndex(w) >= 0) return give();
      // Long-poll: park until work arrives, the poll times out, or the client
      // hangs up. The entry is pruned on every exit path so enqueue() can only
      // ever wake a live, still-waiting request.
      await new Promise((resolve) => {
        const entry = { fire: null };
        const leave = () => {
          const i = this.waiters.indexOf(entry);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve();
        };
        const t = setTimeout(leave, LONG_POLL_MS);
        entry.fire = () => {
          clearTimeout(t);
          resolve();
        };
        this.waiters.push(entry);
        res.once("close", () => {
          clearTimeout(t);
          leave();
        });
      });
      if (this._servableIndex(w) >= 0) return give();
      if (!res.destroyed && !res.writableEnded) return this._json(res, 204, { ok: true, job: null });
      return;
    }

    if (url.pathname === "/worker/result" && req.method === "POST") {
      const w = this._auth(req);
      if (!w) return this._json(res, 401, { ok: false, error: "bad token" });
      const b = await this._body(req);
      const job = this.pending.get(b.jobId);
      if (!job) return this._json(res, 404, { ok: false, error: "unknown job" });

      // §17: the receipt is a signature over sha256(jobId | output).
      const hash = crypto.createHash("sha256").update(`${b.jobId}|${b.output ?? ""}`).digest();
      let signer;
      try {
        signer = Signer.recoverAddress(hash, Buffer.from(String(b.signature), "base64"));
      } catch {
        return this._json(res, 400, { ok: false, error: "bad signature" });
      }
      if (signer !== w.address) {
        return this._json(res, 400, { ok: false, error: "signature does not match registered address" });
      }

      const honest = !job.challenge || this._passesChallenge(job.challenge, b.output);
      this.pending.delete(b.jobId);
      const usage = {
        prompt_tokens: Math.max(0, Math.min(2e6, Number(b.usage?.prompt_tokens ?? 0))),
        completion_tokens: Math.max(0, Math.min(2e6, Number(b.usage?.completion_tokens ?? 0))),
      };
      // §51 CU groundwork: provider-reported timing (same trust level as
      // usage — challenge-audited later) feeds a rolling capability rating.
      const perf = {
        ms: Math.max(0, Math.min(1e7, Number(b.perf?.ms ?? 0))),
        tokPerSec: Math.max(0, Math.min(1e5, Number(b.perf?.tokPerSec ?? 0))),
      };
      if (honest && perf.tokPerSec > 0) {
        const p = (this.perf[w.address] ||= { jobs: 0, tokPerSec: 0, cuRating: 0 });
        p.jobs += 1;
        p.tokPerSec = p.jobs === 1 ? perf.tokPerSec : +(0.3 * perf.tokPerSec + 0.7 * p.tokPerSec).toFixed(2);
        p.cuRating = +(p.tokPerSec / CU_BASELINE_TPS).toFixed(3);
      }
      const receipt = {
        jobId: b.jobId,
        worker: w.address,
        jobType: job.type, // "chat" earns work value; "inference-eval" earns the bootstrap subsidy
        modelClass: job.modelClass || DEFAULT_MODEL_CLASS, // billing class — §20 split + §28 royalty lookups
        outputHash: hash.toString("hex"),
        signature: b.signature,
        usage, // provider-reported token counts (audited by challenges later)
        ...(perf.tokPerSec > 0 ? { perf } : {}),
        challenged: !!job.challenge,
        honest,
        at: new Date().toISOString(),
      };
      this.receipts.push(receipt);
      this._persist();
      const waiter = this._consumers.get(b.jobId);
      if (waiter) {
        this._consumers.delete(b.jobId);
        waiter({ output: String(b.output ?? ""), usage });
      }
      this.onEvent({ type: honest ? "scheduler:receipt" : "scheduler:challenge-failed", worker: w.address });
      return this._json(res, 200, { ok: true, accepted: honest });
    }

    // §46.5 network consume: relay an OpenAI-shaped chat request to a
    // provider (V1 §13: traffic proxies through project infrastructure).
    // The provider earns a verified receipt for serving it (§16 real demand).
    // §23: the request is signed by the consumer's wallet and metered — a
    // free allowance per epoch, then each request spends one served receipt.
    if (url.pathname === "/consume/chat/completions" && req.method === "POST") {
      const b = await this._body(req);
      if (!Array.isArray(b.messages) || b.messages.length === 0) {
        return this._json(res, 400, { error: { message: "messages required", type: "invalid_request_error" } });
      }
      if (!b.address || !b.signature || !b.ts) {
        return this._json(res, 401, {
          error: { message: "Koinos Network requests are signed by your earning account — update the app and unlock your wallet", type: "invalid_request_error" },
        });
      }
      if (Math.abs(Date.now() - Number(b.ts)) > CONSUME_SIG_WINDOW_MS) {
        return this._json(res, 401, { error: { message: "stale request signature — check this machine's clock", type: "invalid_request_error" } });
      }
      const consumeHash = crypto
        .createHash("sha256")
        .update(`consume|${b.address}|${b.ts}|${JSON.stringify(b.messages)}`)
        .digest();
      let consumeSigner;
      try {
        consumeSigner = Signer.recoverAddress(consumeHash, Buffer.from(String(b.signature), "base64"));
      } catch {
        return this._json(res, 401, { error: { message: "bad request signature", type: "invalid_request_error" } });
      }
      if (consumeSigner !== b.address) {
        return this._json(res, 401, { error: { message: "request signature does not match the sending account", type: "invalid_request_error" } });
      }
      // §20: payment authorization BEFORE execution. Free allowance, then
      // deposited KAI credits, then current-epoch earnings must cover the CU.
      await this._syncDeposits(b.address);
      const clientIp = this._clientIp(req);
      const cap = this._consumeCapacity(b.address, clientIp);
      if (cap.freeTokensLeft <= 0 && cap.balanceMicro <= 0n && cap.earningsLeftSat <= 0n) {
        return this._json(res, 402, {
          error: {
            message:
              "Insufficient balance: network usage is billed per AI token after the free allowance. " +
              "Add funds with KAI in the Earn tab, or Start Earning to cover usage with work.",
            type: "insufficient_quota",
          },
        });
      }
      // Model-matched serving: the consumer names a class, or "auto" for
      // the best class any live provider holds. Billing follows the class.
      const requested = typeof b.model === "string" && b.model ? b.model : this.jobModel;
      if (requested !== "auto" && !MODEL_RATES[requested]) {
        return this._json(res, 400, {
          error: { message: `Unknown network model class "${requested}" — see /pricing for the served classes`, type: "invalid_request_error" },
        });
      }
      // Fail fast when nobody can serve this class: a queued job with no
      // matching live provider would hang the consumer 90s on an empty
      // bubble and then time out anyway. Honest and immediate beats that.
      // A worker mid-job counts as live — it isn't polling, it's WORKING
      // (and heartbeating since v0.24.1 clients).
      const busy = new Set(
        [...this.pending.values()]
          .filter((p) => Date.now() - p.dispatchedAt < (p.leaseMs || PENDING_LEASE_MS))
          .map((p) => p.worker)
      );
      const live = [...this.workers.values()].filter((x) => Date.now() - x.lastSeen < 90000 || busy.has(x.address));
      let model = requested;
      if (requested === "auto") {
        // Quality-first: the priciest (largest) rated class a live worker
        // advertises; legacy workers with no advertisement hold dev-tiny
        // and never win auto.
        model =
          Object.entries(MODEL_RATES)
            .sort((a, z) => z[1].outMicroPerM - a[1].outMicroPerM)
            .map(([name]) => name)
            .find((name) => live.some((x) => this._canServe(x, { model: name }))) || null;
        if (!model) {
          return this._json(res, 503, {
            error: {
              message:
                "No providers are online right now — try again shortly, " +
                "or press Start Earning in the app to serve the network yourself.",
              type: "server_error",
            },
          });
        }
      } else if (!live.some((x) => this._canServe(x, { model }))) {
        return this._json(res, 503, {
          error: {
            message:
              `No providers are serving "${model}" right now — try again shortly, ` +
              "or press Start Earning in the app to serve the network yourself.",
            type: "server_error",
          },
        });
      }
      const job = this.enqueue({ type: "chat", cu: 1, messages: b.messages, model });
      // Streaming consumers get an SSE channel that worker chunks flow
      // into as they're generated; billing still happens on the final
      // result exactly like the buffered path.
      const wantStream = !!b.stream;
      if (wantStream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ accepted: true, model })}\n\n`);
        this._streams.set(job.id, res);
      }
      const result = await new Promise((resolve) => {
        this._consumers.set(job.id, resolve);
        const t = setTimeout(() => {
          this._consumers.delete(job.id);
          resolve(null);
        }, 180000); // big classes stream for minutes; chunks keep it live
        t.unref?.();
      });
      this._streams.delete(job.id);
      if (result === null) {
        if (wantStream) {
          res.write(`data: ${JSON.stringify({ error: "no provider answered in time" })}\n\ndata: [DONE]\n\n`);
          return res.end();
        }
        return this._json(res, 504, { error: { message: "no provider answered in time", type: "server_error" } });
      }
      // Bill ACTUAL token usage after completion, at the served class's
      // rate — a timeout costs nothing.
      const { paidWith, costMicro, freeTaken, totalTok } = this._chargeUsage(b.address, result.usage, clientIp, model);
      // §54: stamp the receipt with how much of it the free allowance
      // absorbed — the unpaid fraction draws on the worker's bootstrap
      // budget at settlement. A receipt that never gets stamped (consumer
      // timed out unbilled) counts as fully subsidized, conservatively.
      for (let i = this.receipts.length - 1; i >= 0; i--) {
        if (this.receipts[i].jobId === job.id) {
          this.receipts[i].freeTok = freeTaken;
          this.receipts[i].totalTok = totalTok;
          break;
        }
      }
      this.onEvent({ type: "scheduler:consumed", address: b.address, paidWith, costMicro: Number(costMicro) });
      if (wantStream) {
        // Final frame carries what the buffered reply would have: the
        // remaining text (in case chunks lagged), usage, and the class.
        res.write(
          `data: ${JSON.stringify({
            done: true,
            output: result.output,
            servedModel: model,
            usage: { prompt_tokens: result.usage.prompt_tokens, completion_tokens: result.usage.completion_tokens },
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return this._json(res, 200, {
        object: "chat.completion",
        model: "koinos-network",
        servedModel: model, // §29: which class actually answered
        // OpenAI-compatible usage block: developers keep their mental model.
        usage: {
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
          total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
        },
        choices: [{ index: 0, message: { role: "assistant", content: result.output }, finish_reason: "stop" }],
      });
    }

    // §32: public revocation list — nodes poll this and quarantine any
    // local package whose pinned sha256 appears here. No auth: the list
    // must reach every node, fast, including ones that never earned.
    if (url.pathname === "/policy" && req.method === "GET") {
      return this._json(res, 200, {
        ok: true,
        revoked: Object.entries(this.revoked).map(([sha256, r]) => ({ sha256, ...r })),
      });
    }

    if (url.pathname === "/operator/revoke" && req.method === "POST") {
      if (this.operatorSecret && req.headers["x-operator-secret"] !== this.operatorSecret) {
        return this._json(res, 401, { ok: false, error: "operator secret required" });
      }
      const b = await this._body(req);
      const sha = String(b.sha256 || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha)) {
        return this._json(res, 400, { ok: false, error: "sha256 (64 hex chars) required" });
      }
      this.revoked[sha] = { reason: String(b.reason || "revoked by operator"), at: new Date().toISOString() };
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this._revokedPath, JSON.stringify(this.revoked, null, 2));
      this.onEvent({ type: "scheduler:package-revoked", sha256: sha });
      return this._json(res, 200, { ok: true, revoked: Object.keys(this.revoked).length });
    }

    if (url.pathname === "/operator/unrevoke" && req.method === "POST") {
      if (this.operatorSecret && req.headers["x-operator-secret"] !== this.operatorSecret) {
        return this._json(res, 401, { ok: false, error: "operator secret required" });
      }
      const b = await this._body(req);
      delete this.revoked[String(b.sha256 || "").toLowerCase()];
      fs.writeFileSync(this._revokedPath, JSON.stringify(this.revoked, null, 2));
      return this._json(res, 200, { ok: true, revoked: Object.keys(this.revoked).length });
    }

    if (url.pathname === "/operator/enqueue" && req.method === "POST") {
      if (this.operatorSecret && req.headers["x-operator-secret"] !== this.operatorSecret) {
        return this._json(res, 401, { ok: false, error: "operator secret required" });
      }
      const b = await this._body(req);
      return this._json(res, 200, { ok: true, job: { id: this.enqueue(b).id } });
    }

    if (url.pathname === "/epoch/close" && req.method === "POST") {
      if (this.operatorSecret && req.headers["x-operator-secret"] !== this.operatorSecret) {
        return this._json(res, 401, { ok: false, error: "operator secret required" });
      }
      const summary = this.closeEpoch();
      if (this.chain) {
        try {
          summary.anchor = await this.chain.anchorRoot(summary.epoch, summary.root);
        } catch (e) {
          summary.anchorError = String(e.message);
        }
      }
      await this.settleClosedEpoch(summary);
      return this._json(res, 200, { ok: true, ...summary });
    }

    if (url.pathname === "/operator/epochs" && req.method === "GET") {
      if (this.operatorSecret && req.headers["x-operator-secret"] !== this.operatorSecret) {
        return this._json(res, 401, { ok: false, error: "operator secret required" });
      }
      const out = [];
      try {
        for (const f of fs.readdirSync(this.dataDir)) {
          if (!f.startsWith("epoch-")) continue;
          const j = JSON.parse(fs.readFileSync(path.join(this.dataDir, f), "utf8"));
          if (j.summary) out.push(j.summary);
        }
      } catch { /* no data yet */ }
      return this._json(res, 200, { ok: true, epochs: out });
    }

    if (url.pathname === "/epoch/current" && req.method === "GET") {
      const totals = {};
      for (const r of this.receipts) if (r.honest) totals[r.worker] = (totals[r.worker] || 0) + 1;
      return this._json(res, 200, { ok: true, epoch: this.epoch, receipts: this.receipts.length, totals });
    }

    // §15: published pricing — what one network request settles for in KAI.
    // Values are PROVISIONAL config pending the §52 simulations and the
    // reference-price oracle; the endpoint shape is the stable part.
    if (url.pathname === "/pricing" && req.method === "GET") {
      const models = {};
      for (const [name, r] of Object.entries(MODEL_RATES)) {
        const reg = this.royalties[name];
        models[name] = {
          usdPerMInputTokens: r.inMicroPerM / 1e6,
          usdPerMOutputTokens: r.outMicroPerM / 1e6,
          cuClass: "LLM-CU",
          ctxTokens: r.ctxTokens || 4096, // §7: what fits on this class
          // §28: effective creator royalty share (clamped at settlement).
          royaltyBps: Math.min(Math.max(0, reg ? reg.bps : r.royaltyBps || 0), this.splits.royaltyMaxBps),
        };
      }
      return this._json(res, 200, {
        ok: true,
        // Four layers: tokens meter usage, CU normalizes provider work,
        // USD makes it legible, KAI settles it (spec amendment A1).
        models,
        kaiRefUsd: this.price.usd, // the price THIS epoch settles at
        oracle: this.oracle.describe(), // §51 mechanism state (may run ahead of the pin)
        splits: {
          // §20 role shares of paid chat value (basis points). Inactive
          // (no treasury configured) means full compute pass-through.
          verifyBps: this.splits.verifyBps,
          protocolBps: this.splits.protocolBps,
          royaltyMaxBps: this.splits.royaltyMaxBps,
          active: !!this.splits.treasury,
        },
        cuBaselineTokPerSec: CU_BASELINE_TPS,
        freeTokensPerEpoch: FREE_TOKENS_PER_EPOCH,
        providerKaiPerReceipt: Number(RECEIPT_KAI_SAT) / 1e8,
        status: "PROVISIONAL",
      });
    }

    // §21/§23 sponsored deposit lane: the app fetches an unsigned deposit tx
    // (operator pays MANA), signs it with the wallet, and submits it back.
    if (url.pathname === "/deposit/prepare" && req.method === "POST") {
      if (!this.settlement?.prepareDeposit) {
        return this._json(res, 200, { ok: false, error: "deposits not available on this scheduler" });
      }
      const b = await this._body(req);
      const sat = BigInt(Math.round(Number(b.amountKai || 0) * 1e8));
      if (!b.address || sat <= 0n) return this._json(res, 400, { ok: false, error: "address and positive amountKai required" });
      try {
        const transaction = await this.settlement.prepareDeposit(b.address, sat.toString());
        return this._json(res, 200, { ok: true, transaction });
      } catch (e) {
        return this._json(res, 502, { ok: false, error: String(e.message).slice(0, 160) });
      }
    }
    if (url.pathname === "/deposit/submit" && req.method === "POST") {
      if (!this.settlement?.submitDeposit) {
        return this._json(res, 200, { ok: false, error: "deposits not available on this scheduler" });
      }
      const b = await this._body(req);
      if (!b.address || !b.transaction) return this._json(res, 400, { ok: false, error: "address and transaction required" });
      try {
        // submitDeposit refuses anything but a single in-range deposit from
        // the claimed address — the operator never blind-co-signs (§44).
        const r = await this.settlement.submitDeposit(b.transaction, b.address);
        this.onEvent({ type: "scheduler:deposit-submitted", address: b.address, value: r.value });
        setTimeout(() => this._syncDeposits(b.address, true), 8000).unref?.();
        return this._json(res, 200, { ok: true, txId: r.txId, value: r.value });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message).slice(0, 160) });
      }
    }

    // On-chain KAI balance for a worker, plus their receipts still waiting in
    // the open epoch — the app's Earn tab reads this. Cached to spare the RPC.
    if (url.pathname === "/balance" && req.method === "GET") {
      if (!this.settlement) {
        return this._json(res, 200, { ok: false, error: "settlement not configured" });
      }
      const address = url.searchParams.get("address") || "";
      if (!address) return this._json(res, 400, { ok: false, error: "address required" });
      await this._syncDeposits(address);
      const mine = this.receipts.filter((r) => r.honest && r.worker === address);
      const pendingReceipts = mine.length;
      const tokensProcessed = mine.reduce(
        (n, r) => n + (r.usage?.prompt_tokens || 0) + (r.usage?.completion_tokens || 0), 0);
      let pendingSat = this._settleFor(mine).workerSat - BigInt(this.spentSat[address] || "0");
      if (pendingSat < 0n) pendingSat = 0n;
      const u = this.usage[address] || { inTok: 0, outTok: 0, costMicro: 0 };
      const meter = {
        pendingReceipts,
        tokensProcessed,
        pendingKai: (Number(pendingSat) / 1e8).toFixed(8),
        requestsThisEpoch: this.consumed[address] || 0,
        usage: { inputTokens: u.inTok, outputTokens: u.outTok, costUsd: (u.costMicro / 1e6).toFixed(6) },
        freeTokensRemaining: Math.max(0, FREE_TOKENS_PER_EPOCH - (this.freeUsed[address] || 0)),
        balanceUsd: (Number(this._balanceMicroOf(address)) / 1e6).toFixed(6),
        kaiRefUsd: this.price.usd,
        spentThisEpochKai: (Number(this.spentSat[address] ?? 0) / 1e8).toString(),
        provider: this.perf[address] || null, // §51 CU rating (null until perf reports arrive)
        epoch: this.epoch,
      };
      const hit = this._balanceCache.get(address);
      if (hit && Date.now() - hit.at < 20000) {
        return this._json(res, 200, { ok: true, address, kai: hit.kai, ...meter });
      }
      try {
        const raw = await this.settlement.kaiBalance(address);
        const kai = (Number(raw) / 1e8).toString();
        this._balanceCache.set(address, { at: Date.now(), kai });
        return this._json(res, 200, { ok: true, address, kai, ...meter });
      } catch (e) {
        return this._json(res, 502, { ok: false, error: `chain read failed: ${String(e.message).slice(0, 120)}` });
      }
    }

    // Operator retry lane: settle (or re-settle) a stored epoch — idempotent.
    if (url.pathname === "/operator/settle" && req.method === "POST") {
      if (this.operatorSecret && req.headers["x-operator-secret"] !== this.operatorSecret) {
        return this._json(res, 401, { ok: false, error: "operator secret required" });
      }
      const b = await this._body(req);
      let stored;
      try {
        stored = JSON.parse(fs.readFileSync(path.join(this.dataDir, `epoch-${b.epoch}.json`), "utf8"));
      } catch {
        return this._json(res, 404, { ok: false, error: `no stored epoch ${b.epoch}` });
      }
      if (!stored.summary) return this._json(res, 400, { ok: false, error: "epoch not closed" });
      const result = await this.settleClosedEpoch(stored.summary);
      return this._json(res, 200, { ok: true, epoch: stored.summary.epoch, settlement: result });
    }

    return this._json(res, 404, { ok: false, error: "not found" });
  }

  _passesChallenge(challenge, output) {
    // Alpha check: expected substring must appear (deterministic evals use
    // temperature 0; exact-match graduates with real eval jobs).
    return String(output ?? "").includes(challenge.expected);
  }

  /** §20: divide ONE chat receipt's minted value (satoshis) among the
   *  settlement roles. Integer bps shares with compute taking the exact
   *  remainder, so the buckets always sum to the value — no satoshi ever
   *  rounds away. A share with no destination (royalty without a per-model
   *  address, verification/protocol without a treasury) folds back into
   *  compute, which is how the alpha pass-through remains the default. */
  _splitValueSat(valueSat, modelClass) {
    const s = { valueSat, computeSat: valueSat, royaltySat: 0n, verifySat: 0n, protocolSat: 0n, royaltyAddr: null };
    // Unknown classes bill at the default class's rates, so they take the
    // default class's royalty route too — the two must never disagree.
    const cls = MODEL_RATES[modelClass] ? modelClass : DEFAULT_MODEL_CLASS;
    const rates = MODEL_RATES[cls];
    // §28: operator-registered route wins over the model's baked-in one.
    const reg = this.royalties[cls];
    const royaltyBps = Math.min(Math.max(0, reg ? reg.bps : rates.royaltyBps || 0), this.splits.royaltyMaxBps);
    const royaltyAddr = reg ? reg.addr : rates.royaltyAddr;
    if (royaltyBps > 0 && royaltyAddr) {
      s.royaltySat = (valueSat * BigInt(royaltyBps)) / 10000n;
      s.royaltyAddr = royaltyAddr;
    }
    if (this.splits.treasury) {
      s.verifySat = (valueSat * BigInt(this.splits.verifyBps)) / 10000n;
      s.protocolSat = (valueSat * BigInt(this.splits.protocolBps)) / 10000n;
    }
    s.computeSat = valueSat - s.royaltySat - s.verifySat - s.protocolSat;
    return s;
  }

  /** How many satoshis of a chat receipt the protocol subsidized: the
   *  free-allowance share stamped at billing time. An unstamped chat
   *  receipt was never billed to anyone — fully subsidized. */
  _chatSubsidySat(receipt, valueSat) {
    const totalTok =
      Number(receipt.totalTok ?? (Number(receipt.usage?.prompt_tokens ?? 0) + Number(receipt.usage?.completion_tokens ?? 0)));
    if (totalTok <= 0) return valueSat;
    const freeTok = receipt.freeTok == null ? totalTok : Math.min(Number(receipt.freeTok), totalTok);
    return (valueSat * BigInt(freeTok)) / BigInt(totalTok);
  }

  /**
   * Settle ONE worker's honest receipts under the §54 bootstrap budget.
   * Paid chat value always mints; protocol-funded value (eval subsidies +
   * the free-allowance fraction of chat receipts, in receipt order) mints
   * only until the per-epoch budget runs out. Splits (§20) divide what was
   * actually minted — capped-away value produces no treasury or royalty
   * share either, because it never existed. Used by /balance and
   * closeEpoch alike so pending display and settled claims never disagree.
   */
  _settleFor(receipts) {
    const out = {
      workerSat: 0n,
      royaltyByAddr: {},
      treasurySat: 0n,
      splitTotals: { computeSat: 0n, royaltySat: 0n, verifySat: 0n, protocolSat: 0n },
      subsidyMintedSat: 0n,
      subsidyCappedSat: 0n,
    };
    let budget = this.bootstrapCapSat;
    for (const r of receipts) {
      if (r.jobType !== "chat") {
        // Eval subsidy: all-or-nothing flat mint from the budget.
        if (budget >= RECEIPT_KAI_SAT) {
          budget -= RECEIPT_KAI_SAT;
          out.workerSat += RECEIPT_KAI_SAT;
          out.subsidyMintedSat += RECEIPT_KAI_SAT;
        } else {
          out.subsidyCappedSat += RECEIPT_KAI_SAT;
        }
        continue;
      }
      const valueSat = BigInt(usageCostMicro(r.usage, r.modelClass)) * this.price.satPerMicro;
      const subsidySat = this._chatSubsidySat(r, valueSat);
      const paidSat = valueSat - subsidySat;
      const allowedSat = subsidySat <= budget ? subsidySat : budget;
      budget -= allowedSat;
      out.subsidyMintedSat += allowedSat;
      out.subsidyCappedSat += subsidySat - allowedSat;
      const s = this._splitValueSat(paidSat + allowedSat, r.modelClass);
      out.workerSat += s.computeSat;
      out.splitTotals.computeSat += s.computeSat;
      out.splitTotals.royaltySat += s.royaltySat;
      out.splitTotals.verifySat += s.verifySat;
      out.splitTotals.protocolSat += s.protocolSat;
      if (s.royaltySat > 0n) out.royaltyByAddr[s.royaltyAddr] = (out.royaltyByAddr[s.royaltyAddr] || 0n) + s.royaltySat;
      out.treasurySat += s.verifySat + s.protocolSat;
    }
    return out;
  }

  /** Epoch close (§15/§20 + A1): rewards and consumer spend are both KAI
   *  satoshi amounts now, so netting is exact — no rounding to receipts.
   *  Leaves commit sha256("epoch|worker|amountSat"); the contract's
   *  claim_value mints exactly the committed net amount. Deposits were
   *  already debited at request time and never touch claims. */
  closeEpoch() {
    const served = {};
    const byWorker = {};
    for (const r of this.receipts) {
      if (!r.honest) continue;
      served[r.worker] = (served[r.worker] || 0) + 1;
      (byWorker[r.worker] ||= []).push(r);
    }
    // One settlement walk per worker under the §54 bootstrap budget. §20:
    // the non-compute shares accrue to their role addresses and settle as
    // ordinary claims in the SAME epoch tree — claim_value mints a
    // treasury or royalty leaf exactly like a worker leaf, so the split
    // needs no contract change and inherits the Merkle audit trail.
    const earnedSat = {};
    const splitTotals = { computeSat: 0n, royaltySat: 0n, verifySat: 0n, protocolSat: 0n };
    const bootstrap = { mintedSat: 0n, cappedSat: 0n };
    for (const [w, rs] of Object.entries(byWorker)) {
      const st = this._settleFor(rs);
      earnedSat[w] = st.workerSat;
      splitTotals.computeSat += st.splitTotals.computeSat;
      splitTotals.royaltySat += st.splitTotals.royaltySat;
      splitTotals.verifySat += st.splitTotals.verifySat;
      splitTotals.protocolSat += st.splitTotals.protocolSat;
      bootstrap.mintedSat += st.subsidyMintedSat;
      bootstrap.cappedSat += st.subsidyCappedSat;
      for (const [addr, sat] of Object.entries(st.royaltyByAddr)) earnedSat[addr] = (earnedSat[addr] || 0n) + sat;
      if (st.treasurySat > 0n) earnedSat[this.splits.treasury] = (earnedSat[this.splits.treasury] || 0n) + st.treasurySat;
    }

    const net = { ...earnedSat };
    const debts = {};
    for (const [address, spent] of Object.entries(this.spentSat)) {
      const s = BigInt(spent);
      if (s <= 0n) continue;
      const have = net[address] || 0n;
      if (s >= have) {
        if (s > have) debts[address] = (s - have).toString();
        delete net[address];
      } else {
        net[address] = have - s;
      }
    }

    const entries = Object.entries(net)
      .filter(([, amt]) => amt > 0n)
      .sort(([a], [b]) => a.localeCompare(b));
    const mkLeaves = entries.map(([worker, amt]) =>
      crypto.createHash("sha256").update(`${this.epoch}|${worker}|${amt.toString()}`).digest()
    );
    const claims = {};
    entries.forEach(([worker, amt], index) => {
      claims[worker] = { amount: amt.toString(), index, proof: merkleProof(mkLeaves, index).map((b) => b.toString("hex")) };
    });
    const root = merkleRoot(mkLeaves).toString("hex");
    const totalsSat = Object.fromEntries(entries.map(([w, amt]) => [w, amt.toString()]));
    const summary = {
      epoch: this.epoch,
      root,
      totals: totalsSat, // net KAI satoshis per worker — what settles on-chain
      earnedKai: Object.fromEntries(Object.entries(earnedSat).map(([a, s]) => [a, (Number(s) / 1e8).toString()])),
      served,
      requests: { ...this.consumed },
      usage: JSON.parse(JSON.stringify(this.usage)),
      spentKai: Object.fromEntries(Object.entries(this.spentSat).map(([a, s]) => [a, (Number(s) / 1e8).toString()])),
      pricing: {
        // Rates as this epoch settled them, §28 registry routes applied.
        models: Object.fromEntries(
          Object.entries(MODEL_RATES).map(([m, r]) => {
            const reg = this.royalties[m];
            return [m, reg ? { ...r, royaltyBps: reg.bps, royaltyAddr: reg.addr } : r];
          })
        ),
        kaiRefUsd: this.price.usd, // the ONE price this epoch's satoshis were converted at
        oracle: { status: this.price.status, updatedAt: this.price.updatedAt },
        freeTokensPerEpoch: FREE_TOKENS_PER_EPOCH,
      },
      perf: JSON.parse(JSON.stringify(this.perf)), // §51 CU capability snapshot (rolling, not reset)
      bootstrap: {
        // §54: protocol-funded mint this epoch (eval subsidies + the
        // free-allowance fraction of chat value) vs what the per-worker
        // budget refused. cappedSat > 0 means someone hit the ceiling.
        capPerWorkerSat: this.bootstrapCapSat.toString(),
        mintedSat: bootstrap.mintedSat.toString(),
        cappedSat: bootstrap.cappedSat.toString(),
      },
      splits: {
        // §20 policy + how this epoch's paid chat value actually divided.
        // compute+royalty+verification+protocol always equals the epoch's
        // total chat value exactly (compute takes every rounding remainder).
        verifyBps: this.splits.verifyBps,
        protocolBps: this.splits.protocolBps,
        royaltyMaxBps: this.splits.royaltyMaxBps,
        treasury: this.splits.treasury,
        active: !!this.splits.treasury,
        totals: {
          compute: splitTotals.computeSat.toString(),
          royalty: splitTotals.royaltySat.toString(),
          verification: splitTotals.verifySat.toString(),
          protocol: splitTotals.protocolSat.toString(),
        },
      },
      debts,
      claims,
      receipts: this.receipts.length,
    };
    this._persist(summary);
    this.epoch = Math.max(this.epoch + 1, Math.floor(Date.now() / 60000));
    this.receipts = [];
    this.consumed = {};
    this.usage = {};
    this.freeUsed = {};
    this.freeUsedByIp = {};
    this.spentSat = {};
    // §51 epoch pricing: pin the NEXT epoch to the oracle's current state,
    // then poll sources in the background for the close after that. Prices
    // therefore move only on epoch boundaries, one smoothed step at a time.
    this.price = this.oracle.snapshot();
    this.refreshPrice().catch(() => {});
    this.onEvent({ type: "scheduler:epoch-closed", ...summary });
    return summary;
  }

  _persist(summary) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.dataDir, `epoch-${this.epoch}.json`),
        JSON.stringify({ epoch: this.epoch, receipts: this.receipts, summary: summary ?? null }, null, 2)
      );
    } catch {
      /* persistence is best-effort in alpha */
    }
  }

  /** §20–§22: push a closed epoch on-chain (root + every worker's claim).
   *  The result — tx ids or the error — lands in the epoch file so
   *  /operator/epochs shows settlement state. Safe to re-run. */
  async settleClosedEpoch(summary) {
    if (!this.settlement || !summary || !summary.receipts) return null;
    let result;
    try {
      result = await this.settlement.settleEpoch(summary);
      this.onEvent({ type: "scheduler:epoch-settled", epoch: summary.epoch, rootTx: result.rootTx });
    } catch (e) {
      result = { error: String(e.message).slice(0, 200), settledAt: new Date().toISOString() };
      this.onEvent({ type: "scheduler:settle-failed", epoch: summary.epoch, message: result.error });
    }
    summary.settlement = result;
    try {
      const file = path.join(this.dataDir, `epoch-${summary.epoch}.json`);
      let j = {};
      try {
        j = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        /* fresh file */
      }
      j.epoch = summary.epoch;
      j.summary = summary;
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
    } catch {
      /* best-effort */
    }
    return result;
  }

  listen(port = 0, host = "127.0.0.1") {
    this.server = http.createServer((req, res) =>
      this.handle(req, res).catch((e) => {
        try {
          this._json(res, 500, { ok: false, error: String(e.message) });
        } catch {
          /* response already gone */
        }
      })
    );
    this.refreshPrice().catch(() => {}); // warm the oracle before the first close
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve(this.server.address().port));
    });
  }

  close() {
    for (const w of this.waiters.splice(0)) w.fire();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(resolve);
    });
  }
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return crypto.createHash("sha256").update("empty").digest();
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a; // odd leaf pairs with itself
      next.push(crypto.createHash("sha256").update(Buffer.concat([a, b])).digest());
    }
    level = next;
  }
  return level[0];
}

/** Sibling path for leaf `index`; odd nodes pair with themselves (matches merkleRoot). */
function merkleProof(leaves, index) {
  const proof = [];
  let level = leaves;
  let idx = index;
  while (level.length > 1) {
    const sib = level[idx ^ 1] ?? level[idx];
    proof.push(sib);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a;
      next.push(crypto.createHash("sha256").update(Buffer.concat([a, b])).digest());
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Protocol-funded eval jobs (§16): the scheduler feeds itself so connected
 *  workers always have work; some carry hidden known-answer challenges. */
const SEED_PROMPTS = [
  { prompt: "What is 2+2? Reply with just the number." },
  { prompt: "Name the capital of France in one word." },
  { prompt: "Write one short sentence about local AI." },
  { prompt: "What is 2+2? Reply with just the number.", expected: "4" },
  { prompt: "Name the capital of France in one word.", expected: "Paris" },
];

function startAutoOps(sched, { seedMs = 45000, epochMs = 15 * 60 * 1000 } = {}) {
  const seed = setInterval(() => {
    const active = [...sched.workers.values()].filter((w) => Date.now() - w.lastSeen < 90000);
    if (active.length === 0) return;
    if (sched.queue.length + sched.pending.size >= 3) return;
    // Pin each eval to a model some active worker actually holds — an
    // unservable seed would sit in the queue forever under model-matched
    // dispatch. Legacy workers (no advertisement) hold the dev model.
    const target = active.find((w) => Array.isArray(w.models) && w.models.length > 0);
    sched.enqueue({
      ...SEED_PROMPTS[Math.floor(Math.random() * SEED_PROMPTS.length)],
      model: target ? target.models[0] : "dev-tiny",
    });
  }, seedMs);
  const close = setInterval(() => {
    if (sched.receipts.length === 0) return;
    const summary = sched.closeEpoch();
    // Fire-and-record: settlement result lands in the epoch file either way.
    sched.settleClosedEpoch(summary).catch(() => {});
  }, epochMs);
  seed.unref?.();
  close.unref?.();
  return { seed, close };
}

module.exports = { Scheduler, merkleRoot, merkleProof, startAutoOps, MODEL_RATES };

if (require.main === module) {
  const s = new Scheduler({
    operatorSecret: process.env.KAI_OPERATOR_SECRET,
    onEvent: (e) => console.log(`[scheduler] ${e.type}`, e.worker ?? e.root ?? ""),
  });
  s.listen(Number(process.env.PORT || 41200), process.env.HOST || "127.0.0.1").then((p) =>
    console.log(`[scheduler] listening on ${p}`)
  );
}
