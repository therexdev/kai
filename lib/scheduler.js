"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Signer } = require("koilib");
const { PriceOracle, parseSources } = require("./oracle");
const { openStore } = require("./durable-store");

// Public routes take anonymous bodies; this is the ceiling on how much of
// this process's memory a stranger may claim in one request.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Constant-time secret comparison. Digest first so unequal lengths neither
 *  throw nor leak their difference through timing. */
function secretsMatch(given, expected) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(String(expected || "")).digest();
  return crypto.timingSafeEqual(a, b);
}

/*
 * Koinos AI scheduler — M2/M3 alpha, mounted into the koinosai.com website.
 * THIS FILE IS CANONICAL. It began as a copy of therexdev/kaiapp
 * server/scheduler.js, but the sync ended long ago: roster persistence,
 * multi-class dispatch, fair seeding, streaming, perf-fed routing and more
 * live only here. Scheduler changes land HERE, with a probe script under
 * scripts/; the kaiapp copy is retired to a worker-test fixture (decision
 * 2026-08-21) and must not receive ports of this file.
 * (§12/§13/§16/§17/§46.5). Project-operated;
 * workers connect OUTBOUND only (register + long-poll + submit), never accept
 * inbound connections. Job types are profile-approved (§31): "inference-eval"
 * (protocol-funded) and "chat" (relayed consumer demand via /consume).
 * Receipts are signed by the worker's wallet key and verified here by address
 * recovery; a sampling rate of hidden known-answer challenges (§17) flags
 * dishonest providers. Epochs aggregate receipts into a Merkle root that
 * anchors on-chain (M2 step 5).
 */

const LONG_POLL_MS = 20000;
// How long after its last contact a provider still counts as serving.
// A worker mid-job isn't polling, so the busy set covers it separately.
const LIVE_WINDOW_MS = 90000;
// Hard ceiling on the public payout roster, so the response stays a
// small predictable JSON body no matter how large the network grows.
const ROSTER_MAX = 5000;
// §17 sampling: fraction of eval seeds that carry a hidden known-answer
// challenge. Matches the historical share (2 of the 5 fixed prompts were
// challenges); env-tunable now that challenges are generated.
const CHALLENGE_RATE = Number(process.env.KAI_CHALLENGE_RATE || 0.4);
// No job survives past this, chunks or not: activity extends a lease (a
// slow machine mid-generation is working, not dead), but an absolute cap
// means chunk spam can't hold a job hostage forever.
const JOB_ABS_CAP_MS = Number(process.env.KAI_JOB_ABS_CAP_MS || 15 * 60000);
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
const RECEIPT_KAI_SAT = 100000000n; // nominal per-eval useful-work value (1 KAI)
// Settlement epochs are 15 minutes; consumption limits (the free tier) are
// stated PER DAY and tracked by UTC calendar day. Two different words on
// purpose: "epoch" = a 15-min settlement window; "day" = a 24h consumption
// window. EPOCHS_PER_DAY converts the owner's per-day bootstrap budget to
// the per-epoch pool that settlement actually spends from.
const EPOCHS_PER_DAY = 96;
// §16/§51 free tier — DAILY (was silently per-15-min-epoch, i.e. 96× looser
// than the economics assumed; owner-flagged and corrected). Per eligible
// account per day, plus a network-wide daily ceiling so a wallet-farm can't
// turn "free" into unlimited protocol-funded inference. When the global
// ceiling is exhausted, only PUBLIC-NETWORK free inference pauses for the
// day — local AI and paid KAI usage are unaffected.
const FREE_TOKENS_PER_DAY = Number(process.env.KAI_FREE_TOKENS_PER_DAY || 25000);
const FREE_TOKENS_PER_DAY_GLOBAL = Number(process.env.KAI_FREE_TOKENS_PER_DAY_GLOBAL || 40 * 25000); // ~1M/day
// Per-origin daily ceiling (defense in depth behind the global cap): default
// 3× the per-account allowance, so a shared household NAT isn't punished. ≤0
// disables.
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
  // minRamGb 3, not 4 (Pi field finding 2026-08-19): a 4GB Pi reports only
  // ~3.4-3.8GB usable after the GPU/kernel reserve, and the client rounds to
  // whole GB — the old 4GB floor filtered koinos-fast off the exact machine
  // it exists for. The ~1GB Q4 weights + 4k ctx serve comfortably inside 3GB.
  "koinos-fast": { minRamGb: 3, inMicroPerM: 100000, outMicroPerM: 400000, royaltyBps: 0, ctxTokens: 4096 }, // $0.10 / $0.40 per 1M
  "koinos-balanced": { minRamGb: 8, inMicroPerM: 150000, outMicroPerM: 600000, royaltyBps: 0, ctxTokens: 4096 },
  "gemma3-4b": { minRamGb: 8, inMicroPerM: 200000, outMicroPerM: 800000, royaltyBps: 0, ctxTokens: 4096 },
  "koinos-smart": { minRamGb: 12, inMicroPerM: 250000, outMicroPerM: 1000000, royaltyBps: 0, ctxTokens: 4096 },
  "mistral-7b": { minRamGb: 12, inMicroPerM: 250000, outMicroPerM: 1000000, royaltyBps: 0, ctxTokens: 4096 },
  "qwen-coder-7b": { minRamGb: 12, inMicroPerM: 250000, outMicroPerM: 1000000, royaltyBps: 0, ctxTokens: 4096 },
  "llama31-8b": { minRamGb: 12, inMicroPerM: 250000, outMicroPerM: 1000000, royaltyBps: 0, ctxTokens: 4096 },
  "gemma3-12b": { minRamGb: 16, inMicroPerM: 400000, outMicroPerM: 1600000, royaltyBps: 0, ctxTokens: 4096 },
  "qwen25-14b": { minRamGb: 24, inMicroPerM: 500000, outMicroPerM: 2000000, royaltyBps: 0, ctxTokens: 4096 },
  "phi-4": { minRamGb: 24, inMicroPerM: 500000, outMicroPerM: 2000000, royaltyBps: 0, ctxTokens: 4096 },
  "mistral-small-24b": { minRamGb: 24, inMicroPerM: 700000, outMicroPerM: 2800000, royaltyBps: 0, ctxTokens: 4096 },
  "gemma3-27b": { minRamGb: 24, inMicroPerM: 800000, outMicroPerM: 3200000, royaltyBps: 0, ctxTokens: 4096 },
  "qwen25-32b": { minRamGb: 32, inMicroPerM: 1000000, outMicroPerM: 4000000, royaltyBps: 0, ctxTokens: 4096 },
  "qwen-coder-32b": { minRamGb: 32, inMicroPerM: 1000000, outMicroPerM: 4000000, royaltyBps: 0, ctxTokens: 4096 },
  "deepseek-r1-32b": { minRamGb: 32, inMicroPerM: 1000000, outMicroPerM: 4000000, royaltyBps: 0, ctxTokens: 4096 },
};
const DEFAULT_MODEL_CLASS = "koinos-fast";
// Ceiling on max_tokens for a granted (session-authorized) request. Above any
// sane chat completion, and it bounds how much ONE request can reserve.
const GRANT_MAX_TOKENS_CEIL = Number(process.env.KAI_GRANT_MAX_TOKENS || 4096);
// §51 CU groundwork: provider capability = generation tok/s vs this baseline
// (a 1.0-CU provider). Ratings inform scheduling/§52 modeling — not rewards.
const CU_BASELINE_TPS = Number(process.env.KAI_CU_BASELINE_TPS || 20);
// Ceiling on ONE server-measured tok/s sample used for routing. Above any
// real single-machine decode rate (a 4090 does ~95 tok/s on small models),
// so honest providers never touch it; it stops a garbage-dumping faker from
// posting an absurd rate to capture the dispatch preference.
const SRV_TPS_CAP = Number(process.env.KAI_SRV_TPS_CAP || 400);
// §51 phase 2 (perf-fed routing): how long a chat job is reserved for the
// best-rated capable worker before any capable worker may take it. The
// window exists so a preferred worker that vanished at exactly the wrong
// moment can only cost the consumer this many ms, never a hang.
const PREFER_WINDOW_MS = Number(process.env.KAI_PREFER_WINDOW_MS || 4000);
// §16/§54 BOOTSTRAP POOL (owner decision 2026-08-16): protocol-funded work
// is paid from ONE capped network-wide budget per epoch — NOT a per-machine
// mint. This is spending from an allocated bootstrap/useful-work reserve;
// unused budget is NOT emitted just because it exists (it stays in reserve).
// The pool is divided across the epoch's VERIFIED USEFUL WORK — eval/
// verification receipts and the free-allowance fraction of chat receipts —
// pro-rata when demand exceeds the pool, in full (with the remainder left in
// reserve) when it does not. Paid chat value is real revenue and is NEVER
// capped. Passive uptime produces no receipts and therefore earns nothing.
// Because the cap is network-wide, spinning up N machines does not raise
// total protocol expense — it only dilutes each machine's share, so Sybil
// farming is pointless. Initial budget: 1,500 KAI/day (governance-adjustable).
const BOOTSTRAP_KAI_PER_DAY = Number(process.env.KAI_BOOTSTRAP_KAI_PER_DAY || 1500);
const BOOTSTRAP_POOL_SAT = process.env.KAI_BOOTSTRAP_POOL_SAT
  ? BigInt(process.env.KAI_BOOTSTRAP_POOL_SAT)
  : BigInt(Math.round((BOOTSTRAP_KAI_PER_DAY / EPOCHS_PER_DAY) * 1e8)); // per 15-min epoch
// §20 settlement splits (PROVISIONAL bps pending the §52 role/royalty sims):
// each chat receipt's PAID value divides among settlement roles — compute
// provider, model-creator royalty (per-model, §28-bounded), verification
// pool, scheduler/protocol. The free-allowance fraction is protocol EMISSION
// that funds providers (owner decision 2026-08-19, after probe-splits found
// the earlier minted-value rule cut 10% of pure emission while paid demand
// was zero): it passes through to compute whole and is never split. With
// KAI_TREASURY_ADDR unset the verification and protocol shares fold back
// into compute — bit-identical to the alpha full pass-through — so splits
// activate only when the operator opts in (the same safe-default posture as
// the §51 oracle's anchor mode). The verification share accrues to the
// treasury until independent verifiers exist (§17).
const SPLIT_VERIFY_BPS = Number(process.env.KAI_SPLIT_VERIFY_BPS || 300); // 3%
const SPLIT_PROTOCOL_BPS = Number(process.env.KAI_SPLIT_PROTOCOL_BPS || 700); // 7%
const ROYALTY_MAX_BPS = Number(process.env.KAI_ROYALTY_MAX_BPS || 1000); // §28 bound: creator royalty ≤10%
const TREASURY_ADDR = process.env.KAI_TREASURY_ADDR || null;

// §7.4 ANTI-SYBIL reputation (Task #20) — PHASE 1 is SHADOW / measurement only.
// r ∈ [REP_MIN, 1] is computed from signals the scheduler already earns (network
// age, reliability, §17 challenge-pass history, real paid demand served) and is
// SURFACED for field calibration. It does NOT influence settlement yet:
// _settleFor and the bootstrap-pool split are untouched. The design
// (docs/anti-sybil-reputation-weighting.md) is a reputation ELIGIBILITY GATE on
// the SUBSIDY pool only — paid revenue is never gated, equal work earns equal
// pay. Arming it is a later step behind KAI_REPUTATION_ENFORCE, once shadow data
// shows honest nodes clear the gate. Weights favor the Sybil-HARD signals (age,
// paid-demand); reliability and challenge-pass — which any real-model machine
// maxes instantly, honest or attacker — carry little. Every input is NaN-guarded.
const REP_MIN = numOr(process.env.KAI_REP_MIN, 0.05);
const REP_W_AGE = numOr(process.env.KAI_REP_W_AGE, 0.45);
const REP_W_PAID = numOr(process.env.KAI_REP_W_PAID, 0.35);
const REP_W_RELY = numOr(process.env.KAI_REP_W_RELY, 0.1);
const REP_W_CHAL = numOr(process.env.KAI_REP_W_CHAL, 0.1);
const REP_AGE_TAU_DAYS = numOr(process.env.KAI_REP_AGE_TAU_DAYS, 10);
const REP_PAID_K = numOr(process.env.KAI_REP_PAID_K, 40);
const REP_GATE = numOr(process.env.KAI_REP_GATE, 0.45); // gate the pool WOULD use (shadow: reported, not applied)
const REP_GAMMA = numOr(process.env.KAI_REP_GAMMA, 2); // superlinear ramp above the gate

/** Finite-number coercion. Number({}) / Number("abc") are NaN, and a NaN
 *  that reaches BigInt() throws — a single malformed field from a worker
 *  must never be able to poison a receipt or crash epoch settlement. */
function numOr(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.floor(numOr(v, lo))));
}
/** Coerce to [0,1]; non-finite -> 0. Used by the reputation sub-scores. */
function clamp01(v) {
  const n = Number(v);
  return !Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n;
}

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
// One-time lease grace while a worker loads a NON-resident model (A40 field
// finding: a cold 32B swap runs ~166s against a 60s eval lease — honest
// hardware ate timeout strikes with zero failed challenges). Granted once
// per dispatch on the worker's own announcement, never renewable, and the
// absolute job cap still rules — a machine that never warms still ages into
// an honest timeout. Env-tunable for probes.
const WARM_GRACE_MS = Number(process.env.KAI_WARM_GRACE_MS || 240000);

/**
 * Keep only finite, in-range numbers from a client's producer report.
 *
 * Bounds are deliberately generous — this is a sanity filter against garbage
 * and unbounded strings, not an attempt to judge what a plausible node looks
 * like. Anything that fails simply becomes null and renders as unknown.
 */
function sanitizeProducer(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const n = (v, max) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 && x <= max ? x : null;
  };
  const producingVhp = n(p.producingVhp, 1e12);
  const networkVhp = n(p.networkVhp, 1e15);
  if (producingVhp == null && networkVhp == null) return null;
  const str = (v) => (typeof v === "string" && v.length <= 40 ? v : null);
  return {
    producingVhp,
    networkVhp,
    sharePct: n(p.sharePct, 100),
    oneInBlocks: n(p.oneInBlocks, 1e15),
    blocksPerDay: n(p.blocksPerDay, 1e6),
    hoursPerBlock: n(p.hoursPerBlock, 1e6),
    at: str(p.at),
    // Holdings and their dollar value, so the dashboard can show what the
    // desktop Node screen shows. Satoshi counts arrive as strings (they are
    // BigInt-scale) and stay strings; only the derived dollars are numbers.
    koinSats: str(p.koinSats) ?? (Number.isFinite(Number(p.koinSats)) ? String(p.koinSats) : null),
    vhpSats: str(p.vhpSats) ?? (Number.isFinite(Number(p.vhpSats)) ? String(p.vhpSats) : null),
    usdPerKoin: n(p.usdPerKoin, 1e6),
    priceStale: p.priceStale === true ? true : p.priceStale === false ? false : null,
    nodeValueUsd: n(p.nodeValueUsd, 1e12),
    // Earnings estimates, exactly as the desktop computed them. `basis` is the
    // honesty flag: "no-history" means the node has not produced long enough
    // to have a rate, and the page must say so rather than print $0.00.
    dailyUsd: n(p.dailyUsd, 1e9),
    weeklyUsd: n(p.weeklyUsd, 1e9),
    yearlyUsd: n(p.yearlyUsd, 1e9),
    daysTracked: n(p.daysTracked, 1e5),
    basis: p.basis === "measured" || p.basis === "no-history" ? p.basis : null,
    /*
     * The node's own verdict on whether it is producing with everything the
     * wallet holds. A machine can be entered in the block lottery with a
     * fraction of its stake while every individual number on the page is
     * correct — only the comparison finds it, and only the machine can make
     * it, so the answer travels rather than being recomputed here.
     */
    stakeBehind: p.stakeBehind === true,
    stakeShortfallPct: n(p.stakeShortfallPct, 100),
    // Which desktop build sent this. It is how the dashboard tells "this app
    // is too old to know its own balances" apart from "the chain RPC did not
    // answer this time" — two identical-looking blanks with opposite fixes.
    // Shape-checked rather than trusted: it is rendered on a page.
    appVersion: /^\d{1,4}(\.\d{1,5}){1,3}(-[A-Za-z0-9.]{1,16})?$/.test(String(p.appVersion ?? ""))
      ? String(p.appVersion)
      : null,
    // When the machine took this reading — the dashboard shows its age, so a
    // node that stopped reporting looks stale instead of looking current.
    reportedAt: typeof p.reportedAt === "string" && p.reportedAt.length <= 40 ? p.reportedAt : null,
  };
}

class Scheduler {
  constructor({ dataDir, operatorSecret, chain, settlement, epoch, leaseMs, priceSources, bootstrapPoolSat, freeTokensPerDay, freeTokensPerDayGlobal, freeTokensPerIp, royalties, splits, jobModel, preferWindowMs, classEnforce, clampEnforce, reputationEnforce, storeMode, accounts, onEvent } = {}) {
    this.chain = chain || null; // ChainClient — when set, epoch roots anchor on-chain (§20)
    this.settlement = settlement || null; // {settleEpoch, kaiBalance} — closed epochs settle to KAI (§20-§22)
    this._balanceCache = new Map(); // address -> {at, kai}
    this._dispatchSeq = 0; // distinguishes re-dispatches of the same job
    this.leaseMs = leaseMs ?? PENDING_LEASE_MS;
    this._consumers = new Map(); // consume jobId -> resolve(output) (§46.5 relay)
    this.dataDir = dataDir || path.join(process.cwd(), "scheduler-data");
    // Durable storage backend (docs/durable-ledger-design.md): flat JSON files
    // by default; KAI_STORE=sqlite opts the ledgers into one WAL database with
    // transactional group-commits (auto-migrating the files on first boot).
    this.store = openStore(this.dataDir, storeMode);
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
    try {
      for (const [token, w] of Object.entries(this.store.loadWorkers() || {})) {
        // Same trust rule as registration: rosters persisted before the
        // catalog-class filter existed may carry private imports.
        w.models = (Array.isArray(w.models) ? w.models : []).filter((m) => MODEL_RATES[m]);
        // A fresh boot mints a fresh epoch — fairness counters start level
        // (persisted mid-epoch values belong to an epoch that no longer
        // exists; carrying them would skew the first rotation).
        w.seedsThisEpoch = 0;
        w.mystThisEpoch = 0; // audit budget is per-epoch, same as seeds
        // Reputation-clock backfill (field finding: live workers showed
        // ageDays 0 forever): rosters persisted before firstSeen existed have
        // none, and since tokens survive restarts these workers never
        // re-register to earn one. Start their clock at first boot under the
        // new code — conservative (age from now, not from their real history).
        if (typeof w.firstSeen !== "number" || !Number.isFinite(w.firstSeen)) w.firstSeen = Date.now();
        if (typeof w.repPaidJobs !== "number" || !Number.isFinite(w.repPaidJobs)) w.repPaidJobs = 0;
        if (typeof w.fingerprint !== "string") w.fingerprint = null; // rosters persisted before signal #3
        this.workers.set(token, w);
      }
      if (this.workers.size) this._persistWorkers(); // durably stamp the backfill once
    } catch {
      /* first boot */
    }
    this.queue = []; // pending jobs
    this.pending = new Map(); // jobId -> job (dispatched, awaiting result)
    this.waiters = []; // long-poll resolvers
    this.receipts = []; // current epoch receipts
    this.consumed = {}; // address -> requests served for them this epoch
    this.usage = {}; // address -> { inTok, outTok, costMicro } this epoch
    this.spentSat = {}; // address -> KAI satoshis charged to epoch earnings
    // Prepaid USD balance ledger (billing abstraction, µ$ integers): funded
    // by on-chain KAI deposits at the reference price; persisted on disk.
    // depositHwmSat is the cumulative deposits_of high-water mark.
    this.balances = this.store.loadBalances() || {};
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
    // §51 CU + phase-2 routing stats per address. tokPerSec/cuRating are
    // PROVIDER-reported (display + §52 modeling, challenge-audited later);
    // srvTokPerSec is SERVER-measured (completion tokens over dispatch->
    // result wall time) and ok/to/bad/sr are server-observed outcomes —
    // routing decisions use only what the scheduler measured itself,
    // because the server never trusts client claims.
    // PERSISTED across restarts (was reset every boot). Routing quality and the
    // reputation signals it feeds — sr, per-tier challenge history, token-
    // inflation strikes — must survive a deploy/host recycle, not cold-start
    // each time (the auto-deploy restarts the process on every ship). Restored
    // here, rewritten at each epoch close. A restart no longer launders a bad
    // actor's strike count or resets an honest node's earned reliability.
    this.perf = this.store.loadPerf() || {}; // address -> {jobs, tokPerSec, cuRating, srvTokPerSec, ok, to, bad, sr, chal, clamps, clampEgregious}
    // 'exit' handlers run synchronously even through process.exit() — which is
    // how the runtime-log's SIGTERM/crash handlers terminate — so perf, the
    // in-flight epoch state, and the daily free counters all survive every
    // shutdown path, not just a clean epoch close. (All three writers are
    // fully sync: writeFileSync + renameSync.) Deregistered in close() so test
    // suites constructing many schedulers don't leak listeners.
    this._onExit = () => {
      this._persistPerf();
      if (this.receipts && this.receipts.length) this._persist();
      this._saveFreeDay?.();
    };
    process.on("exit", this._onExit);
    this.preferWindowMs = preferWindowMs ?? PREFER_WINDOW_MS; // §51 phase-2 head start
    // §17 enforcement switches. Tier-3 (class-discriminating) challenges
    // ship in SHADOW mode — recorded, never punished — until field pass
    // rates prove honest big models clear them; KAI_CLASS_ENFORCE=1 arms
    // them. Token-clamp punishment defaults ON because its threshold is
    // unreachable by any honest tokenizer (3× the 2-chars/token cap,
    // three strikes); KAI_CLAMP_ENFORCE=0 disarms it.
    this.classEnforce = classEnforce ?? process.env.KAI_CLASS_ENFORCE === "1";
    this.clampEnforce = clampEnforce ?? process.env.KAI_CLAMP_ENFORCE !== "0";
    // §7.4 anti-Sybil GATE (docs/anti-sybil-reputation-weighting.md). OFF by
    // default — deploying this code changes nothing. When armed, the bootstrap
    // POOL divides by reputation-weighted useful work (below-gate workers draw
    // zero pool) — PAID revenue is never gated; equal work keeps equal pay.
    // Arm only after the shadow-trends field data shows honest nodes clear the
    // gate (same shadow-first discipline as KAI_CLASS_ENFORCE).
    this.reputationEnforce = reputationEnforce ?? process.env.KAI_REPUTATION_ENFORCE === "1";
    // The model class consumer chat jobs run as (and bill as). Stays on the
    // launch class by default; KAI_JOB_MODEL pins something else.
    this.jobModel = jobModel ?? (process.env.KAI_JOB_MODEL || DEFAULT_MODEL_CLASS);
    // §54 network-wide bootstrap POOL per epoch (owner decision) — spent on
    // useful work, divided pro-rata, unused left in reserve. Round through
    // Number so a fractional argument can't throw in BigInt().
    this.bootstrapPoolSat = bootstrapPoolSat != null ? BigInt(Math.round(Number(bootstrapPoolSat))) : BOOTSTRAP_POOL_SAT;
    /*
     * AccountService, when the website runs in this process. It is how a
     * session + spend grant resolves to the address the ledger already keys
     * on. Optional: a scheduler running alone simply has no session lane, and
     * says so rather than pretending.
     */
    this.accounts = accounts || null;
    // Free tier is DAILY. Per-account and network-wide counters key by UTC
    // day so a 15-min settlement epoch close never resets them (the bug the
    // owner flagged: 25k/epoch was 96× the intended 25k/day).
    this.freeTokensPerDay = freeTokensPerDay ?? FREE_TOKENS_PER_DAY;
    this.freeTokensPerDayGlobal = freeTokensPerDayGlobal ?? FREE_TOKENS_PER_DAY_GLOBAL;
    this.freeTokensPerIp = freeTokensPerIp ?? FREE_TOKENS_PER_IP; // per-origin daily ceiling
    this.freeDay = this._utcDay(); // the day the counters below belong to
    this.freeUsedByDay = {}; // address -> free tokens drawn today
    this.freeUsedGlobalDay = 0; // network-wide free tokens drawn today
    this.freeUsedByIp = {}; // ip -> free tokens drawn today (all addresses combined)
    // The daily counters PERSIST across restarts (they were memory-only — with
    // the auto-deploy restarting on every push, each deploy silently refilled
    // every account's daily free allowance and the network-wide ceiling).
    // Restored only for the SAME UTC day; a stale file from yesterday is
    // simply ignored (the day rolled, counters start at zero as intended).
    try {
      const fd = this.store.loadFreeDay();
      if (fd && fd.day === this.freeDay) {
        if (fd.byAddr && typeof fd.byAddr === "object" && !Array.isArray(fd.byAddr)) this.freeUsedByDay = fd.byAddr;
        this.freeUsedGlobalDay = Math.max(0, numOr(fd.global, 0));
        if (fd.byIp && typeof fd.byIp === "object" && !Array.isArray(fd.byIp)) this.freeUsedByIp = fd.byIp;
      }
    } catch {
      /* fresh day / no file */
    }
    // EPOCH RESUME (field finding 2026-08-17): a restart used to mint a fresh
    // epoch number and ABANDON the in-flight one — its receipts sat in the
    // epoch file with summary:null and never settled, so every deploy threw
    // away up to 15 minutes of workers' earned receipts, and mid-epoch
    // consumer spend (spentSat) was forgotten with them. On boot, if the most
    // recent epoch file is unsettled and holds receipts, RESUME it: same epoch
    // number (monotonicity holds — closeEpoch advances past it), receipts and
    // consumption state restored, and the next timer close settles everything
    // exactly as if the restart never happened. Skipped when the constructor
    // pins an explicit epoch (tests drive their own epochs).
    if (epoch == null) {
      try {
        const latest = this.store.latestEpochNumber();
        if (latest != null) {
          const j = this.store.readEpoch(latest);
          if (j && j.summary == null && Array.isArray(j.receipts) && j.receipts.length > 0) {
            this.epoch = latest;
            this.receipts = j.receipts;
            const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
            if (obj(j.spentSat)) this.spentSat = j.spentSat;
            if (obj(j.consumed)) this.consumed = j.consumed;
            if (obj(j.usage)) this.usage = j.usage;
            // Restore the price this epoch OPERATED under (review finding):
            // billing inside the epoch used this rate, so the resumed close
            // must settle at it too — and a re-closed epoch reproduces the
            // exact root it would have had. Malformed -> keep boot snapshot.
            try {
              if (j.price && Number.isFinite(Number(j.price.usd)) && Number(j.price.usd) > 0) {
                this.price = {
                  usd: Number(j.price.usd),
                  status: "resumed",
                  updatedAt: j.price.updatedAt ?? null,
                  microPerKai: BigInt(j.price.microPerKai),
                  satPerMicro: BigInt(j.price.satPerMicro),
                };
              }
            } catch {
              /* malformed persisted price — the boot snapshot stands */
            }
          } else {
            // Not resumable (settled, or empty). Still guarantee epoch
            // uniqueness across FAST restarts: systemd brings the process
            // back sub-second, so a boot in the same unix minute as a
            // just-settled epoch would re-mint its number — and later
            // collide on-chain at submit_root. Advance past it.
            this.epoch = Math.max(this.epoch, latest + 1);
          }
        }
      } catch {
        /* unreadable epoch file — start fresh, never block boot */
      }
    }
    // §32 kill switch: model packages (by pinned §27 sha256) the operator
    // has revoked. Served publicly at /policy; nodes quarantine matching
    // local packages and stop serving them. Persisted — a compromised
    // package must stay dead across scheduler restarts.
    this.revoked = this.store.loadRevoked() || {};
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
      // norm ("digits"/"letters") makes multi-part answers separator-proof;
      // challengeTier drives shadow-vs-enforced consequences per class.
      challenge: job.expected ? { expected: job.expected, ...(job.norm ? { norm: job.norm } : {}) } : null,
      // != null, not truthiness: tier 0 (mystery) is a real tier and must
      // survive the copy. Normalized to a number so an operator-supplied
      // string "3" can't slip past the strict tier === 3 shadow check.
      ...(job.challengeTier != null ? { challengeTier: numOr(job.challengeTier, 1) } : {}),
      // Targeted evals (fairness): a seed stamped for one worker is only
      // dispatchable to that worker — otherwise the fastest poller takes
      // every eval and other testers sit at 0 jobs (field feedback). The
      // stamp is released the moment the target stops being live.
      ...(job.forWorker ? { forWorker: job.forWorker } : {}),
      // Self-served work is outside the economy entirely — see the consume
      // handler. Carried on the job so completion knows not to bank it.
      ...(job.selfServed ? { selfServed: true } : {}),
      createdAt: new Date().toISOString(),
    };
    // §51 phase 2: consumer chat goes to the best-measured capable worker
    // first — a soft reservation, not a hard stamp. If the preferred worker
    // doesn't take it within the window, any capable worker can (the wake
    // timer re-fires parked polls the moment the window lapses).
    if (full.type === "chat" && !full.forWorker) {
      const pref = this._preferredFor(full.model);
      if (pref) {
        full.preferWorker = pref;
        full.preferUntil = Date.now() + this.preferWindowMs;
        const t = setTimeout(() => this._wakeWaiter(), this.preferWindowMs + 50);
        t.unref?.();
      }
    }
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
    if (job.forWorker && w.address !== job.forWorker) return false;
    // §51 phase 2: within the preference window only the best-rated worker
    // may take a chat job; after it lapses the job opens to everyone.
    if (job.preferWorker && w.address !== job.preferWorker && Date.now() < (job.preferUntil || 0)) return false;
    if (Array.isArray(w.models) && w.models.length > 0) return w.models.includes(job.model);
    // Legacy pre-catalog workers (never advertised anything) hold only the
    // dev pipeline model. A modern worker with an EMPTY list serves nothing.
    return w.legacy === true && job.model === "dev-tiny";
  }

  _servableIndex(w) {
    return this.queue.findIndex((j) => this._canServe(w, j));
  }

  _saveBalances() {
    try {
      this.store.saveBalances(this.balances);
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

  /** The UTC calendar day the free-tier counters belong to. */
  _utcDay() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  /** Roll the DAILY free-tier counters when the UTC day turns over. Free
   *  limits are a consumption window independent of the 15-min settlement
   *  epoch — so this is NOT tied to closeEpoch. */
  _rollFreeDay() {
    const today = this._utcDay();
    if (today === this.freeDay) return;
    this.freeDay = today;
    this.freeUsedByDay = {};
    this.freeUsedGlobalDay = 0;
    this.freeUsedByIp = {};
    this._saveFreeDay(); // advance the on-disk day marker (rare — once per day)
  }

  /** Persist the daily free-tier counters (atomic, small). Written on every
   *  free-token draw and on day roll, restored on boot for the same UTC day —
   *  so a restart can no longer refill anyone's daily allowance. */
  _saveFreeDay() {
    try {
      this.store.saveFreeDay({ day: this.freeDay, byAddr: this.freeUsedByDay, global: this.freeUsedGlobalDay, byIp: this.freeUsedByIp });
    } catch {
      /* best-effort */
    }
  }

  /** Free tokens this address may still draw right now, after the per-account,
   *  network-wide (global ceiling), and per-origin daily limits. */
  _freeTokensLeft(address, ip) {
    this._rollFreeDay();
    let left = Math.max(0, this.freeTokensPerDay - (this.freeUsedByDay[address] || 0));
    // Global ceiling: when the network's daily free budget is spent, public
    // free inference pauses for everyone until tomorrow (local + paid are
    // unaffected — that gating lives in the /consume handler, not here).
    if (this.freeTokensPerDayGlobal > 0) {
      left = Math.min(left, Math.max(0, this.freeTokensPerDayGlobal - this.freeUsedGlobalDay));
    }
    if (ip && this.freeTokensPerIp > 0) {
      left = Math.min(left, Math.max(0, this.freeTokensPerIp - (this.freeUsedByIp[ip] || 0)));
    }
    return left;
  }

  /** Can this address run one more request at all? (authorization gate —
   *  exact cost is only known after execution, from actual token usage.) */
  _consumeCapacity(address, ip) {
    const freeTokensLeft = this._freeTokensLeft(address, ip);
    const balanceMicro = this._balanceMicroOf(address);
    // Authorize earnings-backed consumption only against the GUARANTEED
    // earnings floor — the paid-revenue (non-pool) portion, which never
    // shrinks. The pool-funded subsidy share scales with network demand and
    // can drop between authorization and epoch close, so counting it here
    // would let a worker-consumer spend earnings that later evaporate,
    // leaving an uncollectable debt while the provider is paid in full
    // (review finding). A zero-pool budget zeroes every subsidy so only
    // paid compute earnings authorize spend. Eval-only earners therefore
    // can't spend the bootstrap subsidy on their own usage — correct: the
    // subsidy seeds the network, it is not a spending faucet.
    const earnedSat = this._settleFor(
      this.receipts.filter((r) => r.honest && r.worker === address),
      { poolSat: 0n, demandSat: 1n }
    ).workerSat;
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

    const freeLeft = this._freeTokensLeft(address, ip);
    const freeTaken = Math.min(freeLeft, totalTok);
    if (freeTaken > 0) {
      this.freeUsedByDay[address] = (this.freeUsedByDay[address] || 0) + freeTaken;
      this.freeUsedGlobalDay += freeTaken;
      if (ip && this.freeTokensPerIp > 0) this.freeUsedByIp[ip] = (this.freeUsedByIp[ip] || 0) + freeTaken;
      this._saveFreeDay();
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
      this.store.saveWorkers(Object.fromEntries(this.workers));
    } catch {
      /* best-effort */
    }
  }

  /** Persist the rolling perf map so routing quality + reputation signals
   *  survive a restart. Written at each epoch close AND on process exit (the
   *  auto-deploy can restart twice inside one epoch — close-only persistence
   *  lost everything earned since the last close, field finding 2026-08-17). */
  _persistPerf() {
    try {
      this.store.savePerf(this.perf);
    } catch {
      /* best-effort — never let persistence crash the epoch */
    }
  }

  /** Addresses of workers mid-job with an unexpired lease — the ONE busy
   *  definition every caller shares (stats, consume, seeding, reaping,
   *  routing). Chunk activity counts: a machine that streamed a delta
   *  moments ago is working, whatever its dispatch timestamp says. */
  _busySet(now = Date.now()) {
    return new Set(
      [...this.pending.values()]
        .filter(
          (p) =>
            // A worker mid-engine-swap (warming grace) is every bit as busy
            // as one mid-generation — handing it a second job would stack
            // swaps and defeat the grace it just asked for.
            (p.warmingUntil && now < p.warmingUntil) ||
            now - Math.max(p.dispatchedAt ?? now, p.lastActivityAt || 0) < (p.leaseMs || this.leaseMs)
        )
        .map((p) => p.worker)
    );
  }

  /** Providers serving RIGHT NOW: seen inside the liveness window, or busy
   *  mid-job (a working node isn't polling). Defined ONCE because
   *  /network/status and /network/roster must never disagree about who is
   *  online — the roster is what gets paid. */
  /**
   * Is THIS address serving right now, and what can it serve?
   *
   * Public because the web app needs to know whether to offer "run this on my
   * own machine" at all — an option that is offered and then fails is worse
   * than one that was never there. Answers about one address only: it is not
   * a roster, and it tells a caller nothing it could not already learn about
   * a wallet it controls.
   */
  nodeFor(address) {
    const addr = String(address || "");
    if (!addr) return { online: false, models: [] };
    const w = this._liveWorkers().find((x) => x.address === addr);
    if (!w) return { online: false, models: [] };
    return { online: true, models: Array.isArray(w.models) ? [...w.models] : [] };
  }

  _liveWorkers(now = Date.now(), busy = this._busySet(now)) {
    return [...this.workers.values()].filter((x) => now - x.lastSeen < LIVE_WINDOW_MS || busy.has(x.address));
  }

  /** Live network shape: connected computers and the classes they serve.
   *  detail:true adds per-worker rows (admin); false is the public shape. */
  /** §7.4 reputation for an address — SHADOW (surfaced, NOT yet applied to
   *  settlement). Built only from signals we already earn, every input NaN-
   *  guarded. `elig` is the pool weight a reputation GATE WOULD assign
   *  (`(r>gate) ? ((r-gate)/(1-gate))^γ : 0`), reported so field data can
   *  calibrate the gate before it is armed. A brand-new / untracked address
   *  sits at REP_MIN (age 0, no reliability or challenge history, no paid
   *  demand) and climbs as it proves itself. */
  _reputation(address, now = Date.now(), worker = null) {
    const w = worker || [...this.workers.values()].find((x) => x.address === address);
    const p = this.perf[address] || {};
    // firstSeen must be a real ms timestamp. A corrupted persisted value (e.g.
    // the string "2024") would pass numOr as "finite" and read as ~1970-relative
    // ms, inflating age. Require an actual finite number, and cap age at ~10y so
    // no single bad value can dominate. Missing/corrupt -> age 0 (unproven).
    const fseen = w && typeof w.firstSeen === "number" && Number.isFinite(w.firstSeen) ? w.firstSeen : now;
    const ageDays = Math.min(3650, Math.max(0, (now - fseen) / 86400000));
    const ageS = 1 - Math.exp(-ageDays / Math.max(0.001, REP_AGE_TAU_DAYS));
    let cok = 0, cbad = 0;
    for (const t of Object.values(p.chal || {})) { cok += numOr(t.ok, 0); cbad += numOr(t.bad, 0); }
    const chalS = cok + cbad > 0 ? cok / (cok + cbad) : 0;
    const relyS = clamp01(p.sr);
    const paidJobs = w ? numOr(w.repPaidJobs, 0) : 0;
    const paidS = paidJobs / (paidJobs + Math.max(1, REP_PAID_K));
    const raw = clamp01(REP_W_AGE * ageS + REP_W_PAID * paidS + REP_W_RELY * relyS + REP_W_CHAL * chalS);
    const r = REP_MIN + (1 - REP_MIN) * raw;
    const eligRaw = r <= REP_GATE ? 0 : (r - REP_GATE) / (1 - REP_GATE);
    return {
      r: +r.toFixed(3),
      ageDays: +ageDays.toFixed(2),
      gated: r > REP_GATE,
      elig: +Math.pow(eligRaw, REP_GAMMA).toFixed(3),
      sub: { age: +ageS.toFixed(3), paid: +paidS.toFixed(3), rely: +relyS.toFixed(3), chal: +chalS.toFixed(3) },
    };
  }

  statsPublic({ detail = false } = {}) {
    const now = Date.now();
    const busy = this._busySet(now);
    const live = this._liveWorkers(now, busy);
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
        /*
         * Price rides along with availability. Anyone choosing a class is
         * choosing a bill, and making them cross-reference /pricing to find
         * out what they just picked is how a picker becomes a trap. Same
         * numbers /pricing serves; one fetch instead of two.
         */
        .map(([model, providers]) => ({
          model,
          providers,
          inUsdPerM: (MODEL_RATES[model]?.inMicroPerM || 0) / 1e6,
          outUsdPerM: (MODEL_RATES[model]?.outMicroPerM || 0) / 1e6,
          ctxTokens: MODEL_RATES[model]?.ctxTokens || null,
        })),
      // Drop-timeline diagnosis (field): nodes seen within the hour but
      // NOT live right now, with how long ago their last contact was —
      // an abrupt age jump pinpoints the moment a node's polls stopped.
      recentOffline: [...this.workers.values()]
        .filter((x) => now - x.lastSeen >= 90000 && now - x.lastSeen < 3600000 && !busy.has(x.address))
        .map((x) => ({ addr: `${x.address.slice(0, 6)}…`, lastSeenSecs: Math.round((now - x.lastSeen) / 1000), models: (x.models || []).length })),
    };
    if (detail) {
      // §7.4 signal #3: how many OTHER live workers share each device
      // fingerprint. 0 is the normal case; a fleet of clones shows up as a
      // block of equal non-zero counts. Shadow — displayed, never applied.
      const fpCount = {};
      for (const w of live) if (w.fingerprint) fpCount[w.fingerprint] = (fpCount[w.fingerprint] || 0) + 1;
      out.workers = live.map((w) => ({
        address: w.address,
        models: (w.models || []).filter((m) => MODEL_RATES[m]),
        // Whole-GB RAM as the CLIENT reported it — the number the minRamGb
        // fit rule actually ran against. models=[] with ram visible turns a
        // "why is my machine not serving" field report into a one-look
        // diagnosis (Pi finding 2026-08-19: this was invisible remotely).
        ram: Number(w.capabilities?.ramGb) || null,
        lastSeenSecs: Math.round((now - w.lastSeen) / 1000),
        busy: busy.has(w.address),
        perf: this.perf[w.address] || null,
        jobsThisEpoch: this.receipts.filter((r) => r.worker === w.address).length,
        reputation: this._reputation(w.address, now, w), // §7.4 SHADOW — surfaced, not applied
        fp: w.fingerprint ? w.fingerprint.slice(0, 8) : null,
        fpPeers: w.fingerprint ? fpCount[w.fingerprint] - 1 : 0,
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
      // Activity-aware lease: a chunk streamed mid-job refreshes it — a
      // slow honest machine deep in generation must not be timeout-blamed
      // onto probation (§51 phase-2 field guard). The absolute cap is the
      // ceiling chunks can't extend past.
      const startedAt = job.dispatchedAt ?? now;
      const activeAt = Math.max(startedAt, job.lastActivityAt || 0);
      // The one-time warming grace holds the lease open through an announced
      // engine swap (see /worker/warming); the absolute cap still rules.
      const inGrace = job.warmingUntil && now < job.warmingUntil;
      if (now - startedAt <= JOB_ABS_CAP_MS && (inGrace || now - activeAt < (job.leaseMs || this.leaseMs))) continue;
      this.pending.delete(id);
      const { worker, dispatchedAt, dispatchId, leaseMs, preferWorker, preferUntil, lastActivityAt, warmingUntil, ...fresh } = job;
      // §51 phase 2: the worker took this job and never delivered — a
      // server-observed timeout. (Dispatches that never reached the worker
      // are returned on the socket path and never age into a lease expiry,
      // so no one is blamed for a job they never received.) The requeued
      // job also sheds any routing preference: the preferred worker just
      // failed it, so the retry is open to every capable worker.
      this._outcome(worker, "to");
      // A lease expiry was the target's exclusive shot: release the eval
      // stamp so any capable worker can rescue the job. A live-but-broken
      // target would otherwise re-take the same seed forever, with rescue
      // impossible by construction (review finding). The target's fairness
      // credit is given back — it never actually served.
      if (fresh.forWorker) {
        // Credits are typed: eval stamps gave a seed credit, mystery chats
        // a mystery credit — give back the one that was actually granted
        // (a mystery expiry must not eat an unrelated seed credit).
        if (fresh.type === "inference-eval") this._unseed(fresh.forWorker);
        else if (fresh.challenge) this._unmyst(fresh.forWorker);
        delete fresh.forWorker;
      }
      this.queue.unshift(fresh);
      this._wakeWaiter();
      this.onEvent({ type: "scheduler:job-requeued", jobId: id });
    }
    // Queue hygiene for eval stamps. Busy counts as live exactly as in
    // stats/consume — pre-v0.24.1 clients go lastSeen-silent mid-job.
    const busy = this._busySet(now);
    const liveWorkers = [...this.workers.values()].filter((w) => now - w.lastSeen < 90000 || busy.has(w.address));
    let changed = false;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const j = this.queue[i];
      // Stamped eval whose target left: release — the eval is still worth
      // running by anyone who holds the model (a reserved job for an
      // offline worker would sit forever and starve the seed window).
      if (j.forWorker && !liveWorkers.some((w) => w.address === j.forWorker)) {
        if (j.type === "inference-eval") this._unseed(j.forWorker);
        else if (j.challenge) this._unmyst(j.forWorker);
        delete j.forWorker;
        changed = true;
      }
      // Protocol jobs NO live worker can serve are garbage after a grace
      // period: the queue has no other GC, so each one would strand forever
      // and eat a slot of the 3-deep seed backpressure window — three of
      // those and seeding halts network-wide (review finding). This covers
      // both eval seeds AND mystery chats: a mystery is a protocol-generated
      // type:"chat" with a challenge and NO waiting consumer, so it must be
      // GC'd too (a real consumer chat has an entry in this._consumers and
      // is never touched here — its failure surfaces to the consumer).
      const isProtocol = j.type === "inference-eval" || (j.challenge && !this._consumers.has(j.id));
      if (isProtocol && now - Date.parse(j.createdAt) > 5 * 60000) {
        if (!liveWorkers.some((w) => this._canServe(w, j))) {
          if (j.forWorker) {
            if (j.type === "inference-eval") this._unseed(j.forWorker);
            else this._unmyst(j.forWorker);
          }
          this.queue.splice(i, 1);
          this.onEvent({ type: "scheduler:protocol-dropped", jobId: j.id, model: j.model, kind: j.type === "chat" ? "mystery" : "eval" });
          changed = true;
        }
      }
    }
    if (changed) this._wakeWaiter();
  }

  /** Give a seed credit back: the stamped eval never actually served. */
  _unseed(address) {
    const w = [...this.workers.values()].find((x) => x.address === address);
    if (w && w.seedsThisEpoch > 0) w.seedsThisEpoch -= 1;
  }

  /** Give a mystery-chat credit back: the audit never actually ran. */
  _unmyst(address) {
    const w = [...this.workers.values()].find((x) => x.address === address);
    if (w && w.mystThisEpoch > 0) w.mystThisEpoch -= 1;
  }

  /** §51 phase 2: record one server-observed job outcome for an address.
   *  kind: "ok" (honest result), "to" (lease expired — took the job, never
   *  delivered), "bad" (challenge failed). sr is a smoothed success rate;
   *  the EMA means a bad stretch demotes and honest work (evals keep
   *  flowing to every worker) redeems — nobody is banned forever. */
  _outcome(address, kind) {
    const p = (this.perf[address] ||= { jobs: 0, tokPerSec: 0, cuRating: 0 });
    p[kind] = (p[kind] || 0) + 1;
    const v = kind === "ok" ? 1 : 0;
    p.sr = p.sr == null ? v : +(0.8 * p.sr + 0.2 * v).toFixed(3);
  }

  /** On probation: enough server-observed outcomes to judge, and mostly
   *  failures. Probation workers are never preferred and never chosen by
   *  auto-class — but still serve named classes (availability first) and
   *  still receive eval seeds, which is the road back. */
  _onProbation(address) {
    const p = this.perf[address];
    return !!p && (p.ok || 0) + (p.to || 0) + (p.bad || 0) >= 4 && (p.sr ?? 1) < 0.5;
  }

  /** §51 phase 2: the strictly-best capable worker for a chat job, by
   *  server-measured serving speed weighted by success rate. Busy and
   *  probation workers are skipped; with fewer than two candidates or no
   *  strict winner there is nothing to prefer (first poll wins, as before).
   *  Unrated workers score 0 — eval seeds rate a new machine within
   *  minutes, so this is a cold start, not a lockout. */
  _preferredFor(model) {
    const now = Date.now();
    const busy = this._busySet(now);
    const candidates = [...this.workers.values()].filter(
      (w) =>
        now - w.lastSeen < 90000 &&
        !busy.has(w.address) &&
        this._canServe(w, { model }) &&
        !this._onProbation(w.address)
    );
    if (candidates.length < 2) return null;
    const score = (a) => {
      const p = this.perf[a];
      return p && p.srvTokPerSec > 0 ? p.srvTokPerSec * (p.sr ?? 1) : 0;
    };
    candidates.sort((a, z) => score(z.address) - score(a.address));
    const best = score(candidates[0].address);
    if (!(best > 0) || best === score(candidates[1].address)) return null;
    return candidates[0].address;
  }

  /**
   * Close out a spending hold: keep what was actually spent, return the rest.
   *
   * Idempotent by design — it is called once on the settlement path and again
   * from the response's own ending, and whichever arrives first wins. Without
   * that, a request that failed after reserving would burn the reservation
   * permanently and a handful of 503s could retire a live grant.
   */
  _settleGrantHold(grantCharge, actualMicro) {
    if (!grantCharge || !grantCharge.heldMicro) return;
    const held = grantCharge.heldMicro;
    grantCharge.heldMicro = 0; // whoever got here first owns the settlement
    const spent = Math.max(0, Math.floor(Number(actualMicro) || 0));
    if (spent > held) {
      /*
       * More was generated than the bound allowed for. The hold is kept in
       * full and the overshoot recorded rather than charged: the cap is the
       * promise, and quietly billing past it would break the promise to fix
       * the arithmetic.
       */
      this.onEvent({ type: "grant:cost-exceeded-hold", grant: grantCharge.grantId, heldMicro: held, costMicro: spent });
      return;
    }
    this.accounts.refundGrant(grantCharge.grantId, held - spent);
  }

  _json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(data);
  }

  /*
   * Request bodies, bounded.
   *
   * This used to concatenate the stream with no ceiling, and /scheduler is
   * mounted ahead of express.json in server.js — so nothing else was going to
   * stop it either. Any anonymous POST to a public route could stream until
   * the heap gave out and take the whole network's scheduler with it. A cap
   * is the entire fix: legitimate bodies here are a worker's model list, a
   * chat request, or a generated answer, none of which come close.
   *
   * On refusal handle() answers 413 and closes the connection, rather than
   * draining: reading the rest of a body we have already refused is the same
   * donation of memory, more slowly.
   */
  async _body(req) {
    const chunks = [];
    let bytes = 0;
    try {
      for await (const c of req) {
        bytes += c.length;
        if (bytes > MAX_BODY_BYTES) {
          throw Object.assign(new Error("request body too large"), { status: 413 });
        }
        chunks.push(c);
      }
    } catch (e) {
      if (e && e.status === 413) throw e;
      throw Object.assign(new Error("could not read the request body"), { status: 400 });
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return {};
    }
  }

  /*
   * Privileged routes, failing closed.
   *
   * Every one of these used to read
   *   if (this.operatorSecret && header !== this.operatorSecret) refuse
   * which refuses nobody when the secret is UNSET. A deploy that forgot
   * KAI_OPERATOR_SECRET published epoch closing, package revocation and job
   * injection to the open internet, and looked exactly like a healthy deploy
   * from the outside. No secret now means no privileged route, for anyone —
   * automatic epoch closing is unaffected because startAutoOps calls
   * closeEpoch() in process, never through HTTP.
   */
  _operatorAuthed(req, res) {
    if (!this.operatorSecret) {
      this._json(res, 503, {
        ok: false,
        error: "Privileged routes are disabled: this scheduler has no operator secret. Set KAI_OPERATOR_SECRET and restart.",
      });
      return false;
    }
    if (!secretsMatch(req.headers["x-operator-secret"], this.operatorSecret)) {
      this._json(res, 401, { ok: false, error: "operator secret required" });
      return false;
    }
    return true;
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

  /*
   * One place where a body that was refused for its size becomes an answer.
   * Without this the throw from _body would surface as server.js's generic
   * 500, which tells an honest client nothing and an attacker that something
   * interesting happened.
   */
  async handle(req, res) {
    try {
      return await this._handle(req, res);
    } catch (e) {
      if (!e || e.status !== 413) throw e;
      /*
       * Connection: close, NOT req.destroy(). The sender is still pushing a
       * body we have refused, and the connection has to end — but destroying
       * the request tears the socket down underneath the response, so the
       * client is left hanging on a request that was answered and never hears
       * the answer. (Found by the probe: fetch simply never settled.) This
       * header makes Node flush the 413 and then close, which is the same
       * outcome for us and a real reply for them.
       */
      try {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: false, error: "request body too large" }));
      } catch { /* client already gone */ }
      return undefined;
    }
  }

  async _handle(req, res) {
    const url = new URL(req.url, "http://x");
    this._reapPending();

    /*
     * Refresh JUST the block-producer snapshot for an already-registered
     * worker.
     *
     * Separate from registration because registering mints a new token and
     * kills the worker's in-flight long poll — far too disruptive to do every
     * few minutes to freshen a cosmetic number. Authenticated by the token the
     * worker already holds, so it can only ever update its own row.
     */
    if (url.pathname === "/worker/producer" && req.method === "POST") {
      const token = url.searchParams.get("token") || "";
      const w = this.workers.get(token);
      if (!w) return this._json(res, 401, { ok: false, error: "unknown or expired worker token" });
      const b = await this._body(req).catch((e) => {
        if (e && e.status === 413) throw e; // a refusal must reach handle()
        return {};
      });
      // Kept in a local rather than read back off the worker: the stored value
      // is unverified client input, and the probe holds a hard line that
      // nothing in this file ever READS it. Reporting what we just wrote needs
      // no exception to that rule.
      const snapshot = sanitizeProducer(b && b.producer);
      w.producer = snapshot;
      w.lastSeen = Date.now();
      this._persist?.();
      return this._json(res, 200, { ok: true, stored: snapshot != null });
    }

    if (url.pathname === "/worker/register" && req.method === "POST") {
      const b = await this._body(req);
      if (!b.address) return this._json(res, 400, { ok: false, error: "address required" });
      const token = "wt_" + crypto.randomBytes(16).toString("hex");
      // Models this machine can serve NOW (on disk, ready). Dispatch only
      // hands a worker jobs it advertised — a job for a missing model
      // would trigger a mid-lease gigabyte download and time out.
      // Only PRICED catalog classes ride the network (private imports and
      // dev builds stay local), and — when the client reports its RAM —
      // only classes the machine can actually hold (minRamGb). The app
      // applies the same rule; this catches stale or modified clients.
      const ramGb = Number(b.capabilities?.ramGb) || null;
      const models = (Array.isArray(b.models) ? b.models.map(String) : [])
        .filter((m) => MODEL_RATES[m])
        .filter((m) => !ramGb || !MODEL_RATES[m].minRamGb || MODEL_RATES[m].minRamGb <= ramGb);
      // Fairness counters SURVIVE re-registration: standby resume, the
      // watchdog, and token refresh all re-register mid-epoch, and a fresh
      // object would zero seedsThisEpoch — putting the flappiest node at
      // the head of the least-served rotation every time, and letting a
      // dishonest one farm evals by re-registering before each seed tick
      // (review finding).
      const prev = [...this.workers.values()].find((w) => w.address === b.address);
      this.workers.set(token, {
        address: b.address,
        capabilities: b.capabilities || {},
        models,
        // Legacy pre-catalog clients never sent a models list AT ALL —
        // only those fall back to the dev pipeline model. A modern client
        // whose list filtered to empty serves nothing (it must not
        // masquerade as legacy and absorb dev-tiny evals).
        legacy: !Array.isArray(b.models),
        seedsThisEpoch: prev?.seedsThisEpoch || 0,
        seedRR: prev?.seedRR ?? -1,
        mystThisEpoch: prev?.mystThisEpoch || 0,
        // §7.4 reputation signals — DURABLE (survive re-registration and, via
        // workers.json, process restart), so a deploy doesn't wipe network age
        // or paid-demand history the way the volatile perf object gets wiped.
        firstSeen: prev?.firstSeen || Date.now(),
        repPaidJobs: prev?.repPaidJobs || 0,
        // §7.4 anti-Sybil signal #3 (SHADOW): the client's device fingerprint.
        // Kept when a re-registration omits it (an old client after an app
        // downgrade must not erase the binding). Bounded — it's attacker
        // input. Collisions are surfaced, never punished, until the gate
        // decisions arm enforcement.
        fingerprint: (typeof b.fingerprint === "string" && /^[0-9a-f]{8,64}$/.test(b.fingerprint) ? b.fingerprint : null) ?? prev?.fingerprint ?? null,
        /*
         * Koinos block-producer snapshot, for the owner's own account page.
         *
         * DISPLAY ONLY, and it must stay that way: it is self-reported by the
         * client and nothing verifies it, so it must never reach routing,
         * reputation or payouts. It is sanitised here because it is still
         * attacker input even when it only ever renders on the reporter's own
         * page.
         *
         * NOT carried over from `prev` when absent, unlike fingerprint: a node
         * that stopped producing should stop showing a producer card, and a
         * stale card claiming otherwise is worse than a brief blank that the
         * next registration fills back in.
         */
        producer: sanitizeProducer(b.producer),
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
      // Streaming IS working: refresh the job's lease so a long generation
      // on a slow machine never ages into a timeout while words are still
      // arriving (bounded by the absolute cap in the reaper).
      job.lastActivityAt = Date.now();
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

    // Full network status — public, consumed by the app's Network tab.
    // Same detail the admin panel gets, EXCEPT provider addresses are
    // truncated server-side: explorer-style display needs no full keys,
    // and the full address never leaves the operator surface.
    if (url.pathname === "/network/status" && req.method === "GET") {
      const s = this.statsPublic({ detail: true });
      s.workers = (s.workers || []).map((w) => ({ ...w, address: `${w.address.slice(0, 6)}…${w.address.slice(-4)}` }));
      return this._json(res, 200, { ok: true, ...s });
    }

    // Live provider addresses, in FULL — the payout roster consumed by Free
    // Koinos Node's community distribution, which pays these addresses
    // directly on chain. /network/status shortens addresses because display
    // needs no full key; this endpoint deliberately does not, because a
    // truncated address is not payable. Same liveness rule as
    // /network/status by construction (_liveWorkers), so the two surfaces
    // can never disagree about who was serving during a snapshot.
    if (url.pathname === "/network/roster" && req.method === "GET") {
      const workers = [...new Set(this._liveWorkers().map((w) => w.address))].slice(0, ROSTER_MAX);
      // A payout roster read on a schedule must never be served from a
      // cache — a stale list pays nodes that already left.
      res.setHeader("Cache-Control", "no-store");
      return this._json(res, 200, { ok: true, count: workers.length, workers });
    }

    // §20 transparency: a provider's own claim packets — everything needed
    // to claim KAI from the settlement contract without trusting this
    // server: epoch, amount, Merkle index + proof, and the root the proof
    // must recompute. Public by design: roots are anchored on-chain, totals
    // are already public, and a proof only mints to ITS worker address —
    // knowing someone else's packet gives you nothing.
    if (url.pathname === "/claims" && req.method === "GET") {
      const address = String(url.searchParams.get("address") || "").trim();
      if (!/^1[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(address)) {
        return this._json(res, 400, { ok: false, error: "address must be a Koinos address (?address=1…)" });
      }
      const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 20), 100);
      const out = [];
      try {
        const summaries = this.store.listEpochSummaries();
        for (let i = summaries.length - 1; i >= 0 && out.length < limit; i--) {
          const sum = summaries[i]?.summary ?? summaries[i];
          const packet = sum?.claims?.[address];
          if (!packet) continue;
          out.push({
            epoch: sum.epoch,
            root: sum.root,
            amount: packet.amount ?? null,
            count: packet.count ?? null, // pre-A1 epochs settled by receipt count
            index: packet.index,
            proof: packet.proof,
            settlement: sum.settlement
              ? {
                  rootTx: sum.settlement.rootTx ?? null,
                  claim: sum.settlement.claims?.[address] ?? null,
                  error: sum.settlement.error ?? null,
                }
              : null,
          });
        }
      } catch (e) {
        return this._json(res, 500, { ok: false, error: String(e.message) });
      }
      res.setHeader("Cache-Control", "no-store");
      return this._json(res, 200, { ok: true, address, count: out.length, claims: out });
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

    // Cold engine swap ahead (A40 field finding): the worker announces that
    // this job needs a model it must first LOAD, before it goes lease-silent
    // for the length of the swap. The job gets ONE warming grace — fixed,
    // not renewable, only from the worker actually holding the job — and the
    // moment tokens flow, chunk activity takes the lease over as usual.
    if (url.pathname === "/worker/warming" && req.method === "POST") {
      const w = this._auth(req);
      if (!w) return this._json(res, 401, { ok: false, error: "bad token" });
      w.lastSeen = Date.now();
      const b = await this._body(req);
      const job = this.pending.get(String(b.jobId || ""));
      if (!job || job.worker !== w.address) {
        // Not yours (requeued already, or invented): no grace, no error —
        // the announcement is advisory, never a lever.
        return this._json(res, 200, { ok: true, granted: false });
      }
      if (!job.warmingUntil) {
        job.warmingUntil = Date.now() + WARM_GRACE_MS;
        this.onEvent({ type: "scheduler:job-warming", jobId: job.id, worker: w.address, model: job.model });
      }
      return this._json(res, 200, { ok: true, granted: true, graceMs: Math.max(0, job.warmingUntil - Date.now()) });
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
        // minutes, and a 60s lease was requeuing jobs mid-generation. Eval
        // leases honor the constructor override (same default) — probes and
        // tests set it short to exercise expiry without waiting a minute.
        const leaseMs = job.type === "chat" ? 300000 : this.leaseMs;
        this.pending.set(job.id, { ...job, worker: w.address, dispatchedAt: Date.now(), dispatchId, leaseMs });
        this.onEvent({ type: "scheduler:job-dispatched", jobId: job.id, worker: w.address, token: w.token.slice(-6) });
        // The challenge's expected answer never leaves the scheduler — and
        // neither does ANY server-side routing/verification field. A stock
        // client ignores extra fields, but a MODIFIED client would read a
        // forWorker/preferWorker stamp as "this is a targeted audit" and
        // cheat selectively. The visible payload of every job is exactly:
        // id, type, model, modelClass, prompt/messages, createdAt.
        const { challenge, challengeTier, forWorker, preferWorker, preferUntil, ...visible } = job;
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

      const challenged = !!job.challenge;
      const passed = !challenged || this._passesChallenge(job.challenge, b.output);
      // Tier semantics: 0 = paid-path mystery chat; 1–2 = per-class eval
      // challenges; 3 = class discriminators. ENFORCEMENT POLICY (review
      // finding): tiers 1–2 are enforced (deterministic temp-0 evals, easy
      // by construction — an honest model of that class cannot fail). Tier 0
      // (mystery) and tier 3 (class discriminators) are SHADOW by default —
      // recorded, never burned — because they ride the paid chat path at
      // temperature 0.7 and/or on weak classes, where an honest model can
      // legitimately miss and burning it would rob a real tester. They arm
      // only under classEnforce, once field baselines prove honest pass
      // rates. `honest` is the SETTLEMENT verdict; `passed` is the raw
      // challenge result recorded either way.
      const tier = challenged ? numOr(job.challengeTier, 1) : null;
      const shadowTier = tier === 0 || tier === 3;
      const enforcedFail = challenged && !passed && (!shadowTier || this.classEnforce);
      let honest = !enforcedFail;
      this.pending.delete(b.jobId);
      // §17: token counts are provider-reported and feed billing AND the
      // server's speed measurement, so they are bounded by what the server
      // can see. The cap is in BYTES (UTF-8), not UTF-16 chars: a CJK/emoji
      // character is 3–4 bytes but only 1–3 tokens on a byte-fallback BPE
      // tokenizer, so a byte budget never clamps honest multilingual output
      // the way a char budget did (review finding). Any real tokenizer emits
      // FEWER tokens than bytes; the cap allows 1 token/byte plus slack.
      const promptBytes = Buffer.byteLength(job.messages ? JSON.stringify(job.messages) : String(job.prompt || ""), "utf8");
      const outBytes = Buffer.byteLength(String(b.output ?? ""), "utf8");
      const promptCapTok = 24 + promptBytes;
      const outCapTok = 24 + outBytes;
      // NaN-safe (review CRITICAL): Number({}) is NaN and the ?? never fires
      // for a non-nullish object; a NaN token count poisons the receipt and
      // BigInt(NaN) later throws, crashing epoch close. Coerce to a finite
      // integer or 0 BEFORE any arithmetic.
      const reported = {
        prompt_tokens: clampInt(b.usage?.prompt_tokens, 0, 2e6),
        completion_tokens: clampInt(b.usage?.completion_tokens, 0, 2e6),
      };
      const usage = {
        prompt_tokens: Math.min(reported.prompt_tokens, promptCapTok),
        completion_tokens: Math.min(reported.completion_tokens, outCapTok),
      };
      const clamped = usage.prompt_tokens < reported.prompt_tokens || usage.completion_tokens < reported.completion_tokens;
      // Egregious = beyond 3× the byte budget (≥3 claimed tokens per output
      // byte — impossible for any tokenizer, which merges bytes into fewer
      // tokens, never more). Three strikes, then every further egregious
      // report burns the receipt. Enforced by default: the threshold is
      // unreachable by honest output of any language.
      const egregious =
        reported.prompt_tokens > 3 * promptCapTok || reported.completion_tokens > 3 * outCapTok;
      /*
       * The clamp itself always applies — reported usage stays bounded no
       * matter who asked. What is skipped for self-served work is the STRIKE:
       * clamps feed the dishonesty counter that can burn a node's standing,
       * and a job you sent to your own machine has no counterparty to defraud.
       * Recording one would let a person damage their own reputation by using
       * their own hardware, which is nobody's idea of the deal.
       */
      if (clamped && !job.selfServed) {
        const p0 = (this.perf[w.address] ||= { jobs: 0, tokPerSec: 0, cuRating: 0 });
        p0.clamps = (p0.clamps || 0) + 1;
        if (egregious) p0.clampEgregious = (p0.clampEgregious || 0) + 1;
        if (this.clampEnforce && egregious && p0.clampEgregious > 3) honest = false;
        this.onEvent({ type: "scheduler:usage-clamped", worker: w.address, jobId: b.jobId, reported, clamped: usage, egregious });
      }
      /*
       * SELF-SERVED WORK EARNS NOTHING, AND THAT IS THE SECURITY PROPERTY.
       *
       * A receipt is a claim on the epoch: it earns paid value, draws the
       * bootstrap subsidy, and feeds reputation. If serving yourself produced
       * one, anyone could loop jobs to their own machine and farm the pool —
       * minting rewards for work nobody asked for. So a self-served job never
       * becomes a receipt at all. It is not "free work", it is work outside
       * the economy: your hardware answered your own question, no value moved
       * in either direction, and there is nothing to settle.
       *
       * The perf sample is dropped for the same reason. srvTokPerSec drives
       * which worker gets first pick of OTHER people's chats, so accepting a
       * number a machine generated for itself would let someone buy the
       * routing preference with self-dealt jobs.
       */
      if (job.selfServed) {
        this._persist();
        const w2 = this._consumers.get(b.jobId);
        if (w2) {
          this._consumers.delete(b.jobId);
          w2({ output: String(b.output ?? ""), usage });
        }
        return this._json(res, 200, { ok: true, selfServed: true });
      }
      // §51 CU groundwork: provider-reported timing (same trust level as
      // usage — challenge-audited later) feeds a rolling capability rating.
      const perf = {
        ms: Math.max(0, Math.min(1e7, Number(b.perf?.ms ?? 0))),
        tokPerSec: Math.max(0, Math.min(1e5, Number(b.perf?.tokPerSec ?? 0))),
      };
      // §51 phase 2: server-observed outcome — honest results build the
      // success rate, challenge failures burn it. Routing trusts these,
      // not the provider's own numbers.
      this._outcome(w.address, honest ? "ok" : "bad");
      if (challenged) {
        // Per-tier pass/fail history rides the perf object: t0 = mystery
        // chats (shadow), t1–t2 = enforced evals, t3 = class discriminators
        // (shadow). This is the field baseline that decides when the shadow
        // tiers arm. `tier` is numeric (numOr above), so tier 0 records to
        // t0 — not collapsed into t1.
        const p = this.perf[w.address];
        const c = ((p.chal ||= {})["t" + tier] ||= { ok: 0, bad: 0 });
        if (passed) c.ok += 1;
        else c.bad += 1;
        this.onEvent({ type: "scheduler:challenge-result", worker: w.address, tier, model: job.model, pass: passed, enforced: !shadowTier || this.classEnforce });
      }
      if (honest && perf.tokPerSec > 0) {
        const p = this.perf[w.address];
        p.jobs += 1;
        p.tokPerSec = p.jobs === 1 ? perf.tokPerSec : +(0.3 * perf.tokPerSec + 0.7 * p.tokPerSec).toFixed(2);
        p.cuRating = +(p.tokPerSec / CU_BASELINE_TPS).toFixed(3);
      }
      // §51 phase 2: serving speed the scheduler measured itself — completion
      // tokens over dispatch-to-result wall time. Includes network overhead,
      // which is fair: that IS what a consumer experiences. Token counts are
      // provider-reported until §17 deepens, but they are the same counts
      // billing uses, so inflating them is already the audited lie.
      if (honest && usage.completion_tokens > 0 && job.dispatchedAt) {
        const secs = Math.max(0.001, (Date.now() - job.dispatchedAt) / 1000);
        // Cap the per-sample rate (review finding): a faker returning a long
        // garbage string instantly would post an enormous srvTokPerSec and
        // capture the routing preference. No real provider exceeds this
        // ceiling, so honest machines are unaffected while a fabricated
        // burst can't buy first-pick on consumer chats.
        const stps = Math.min(SRV_TPS_CAP, +(usage.completion_tokens / secs).toFixed(2));
        const p = this.perf[w.address];
        p.srvTokPerSec = p.srvTokPerSec == null ? stps : +(0.3 * stps + 0.7 * p.srvTokPerSec).toFixed(2);
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
      /*
       * TWO WAYS TO AUTHORIZE A REQUEST, and only two.
       *
       *   1. A per-request wallet signature — the desktop app's way. The key
       *      is on the caller's machine; nothing here can forge it.
       *   2. A session plus a SPEND GRANT — the web app's way. A browser
       *      cannot hold a key safely enough to sign every request, so the
       *      wallet signs ONCE to say "this site may draw on me, capped and
       *      dated" and the session rides on that.
       *
       * The web tier NEVER forges a consume signature — that would make the
       * server able to spend as any user, which is the exact property the
       * grant design exists to avoid. Instead the grant resolves, in this
       * process, to the address the ledger already keys on. Everything
       * downstream — deposits, capacity, charging — is untouched: only WHO
       * MAY DRAW on an address is new.
       */
      let grantCharge = null; // {grantId, remainingMicro} when session-authorized
      if (!b.signature && (b.sessionToken || b.grantId)) {
        if (!this.accounts) {
          return this._json(res, 401, { error: { message: "session sign-in is not available on this server", type: "invalid_request_error" } });
        }
        /*
         * IN-PROCESS CALLERS ONLY: `req.trustedAccountId` is a property on the
         * request OBJECT, never a header and never a body field. A real
         * IncomingMessage arriving over the socket cannot carry it — headers
         * land on req.headers and the body is parsed into `b`, so neither can
         * put a property here. Only code in this process constructing its own
         * request can, which is exactly the caller this is for: the web app's
         * scheduled tasks, which have no session because there is no browser.
         *
         * It resolves an ACCOUNT, nothing more. The grant is still looked up
         * against that account and re-checked for liveness, cap and expiry
         * below, so this widens who may ask — never what they may spend.
         */
        const trusted = typeof req.trustedAccountId === "string" ? req.trustedAccountId : null;
        const acct = trusted
          ? this.accounts.accountById(trusted)
          : this.accounts.sessionAccount(String(b.sessionToken || ""));
        if (!acct) {
          return this._json(res, 401, { error: { message: "sign in again — that session is not valid", type: "invalid_request_error" } });
        }
        let g;
        try {
          g = this.accounts.spendableGrant(acct.id, String(b.grantId || ""));
        } catch (e) {
          return this._json(res, e.status === 404 ? 404 : 403, { error: { message: String(e.message), type: "invalid_request_error" } });
        }
        b.address = g.address; // the ledger stays address-keyed
        grantCharge = { grantId: g.grantId, remainingMicro: g.remainingMicro };
      } else if (!b.address || !b.signature || !b.ts) {
        return this._json(res, 401, {
          error: { message: "Koinos Network requests are signed by your earning account — update the app and unlock your wallet", type: "invalid_request_error" },
        });
      }
      if (!grantCharge && Math.abs(Date.now() - Number(b.ts)) > CONSUME_SIG_WINDOW_MS) {
        return this._json(res, 401, { error: { message: "stale request signature — check this machine's clock", type: "invalid_request_error" } });
      }
      if (!grantCharge) {
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
      }
      /*
       * A GRANTED request must be BOUNDED before it runs.
       *
       * The wallet path can overdraft: a worker's overspend lands on its epoch
       * earnings and settles. A web user has no earnings — their overdraft
       * becomes `debts`, which closeEpoch records, reports, and then WIPES
       * with no carry-forward. That is money spent that nobody collects, and
       * the existing gate (a bare "> 0" with the cost known only afterwards)
       * lets one micro-dollar authorize an arbitrarily expensive request.
       *
       * So on this path max_tokens is REQUIRED and the worst case is priced
       * against what the grant has left. Refusing up front is the only honest
       * option — there is nothing to claw back afterwards.
       */
      if (grantCharge) {
        const wantTok = Math.floor(Number(b.max_tokens ?? b.maxTokens ?? 0));
        if (!Number.isFinite(wantTok) || wantTok <= 0) {
          return this._json(res, 400, {
            error: { message: "max_tokens is required when spending through a grant, so the cost can be bounded before the request runs", type: "invalid_request_error" },
          });
        }
        if (wantTok > GRANT_MAX_TOKENS_CEIL) {
          return this._json(res, 400, {
            error: { message: `max_tokens above ${GRANT_MAX_TOKENS_CEIL} is refused on a granted request`, type: "invalid_request_error" },
          });
        }
        const rate = MODEL_RATES[b.model] || MODEL_RATES[DEFAULT_MODEL_CLASS];
        const promptTok = JSON.stringify(b.messages || "").length / 3; // generous
        const worstMicro = Math.ceil((promptTok * rate.inMicroPerM + wantTok * rate.outMicroPerM) / 1e6);
        /*
         * HOLD the worst case, do not merely compare against it (FIND-FIN-001).
         *
         * The bound above was already correct and already computed. What it
         * was not was a reservation: every concurrent request read the same
         * remainingMicro, every one of them passed, and every one of them ran.
         * The ledger stayed inside the cap afterwards — chargeGrant is guarded
         * in SQL — but the compute had happened and the workers were owed for
         * it, which is the cap being exceeded in the only sense that costs
         * anybody anything.
         *
         * chargeGrant is a single conditional UPDATE, so taking the hold here
         * is the same atomic operation that used to book the cost. Whatever
         * the request does not spend is handed straight back below.
         */
        try {
          this.accounts.chargeGrant(grantCharge.grantId, worstMicro);
        } catch {
          return this._json(res, 402, {
            error: {
              message: `this request could cost up to $${(worstMicro / 1e6).toFixed(4)} and the spending grant has $${(grantCharge.remainingMicro / 1e6).toFixed(4)} left — lower max_tokens or raise the grant`,
              type: "insufficient_quota",
            },
          });
        }
        grantCharge.worstMicro = worstMicro;
        grantCharge.heldMicro = worstMicro;
        /*
         * The hold must come back on EVERY ending, not just the happy one —
         * a 503 with no providers, a 504 nobody answered, a client that closes
         * the tab mid-stream. The response ends exactly once on all of those,
         * so that is where the backstop lives. Settling first (below) makes
         * this a no-op; it only ever fires when nothing else did.
         */
        res.on("close", () => {
          try { this._settleGrantHold(grantCharge, 0); } catch { /* grant gone */ }
        });
      }

      // §20: payment authorization BEFORE execution. Free allowance, then
      // deposited KAI credits, then current-epoch earnings must cover the CU.
      await this._syncDeposits(b.address);
      const clientIp = this._clientIp(req);
      const cap = this._consumeCapacity(b.address, clientIp);
      if (cap.freeTokensLeft <= 0 && cap.balanceMicro <= 0n && cap.earningsLeftSat <= 0n) {
        // Distinguish the network-wide free cap from a personal one so the
        // user isn't told "insufficient balance" when the whole network's
        // daily free budget is simply spent. Local AI and paid usage are
        // unaffected either way — only PUBLIC free inference pauses.
        this._rollFreeDay();
        const globalExhausted =
          this.freeTokensPerDayGlobal > 0 && this.freeUsedGlobalDay >= this.freeTokensPerDayGlobal;
        return this._json(res, 402, {
          error: {
            message: globalExhausted
              ? "The Koinos Network's free allowance for today is used up. It resets at 00:00 UTC. " +
                "You can keep going now by adding KAI in the Earn tab or pressing Start Earning — " +
                "and local AI on your own machine is always free."
              : "Insufficient balance: network usage is billed per AI token after the free allowance. " +
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
      const busy = this._busySet();
      const live = [...this.workers.values()].filter((x) => Date.now() - x.lastSeen < 90000 || busy.has(x.address));
      let model = requested;
      if (requested === "auto") {
        // Quality-first: the priciest (largest) rated class a live worker
        // advertises; legacy workers with no advertisement hold dev-tiny
        // and never win auto. §51 phase 2: workers on probation (mostly
        // failing, server-observed) don't get to define "best" — auto only
        // considers their classes when nobody healthy serves anything.
        const healthy = live.filter((x) => !this._onProbation(x.address));
        const pickFrom = healthy.length > 0 ? healthy : live;
        model =
          Object.entries(MODEL_RATES)
            .sort((a, z) => z[1].outMicroPerM - a[1].outMicroPerM)
            .map(([name]) => name)
            .find((name) => pickFrom.some((x) => this._canServe(x, { model: name }))) || null;
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
      /*
       * "Run this on my own machine."
       *
       * The ledger is address-keyed and a spend grant carries the wallet that
       * signed it, so the consumer address IS the user's wallet — and their
       * desktop node registers as a worker under that same wallet. Self-serve
       * is therefore not a new trust relationship to invent: it is the single
       * condition `worker.address === b.address`, already proven by a
       * signature on both sides.
       *
       * Checked BEFORE the job is created, and refused rather than quietly
       * falling back to the paid network: someone who asked to use their own
       * hardware and got billed for someone else's would rightly call that a
       * bug, whatever the fallback cost them.
       */
      let selfServed = false;
      if (b.selfHost) {
        const mine = live.find((x) => x.address === b.address && this._canServe(x, { model }));
        if (!mine) {
          return this._json(res, 409, {
            error: {
              message:
                `Your machine isn't available to serve "${model}" right now — it needs the Koinos AI ` +
                "app open, Start Earning switched on, and that model downloaded. Nothing was charged.",
              type: "invalid_request_error",
            },
          });
        }
        selfServed = true;
      }
      const job = this.enqueue({
        type: "chat", cu: 1, messages: b.messages, model,
        ...(selfServed ? { forWorker: b.address, selfServed: true } : {}),
      });
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
      /*
       * Your own machine, your own electricity, your own request: no value
       * moved, so nothing is billed and no free-tier allowance is consumed.
       * Deliberately NOT "paid with earnings" — that would run a real charge
       * through the ledger and back, which is both pointless and a way to
       * quietly spend a grant the user believed they were avoiding.
       */
      const { paidWith, costMicro, freeTaken, totalTok } = selfServed
        ? {
            paidWith: "your own machine",
            costMicro: 0n,
            freeTaken: 0,
            totalTok:
              Math.max(0, Number(result.usage?.prompt_tokens ?? 0)) +
              Math.max(0, Number(result.usage?.completion_tokens ?? 0)),
          }
        : this._chargeUsage(b.address, result.usage, clientIp, model);
      /*
       * Settle against the hold taken before the request ran. The ACTUAL cost
       * is what is kept — the worst case exists to bound the request, not to
       * charge for tokens nobody generated — and the rest is returned, so the
       * grant reads correctly the moment this answer lands.
       */
      this._settleGrantHold(grantCharge, Number(costMicro));
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
      // Durable spend-vs-earnings consistency (review finding, CRITICAL): the
      // balance debit above was already durable (_saveBalances inside
      // _chargeUsage), but spentSat / the freeTok receipt stamp lived only in
      // memory until the NEXT receipt push. A hard kill (OOM/SIGKILL — the
      // exit handler never runs) in that window resumed the epoch with full
      // receipts against a stale spend counter: the consumer's charge erased,
      // its earnings resurrected — an over-mint. Persist the epoch state in
      // the same breath as the charge so durable spend never lags durable
      // receipts.
      this._persist();
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
            // What this answer actually cost, and out of which pocket.
            // Somebody paying per token should be able to see the price of
            // the thing they just bought, at the moment they bought it —
            // a total on a separate page is an invoice, not a price tag.
            costUsd: Number(costMicro) / 1e6,
            paidWith,
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
        // Same as the streaming path's final frame: the price of THIS call,
        // and which pocket it came out of. Additive, so an older client that
        // does not know the field simply ignores it.
        costUsd: Number(costMicro) / 1e6,
        paidWith,
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
      if (!this._operatorAuthed(req, res)) return;
      const b = await this._body(req);
      const sha = String(b.sha256 || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha)) {
        return this._json(res, 400, { ok: false, error: "sha256 (64 hex chars) required" });
      }
      this.revoked[sha] = { reason: String(b.reason || "revoked by operator"), at: new Date().toISOString() };
      this.store.saveRevoked(this.revoked);
      this.onEvent({ type: "scheduler:package-revoked", sha256: sha });
      return this._json(res, 200, { ok: true, revoked: Object.keys(this.revoked).length });
    }

    if (url.pathname === "/operator/unrevoke" && req.method === "POST") {
      if (!this._operatorAuthed(req, res)) return;
      const b = await this._body(req);
      delete this.revoked[String(b.sha256 || "").toLowerCase()];
      this.store.saveRevoked(this.revoked);
      return this._json(res, 200, { ok: true, revoked: Object.keys(this.revoked).length });
    }

    if (url.pathname === "/operator/enqueue" && req.method === "POST") {
      if (!this._operatorAuthed(req, res)) return;
      const b = await this._body(req);
      return this._json(res, 200, { ok: true, job: { id: this.enqueue(b).id } });
    }

    if (url.pathname === "/epoch/close" && req.method === "POST") {
      if (!this._operatorAuthed(req, res)) return;
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
      if (!this._operatorAuthed(req, res)) return;
      return this._json(res, 200, { ok: true, epochs: this.store.listEpochSummaries() });
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
        freeTokensPerDay: this.freeTokensPerDay,
        freeTokensPerDayGlobal: this.freeTokensPerDayGlobal,
        bootstrapPoolKaiPerEpoch: Number(this.bootstrapPoolSat) / 1e8,
        bootstrapPoolKaiPerDay: (Number(this.bootstrapPoolSat) / 1e8) * EPOCHS_PER_DAY,
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
      let pendingSat = this._settleFor(mine, this._networkSubsidyBudget()).workerSat - BigInt(this.spentSat[address] || "0");
      if (pendingSat < 0n) pendingSat = 0n;
      const u = this.usage[address] || { inTok: 0, outTok: 0, costMicro: 0 };
      const meter = {
        pendingReceipts,
        tokensProcessed,
        pendingKai: (Number(pendingSat) / 1e8).toFixed(8),
        requestsThisEpoch: this.consumed[address] || 0,
        usage: { inputTokens: u.inTok, outputTokens: u.outTok, costUsd: (u.costMicro / 1e6).toFixed(6) },
        freeTokensRemaining: this._freeTokensLeft(address, null),
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
      if (!this._operatorAuthed(req, res)) return;
      const b = await this._body(req);
      const stored = this.store.readEpoch(b.epoch);
      if (!stored) {
        return this._json(res, 404, { ok: false, error: `no stored epoch ${b.epoch}` });
      }
      if (!stored.summary) return this._json(res, 400, { ok: false, error: "epoch not closed" });
      const result = await this.settleClosedEpoch(stored.summary);
      return this._json(res, 200, { ok: true, epoch: stored.summary.epoch, settlement: result });
    }

    return this._json(res, 404, { ok: false, error: "not found" });
  }

  _passesChallenge(challenge, output) {
    // Deterministic evals use temperature 0; norm makes multi-part answers
    // robust to separators ("7, 15, 23" and "7 15 23" normalize alike).
    //
    // Anti-answer-bank (review CRITICAL): a plain `output.includes(expected)`
    // is defeated by dumping every possible answer ("...94 95 96 97..."). So
    // the expected token must also DOMINATE the reply — the normalized
    // output may carry at most a little more than the answer itself. A model
    // told "reply with just the number" and answering "97" passes; a span
    // dump carrying dozens of numbers does not. Honest chatter ("The answer
    // is 97.") still passes because the slack is generous but bounded.
    const raw = String(output ?? "");
    let out = raw;
    let expected = String(challenge.expected);
    if (challenge.norm === "digits") {
      out = raw.replace(/[^0-9]/g, "");
      expected = expected.replace(/[^0-9]/g, "");
    } else if (challenge.norm === "letters") {
      out = raw.replace(/[^a-z]/gi, "").toUpperCase();
      expected = expected.replace(/[^a-z]/gi, "").toUpperCase();
    }
    if (!out.includes(expected)) return false;
    // Dominance defeats the answer-bank attack ("...94 95 96 97..."), but
    // ONLY for normalized challenges — those ask for a terse answer, so the
    // normalized reply is close to the answer itself. Un-normalized enforced
    // challenges (e.g. "capital of France") keep the lenient includes so a
    // chatty honest model is never falsely failed. digits: the alphabet is
    // only 10 symbols, so the bound is tight (a full 0-9 dump must fail);
    // letters: 26 symbols, a looser bound still rejects an A-Z dump.
    if (!challenge.norm) return true;
    const slack = challenge.norm === "digits" ? expected.length + 6 : expected.length + 12;
    return out.length <= slack;
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

  /** The protocol-funded (bootstrap-drawing) value of ONE honest receipt in
   *  satoshis: a flat 1 KAI for an eval/verification receipt, or the free-
   *  allowance fraction of a chat receipt. Paid chat value is NOT here — it
   *  is real revenue and never draws on the pool. */
  _subsidyValueSat(r) {
    if (r.jobType !== "chat") return RECEIPT_KAI_SAT;
    const valueSat = BigInt(usageCostMicro(r.usage, r.modelClass)) * this.price.satPerMicro;
    return this._chatSubsidySat(r, valueSat);
  }

  /** The network-wide bootstrap budget for an epoch: the fixed pool and the
   *  epoch's total useful-work demand on it. `_settleFor` divides the pool
   *  across that demand (pro-rata when demand exceeds the pool, in full with
   *  the remainder left in reserve when it does not). Computed over ALL
   *  honest receipts so every worker settles at the same network scale.
   *  NOTE: because the divisor is network demand, a worker's pro-rata share
   *  can DROP as others submit receipts later in the epoch. /balance's
   *  pending is therefore a live estimate at the current demand, exact only
   *  at the instant of close (when the receipt set freezes) — it is NOT a
   *  monotonic guarantee. Consumption is authorized against the guaranteed
   *  floor instead (see _consumeCapacity), never this scaling estimate. */
  _networkSubsidyBudget(receipts = this.receipts) {
    // §7.4 GATE (only when armed): each worker's protocol-funded demand is
    // weighted by its eligibility elig(r)^γ in parts-per-million, so a
    // below-gate worker contributes zero demand and draws zero pool. The SAME
    // weights are handed to _settleFor via the budget object so demand and
    // mint always use one consistent scale. Unarmed: weights absent, flat
    // pro-rata — bit-identical to the pre-gate scheduler.
    let eligPpmByAddr = null;
    if (this.reputationEnforce) {
      eligPpmByAddr = {};
      const now = Date.now();
      for (const r of receipts) {
        if (eligPpmByAddr[r.worker] == null) {
          eligPpmByAddr[r.worker] = BigInt(Math.round(clamp01(this._reputation(r.worker, now).elig) * 1e6));
        }
      }
    }
    let demandSat = 0n;
    for (const r of receipts) {
      if (!r.honest) continue;
      const v = this._subsidyValueSat(r);
      demandSat += eligPpmByAddr ? (v * eligPpmByAddr[r.worker]) / 1000000n : v;
    }
    return { poolSat: this.bootstrapPoolSat, demandSat, eligPpmByAddr };
  }

  /**
   * Settle ONE worker's honest receipts against the NETWORK-WIDE bootstrap
   * pool (owner decision): paid chat value always mints; protocol-funded
   * value (eval subsidies + the free-allowance fraction of chat receipts) is
   * scaled by the pool ÷ network demand, so total protocol mint across all
   * workers never exceeds the pool and unused budget stays in reserve. Pass
   * the SAME budget object to every per-worker call in one settlement so they
   * share one scale; /balance passes a live budget (a mid-epoch estimate that
   * reconciles with closeEpoch only when the receipt set is frozen at close).
   * Splits (§20) divide only the PAID fraction — minted subsidy passes
   * through to compute whole. NOTE: this bounds TOTAL
   * emission but not any one actor's SHARE — Sybil distribution resistance is
   * a separate, still-open design item (needs staking/attestation/reputation).
   */
  _settleFor(receipts, budget = this._networkSubsidyBudget()) {
    const out = {
      workerSat: 0n,
      royaltyByAddr: {},
      treasurySat: 0n,
      splitTotals: { computeSat: 0n, royaltySat: 0n, verifySat: 0n, protocolSat: 0n },
      subsidyMintedSat: 0n,
      subsidyCappedSat: 0n,
    };
    const { poolSat, demandSat, eligPpmByAddr } = budget;
    // Exact integer pro-rata: below-pool demand mints in full; above-pool
    // demand mints its share of the pool (floored per item — the tiny
    // remainder stays unminted in reserve, never over-emitted). With the §7.4
    // gate armed, each receipt's subsidy value is first scaled by its worker's
    // eligibility (ppm) — the same weights the budget's demand used — so a
    // below-gate worker's protocol-funded value mints zero while its PAID
    // value (never in this pool) flows untouched: equal work, equal pay.
    const weigh = (full, worker) =>
      eligPpmByAddr ? (full * (eligPpmByAddr[worker] ?? 0n)) / 1000000n : full;
    const minted = (full) => (demandSat > poolSat ? (full * poolSat) / demandSat : full);
    for (const r of receipts) {
      if (r.jobType !== "chat") {
        const value = RECEIPT_KAI_SAT;
        const m = minted(weigh(value, r.worker));
        out.workerSat += m;
        out.subsidyMintedSat += m;
        out.subsidyCappedSat += value - m;
        continue;
      }
      const valueSat = BigInt(usageCostMicro(r.usage, r.modelClass)) * this.price.satPerMicro;
      const subsidySat = this._chatSubsidySat(r, valueSat);
      const paidSat = valueSat - subsidySat;
      const allowedSat = minted(weigh(subsidySat, r.worker));
      out.subsidyMintedSat += allowedSat;
      out.subsidyCappedSat += subsidySat - allowedSat;
      // §20 (owner decision 2026-08-19): role shares divide the PAID fraction
      // only. The minted subsidy is protocol emission that funds providers —
      // it passes through to compute whole, so a free-tier chat loses nothing
      // to the treasury or a royalty route. Pinned by probe-splits.js §6.
      const s = this._splitValueSat(paidSat, r.modelClass);
      out.workerSat += s.computeSat + allowedSat;
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
    // Eval fairness counters are per-epoch: reset so the least-served-first
    // rotation starts level each epoch (a lifetime counter would hand every
    // seed to each new joiner for hours until it "caught up"). Mystery-chat
    // audit budgets reset with them.
    for (const w of this.workers.values()) {
      w.seedsThisEpoch = 0;
      w.mystThisEpoch = 0;
    }
    const served = {};
    const byWorker = {};
    const chatByAddr = {}; // §7.4 reputation: real paid demand served this epoch
    for (const r of this.receipts) {
      if (!r.honest) continue;
      served[r.worker] = (served[r.worker] || 0) + 1;
      (byWorker[r.worker] ||= []).push(r);
      // Only GENUINELY PAID chats count as paid demand — a fully free-tier
      // (subsidized) chat has zero paid value and must not pump the signal, or
      // a self-dealer could farm it for free (review finding). Same paid/free
      // split settlement uses: paid = value − free-allowance subsidy.
      if (r.jobType === "chat") {
        const valueSat = BigInt(usageCostMicro(r.usage, r.modelClass)) * this.price.satPerMicro;
        if (valueSat - this._chatSubsidySat(r, valueSat) > 0n) chatByAddr[r.worker] = (chatByAddr[r.worker] || 0) + 1;
      }
    }
    // Accrue the durable paid-demand counter the shadow reputation reads, and
    // persist once (not per-receipt) so a reboot keeps the history. Counting
    // only paid chats makes this Sybil-HARD: manufacturing it costs real spend,
    // not a free self-request. It strengthens as real paid usage grows.
    if (Object.keys(chatByAddr).length) {
      for (const w of this.workers.values()) {
        const c = chatByAddr[w.address];
        if (c) w.repPaidJobs = numOr(w.repPaidJobs, 0) + c;
      }
    }
    // (Workers/perf persistence moved to the grouped commit at the close tail —
    // in sqlite mode the whole close persists in ONE transaction.)
    // One settlement walk per worker against the network-wide bootstrap
    // POOL. The budget (pool + total epoch demand) is computed ONCE over all
    // honest receipts, so every worker settles at the same pool÷demand scale.
    // §20: the non-compute shares accrue to their role addresses and settle
    // as ordinary claims in the SAME epoch tree — claim_value mints a
    // treasury or royalty leaf exactly like a worker leaf, so the split
    // needs no contract change and inherits the Merkle audit trail.
    const budget = this._networkSubsidyBudget();
    const earnedSat = {};
    const splitTotals = { computeSat: 0n, royaltySat: 0n, verifySat: 0n, protocolSat: 0n };
    const bootstrap = { mintedSat: 0n, cappedSat: 0n };
    for (const [w, rs] of Object.entries(byWorker)) {
      const st = this._settleFor(rs, budget);
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
        freeTokensPerDay: this.freeTokensPerDay,
        freeTokensPerDayGlobal: this.freeTokensPerDayGlobal,
      },
      perf: JSON.parse(JSON.stringify(this.perf)), // §51 CU capability snapshot (rolling, not reset)
      // §7.4 SHADOW: per-worker reputation at close, recorded for calibration.
      // Purely observational — nothing above consumed it; settlement ignored it.
      reputationShadow: Object.fromEntries([...this.workers.values()].map((w) => [w.address, this._reputation(w.address, Date.now(), w)])),
      // §7.4 signal #3 SHADOW: device-fingerprint collision groups at close —
      // {fingerprint: [addresses]} for every fingerprint two or more wallets
      // share. Feeds the gate-decision calibration next to reputationShadow.
      fingerprintGroups: (() => {
        const byFp = {};
        for (const w of this.workers.values()) {
          if (!w.fingerprint) continue;
          (byFp[w.fingerprint] ??= new Set()).add(w.address);
        }
        return Object.fromEntries(
          Object.entries(byFp).filter(([, set]) => set.size > 1).map(([fp, set]) => [fp, [...set].sort()])
        );
      })(),
      bootstrap: {
        // §54: protocol-funded value spent from the NETWORK-WIDE pool this
        // epoch (eval subsidies + the free-allowance fraction of chat value)
        // vs what the pool couldn't cover. cappedSat > 0 means demand
        // exceeded the pool and every subsidy was scaled down pro-rata;
        // unused pool is simply not minted (stays in reserve).
        poolSat: this.bootstrapPoolSat.toString(),
        mintedSat: bootstrap.mintedSat.toString(),
        cappedSat: bootstrap.cappedSat.toString(),
      },
      splits: {
        // §20 policy + how this epoch's paid chat value actually divided.
        // compute+royalty+verification+protocol always equals the epoch's
        // PAID chat value exactly (compute takes every rounding remainder);
        // minted subsidy is reported under `bootstrap`, never split.
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
    // The close's full persistence — settled epoch, worker roster (repPaidJobs
    // just accrued), rolling perf, free-day counters — lands as ONE group. In
    // sqlite mode that is one transaction: a crash mid-close can never leave
    // the summary written but the counters unbumped (or vice versa). STRICT
    // (review finding): the store calls run raw here — no inner catches — so
    // a disk/DB failure is OBSERVED, marks the summary unpersisted, and
    // settlement is withheld. Otherwise a close could anchor claims on-chain
    // while the disk still says "unsettled"; the next boot would resume and
    // re-close the same receipts against the already-anchored epoch number,
    // poisoning it (root mismatch -> permanently unclaimable earnings).
    summary.persisted = true;
    try {
      this.store.transaction(() => {
        this.store.saveEpoch(this.epoch, this._epochPayload(summary));
        this.store.saveWorkers(Object.fromEntries(this.workers));
        this.store.savePerf(this.perf);
        this.store.saveFreeDay({ day: this.freeDay, byAddr: this.freeUsedByDay, global: this.freeUsedGlobalDay, byIp: this.freeUsedByIp });
      });
    } catch (e) {
      summary.persisted = false;
      this.onEvent({ type: "scheduler:persist-failed", epoch: this.epoch, message: String(e && e.message).slice(0, 200) });
    }
    if (this.store.mode === "sqlite") {
      // Refresh the derived JSON views so file-reading tooling (backups,
      // operator export, shadow-trends) stays current. Views only — the DB
      // committed above and remains the authority on boot.
      try { this.store.exportViews(); } catch { /* best-effort */ }
    }
    this.epoch = Math.max(this.epoch + 1, Math.floor(Date.now() / 60000));
    this.receipts = [];
    this.consumed = {};
    this.usage = {};
    this.spentSat = {};
    // NOTE: free-tier counters are DAILY (freeUsedByDay / freeUsedGlobalDay /
    // freeUsedByIp) and roll on the UTC day in _rollFreeDay — a 15-min epoch
    // close must NOT reset them (that was the 96×-too-loose bug).
    // §51 epoch pricing: pin the NEXT epoch to the oracle's current state,
    // then poll sources in the background for the close after that. Prices
    // therefore move only on epoch boundaries, one smoothed step at a time.
    this.price = this.oracle.snapshot();
    this.refreshPrice().catch(() => {});
    this.onEvent({ type: "scheduler:epoch-closed", ...summary });
    return summary;
  }

  _epochPayload(summary) {
    return {
      epoch: this.epoch,
      receipts: this.receipts,
      // Mid-epoch consumption state rides along so a restart can RESUME
      // this epoch instead of abandoning it (see the constructor's
      // recovery block): what each consumer spent from epoch earnings,
      // and the request/usage tallies the close summary reports.
      spentSat: this.spentSat,
      consumed: this.consumed,
      usage: this.usage,
      // The price this epoch OPERATED under (review finding): billing inside
      // the epoch used this rate, so a resumed close must settle at it too —
      // otherwise per-epoch price pinning breaks across a restart and a
      // re-closed epoch could even compute a different Merkle root than one
      // already anchored. BigInts ride as strings.
      price: {
        usd: this.price.usd,
        microPerKai: String(this.price.microPerKai),
        satPerMicro: String(this.price.satPerMicro),
        updatedAt: this.price.updatedAt ?? null,
      },
      summary: summary ?? null,
    };
  }

  _persist(summary) {
    try {
      this.store.saveEpoch(this.epoch, this._epochPayload(summary));
    } catch {
      /* per-receipt persistence is best-effort — the close is strict */
    }
  }

  /** §20–§22: push a closed epoch on-chain (root + every worker's claim).
   *  The result — tx ids or the error — lands in the epoch file so
   *  /operator/epochs shows settlement state. Safe to re-run. */
  async settleClosedEpoch(summary) {
    if (!this.settlement || !summary || !summary.receipts) return null;
    // Never anchor an epoch whose summary did not durably persist (review
    // finding): the disk still says "unsettled", so a restart would resume
    // and re-close those receipts against the anchored number. Withhold; the
    // resume path re-settles them cleanly under the SAME number later.
    if (summary.persisted === false) {
      this.onEvent({ type: "scheduler:settle-withheld", epoch: summary.epoch, reason: "summary not durably persisted" });
      return null;
    }
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
      const j = this.store.readEpoch(summary.epoch) || {};
      j.epoch = summary.epoch;
      j.summary = summary;
      this.store.saveEpoch(summary.epoch, j);
    } catch {
      /* best-effort */
    }
    return result;
  }

  /** Boot repair (review finding): a crash BETWEEN a successful summary
   *  persist and the async on-chain settlement left the epoch settled locally
   *  but never anchored — and nothing retried it. Scan the most recent closed
   *  epochs for summary-without-settlement and re-run settlement (idempotent:
   *  the chain client checks the existing root before submitting). */
  async recoverPendingSettlements(maxScan = 20) {
    if (!this.settlement) return 0;
    let retried = 0;
    try {
      const summaries = this.store.listEpochSummaries().slice(-maxScan);
      for (const s of summaries) {
        if (s && s.receipts && !s.settlement) {
          await this.settleClosedEpoch(s);
          retried += 1;
        }
      }
    } catch {
      /* best-effort repair — never block boot */
    }
    return retried;
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
    this.recoverPendingSettlements().catch(() => {}); // anchor anything a crash stranded
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve(this.server.address().port));
    });
  }

  close() {
    if (this._onExit) {
      process.removeListener("exit", this._onExit);
      this._onExit = null;
    }
    for (const w of this.waiters.splice(0)) w.fire();
    return new Promise((resolve) => {
      const done = () => {
        try { this.store.close(); } catch { /* already closed */ }
        resolve();
      };
      if (!this.server) return done();
      this.server.closeAllConnections?.();
      this.server.close(done);
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
 *  workers always have work. Plain prompts only — hidden known-answer
 *  challenges are GENERATED per seed (§17, makeChallenge), never drawn from
 *  a fixed pool a dishonest client could hardcode. */
const SEED_PROMPTS = [
  { prompt: "What is 2+2? Reply with just the number." },
  { prompt: "Name the capital of France in one word." },
  { prompt: "Write one short sentence about local AI." },
];

/** §17: which challenge tier a class's size earns. Tier 1 is universal;
 *  tier 2 needs a competent mid model (≥12GB classes); tier 3 (≥24GB) is
 *  the class-discriminating band — multi-step precision tasks the CPU-tier
 *  toy models in docs/benchmarks demonstrably fumble. */
function challengeTier(model) {
  const ram = MODEL_RATES[model]?.minRamGb || 4;
  return ram >= 24 ? 3 : ram >= 12 ? 2 : 1;
}

/** §17 deepened challenges: generated with randomized content so there is
 *  nothing to memorize — answering requires actually running a model (or
 *  building a solver, which is a far higher bar than replaying five known
 *  strings). Tiered by the class's size: tiers 1–2 must be comfortably
 *  solvable at temperature 0 by the WEAKEST honest model of that class —
 *  the target is a machine serving no real model, never an honest small
 *  one (a false "dishonest" verdict burns a real tester's earnings and
 *  success rate). Tier 3 exists to catch a SMALL model answering for a BIG
 *  class, so it is deliberately harder — and therefore ships in SHADOW
 *  mode (pass rates recorded, nothing punished) until field baselines
 *  prove honest big models pass reliably. Expected answers never leave
 *  the scheduler. */
function makeChallenge(model) {
  const ri = (n) => Math.floor(Math.random() * n);
  const tier = challengeTier(model);
  const kinds = [
    () => {
      const a = 2 + ri(30), b = 2 + ri(30);
      return { prompt: `What is ${a}+${b}? Reply with just the number.`, expected: String(a + b), challengeTier: 1 };
    },
    () => {
      const pairs = [
        ["France", "Paris"], ["Japan", "Tokyo"], ["Italy", "Rome"], ["Germany", "Berlin"],
        ["Spain", "Madrid"], ["Egypt", "Cairo"], ["Norway", "Oslo"], ["Portugal", "Lisbon"],
      ];
      const [country, capital] = pairs[ri(pairs.length)];
      return { prompt: `Name the capital of ${country} in one word.`, expected: capital, challengeTier: 1 };
    },
  ];
  if (tier >= 2) {
    kinds.push(() => {
      const a = 2 + ri(11), b = 2 + ri(11);
      return { prompt: `What is ${a}*${b}? Reply with just the number.`, expected: String(a * b), challengeTier: 2 };
    });
    kinds.push(() => {
      const words = ["river", "candle", "mountain", "bottle", "forest", "window", "garden", "bridge"];
      const w = words[ri(words.length)];
      return { prompt: `Write the word "${w}" in all capital letters, no spaces.`, expected: w.toUpperCase(), challengeTier: 2 };
    });
  }
  if (tier >= 3) {
    // Class discriminators: multi-step precision. A 0.5–2B substitute
    // reliably fumbles these at temp 0; a real ≥24GB model does not.
    // Shadow-mode data decides when these start to bite.
    kinds.push(() => {
      const words = ["candle", "forest", "bridge", "window", "lantern", "meadow"];
      const w = words[ri(words.length)];
      const expected = w.split("").reverse().join("").toUpperCase();
      return {
        prompt: `Reverse the word "${w}" and write the result in all capital letters. Reply with only the result.`,
        expected,
        norm: "letters",
        challengeTier: 3,
      };
    });
    kinds.push(() => {
      const nums = [];
      while (nums.length < 4) {
        const n = 3 + ri(90);
        if (!nums.includes(n)) nums.push(n);
      }
      const sorted = [...nums].sort((a, z) => a - z);
      return {
        prompt: `Sort these numbers from smallest to largest: ${nums.join(", ")}. Reply with only the sorted numbers, separated by commas.`,
        expected: sorted.join(""),
        norm: "digits",
        challengeTier: 3,
      };
    });
    kinds.push(() => {
      const bank = ["orange", "tiger", "echo", "lantern", "maple", "stone", "violet", "ember"];
      const pick = [];
      while (pick.length < 4) {
        const w = bank[ri(bank.length)];
        if (!pick.includes(w)) pick.push(w);
      }
      const expected = pick.map((w) => w[0]).join("").toUpperCase();
      return {
        prompt: `Take the first letter of each word, in order: ${pick.join(" ")}. Reply with only those letters, together, in capital letters.`,
        expected,
        norm: "letters",
        challengeTier: 3,
      };
    });
  }
  return kinds[ri(kinds.length)]();
}

/** §17 paid-path audit: one protocol-funded chat that LOOKS like a real
 *  consumer chat — same type, same messages shape, and give() strips every
 *  server-side field, so even a modified client cannot tell it from paid
 *  work. Because chat runs at temperature 0.7 (non-deterministic), the
 *  hidden check is a high-tolerance one: small arithmetic whose answer
 *  substring survives any phrasing. Failing it is enforced immediately —
 *  a machine that can't add two numbers on the paid path is not serving a
 *  model. Bounded per worker per epoch; settles as protocol subsidy under
 *  the §54 bootstrap cap (an unbilled chat receipt is fully subsidized by
 *  construction). */
/** A paid-path audit prompt that reads like an ordinary short user chat,
 *  drawn from several shapes so it is not one memorizable regex. Every
 *  answer is a short, phrasing-robust token an honest model of any class
 *  produces at temperature 0.7. Shadow-mode, so the bar is "clean baseline"
 *  not "airtight" — a determined cheat still needs to actually answer, and
 *  the dominance check (see _passesChallenge) rejects answer-bank dumps. */
function makeMysteryPrompt() {
  const ri = (n) => Math.floor(Math.random() * n);
  // Every prompt asks for a terse answer, so a compliant honest reply
  // normalizes close to the expected token (dominance-safe) while an
  // answer-bank dump is rejected.
  const shapes = [
    () => {
      const a = 2 + ri(20), b = 2 + ri(20);
      const phr = [
        `What is ${a} plus ${b}? Just the number, please.`,
        `Add ${a} and ${b}. Reply with only the number.`,
        `${a} + ${b} = ? Answer with the number only.`,
      ][ri(3)];
      return { prompt: phr, expected: String(a + b), norm: "digits" };
    },
    () => {
      const facts = [
        ["What color is a clear daytime sky? One word.", "blue"],
        ["What is the opposite of hot? One word.", "cold"],
        ["What is the first month of the year? One word.", "january"],
        ["What do bees make? One word.", "honey"],
        ["What is frozen water called? One word.", "ice"],
        ["What sound does a dog make? One word.", "bark"],
      ];
      const f = facts[ri(facts.length)];
      return { prompt: f[0], expected: f[1], norm: "letters" };
    },
    () => {
      const pairs = [["cat", "cats"], ["dog", "dogs"], ["book", "books"], ["star", "stars"], ["tree", "trees"]];
      const [s, p] = pairs[ri(pairs.length)];
      return { prompt: `What is the plural of "${s}"? Reply with one word.`, expected: p, norm: "letters" };
    },
  ];
  return shapes[ri(shapes.length)]();
}

function seedMysteryOnce(sched) {
  const now = Date.now();
  const busy = sched._busySet(now);
  // Guarded: a malformed env value must fall back to the default, never NaN
  // (which would make every `< cap` comparison false and silently disable
  // the audit — review finding).
  const capRaw = Number(process.env.KAI_MYSTERY_CAP_PER_EPOCH);
  const cap = Number.isFinite(capRaw) && capRaw >= 0 ? capRaw : 3;
  const eligible = [...sched.workers.values()].filter(
    (w) =>
      now - w.lastSeen < 90000 &&
      !busy.has(w.address) &&
      Array.isArray(w.models) &&
      w.models.length > 0 &&
      (w.mystThisEpoch || 0) < cap
  );
  if (eligible.length === 0) return null;
  if (sched.queue.length + sched.pending.size >= 3) return null;
  const target = eligible[Math.floor(Math.random() * eligible.length)];
  const model = target.models[Math.floor(Math.random() * target.models.length)];
  target.mystThisEpoch = (target.mystThisEpoch || 0) + 1;
  // Diversified so the audit is not one fixed regex (review finding). Small
  // operands / everyday facts so an honest model of ANY class answers even
  // at temperature 0.7 — this rides the paid path in SHADOW mode, so a miss
  // is only recorded, but keeping it easy keeps the recorded baseline clean.
  const c = makeMysteryPrompt();
  return sched.enqueue({
    type: "chat",
    model,
    messages: [{ role: "user", content: c.prompt }],
    expected: c.expected,
    ...(c.norm ? { norm: c.norm } : {}),
    challengeTier: 0, // tier 0 = paid-path mystery (shadow)
    forWorker: target.address,
  });
}

/** One fair eval seed (field feedback: first-active/first-model picking
 *  starved every worker but one at 0 jobs). Workers take turns by fewest
 *  evals received this epoch; within a worker, its models rotate so every
 *  class it serves gets exercised. The job is stamped for its target so a
 *  faster poller can't take it — the stamp releases if the target leaves. */
function seedOnce(sched) {
  const now = Date.now();
  // Busy counts as live (matches stats/consume): a pre-v0.24.1 worker deep
  // in a long job must not be dropped from the rotation for going quiet.
  const busy = sched._busySet(now);
  const active = [...sched.workers.values()].filter((w) => now - w.lastSeen < 90000 || busy.has(w.address));
  if (active.length === 0) return null;
  if (sched.queue.length + sched.pending.size >= 3) return null;
  // Pin each eval to a model its target actually holds — an unservable
  // seed would sit in the queue forever under model-matched dispatch.
  const eligible = active.filter((w) => Array.isArray(w.models) && w.models.length > 0);
  let target = eligible.sort((a, z) => (a.seedsThisEpoch || 0) - (z.seedsThisEpoch || 0))[0];
  let model;
  if (target) {
    target.seedRR = ((target.seedRR ?? -1) + 1) % target.models.length;
    model = target.models[target.seedRR];
  } else {
    // Legacy lane (pre-catalog clients, dev model only): same fairness —
    // least-served target, stamped. Modern workers whose list is empty
    // serve nothing and are never targeted (review finding: the old
    // unstamped fallback re-created fastest-poller-wins in this lane).
    target = active
      .filter((w) => w.legacy === true)
      .sort((a, z) => (a.seedsThisEpoch || 0) - (z.seedsThisEpoch || 0))[0];
    if (!target) return null;
    model = "dev-tiny";
  }
  target.seedsThisEpoch = (target.seedsThisEpoch || 0) + 1;
  // §17: a CHALLENGE_RATE fraction of seeds carry a generated hidden
  // challenge (never for the dev pipeline model — it can't answer real
  // questions and the legacy lane isn't what challenges police).
  const seed =
    model !== "dev-tiny" && Math.random() < CHALLENGE_RATE
      ? makeChallenge(model)
      : SEED_PROMPTS[Math.floor(Math.random() * SEED_PROMPTS.length)];
  return sched.enqueue({ ...seed, model, forWorker: target.address });
}

function startAutoOps(sched, { seedMs = 45000, epochMs = 15 * 60 * 1000 } = {}) {
  const seed = setInterval(() => {
    seedOnce(sched);
    // §17 paid-path audit cadence: a small chance per seed tick, so a
    // mystery chat lands somewhere on the network every ~10 minutes.
    const rateRaw = Number(process.env.KAI_MYSTERY_RATE);
    const rate = Number.isFinite(rateRaw) && rateRaw >= 0 ? rateRaw : 0.08;
    if (Math.random() < rate) seedMysteryOnce(sched);
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

module.exports = { Scheduler, merkleRoot, merkleProof, startAutoOps, seedOnce, seedMysteryOnce, makeChallenge, challengeTier, MODEL_RATES };

if (require.main === module) {
  const s = new Scheduler({
    operatorSecret: process.env.KAI_OPERATOR_SECRET,
    onEvent: (e) => console.log(`[scheduler] ${e.type}`, e.worker ?? e.root ?? ""),
  });
  s.listen(Number(process.env.PORT || 41200), process.env.HOST || "127.0.0.1").then((p) =>
    console.log(`[scheduler] listening on ${p}`)
  );
}
