"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Signer } = require("koilib");

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
const KAI_REF_USD = Number(process.env.KAI_REF_USD || 0.01);
const RECEIPT_KAI_SAT = 100000000n; // provider reward rate (contract: 1 KAI/receipt)
const FREE_TOKENS_PER_EPOCH = Number(process.env.KAI_FREE_TOKENS || 25000); // §16 bootstrap subsidy
// Model-class token rates in micro-dollars per 1M tokens (illustrative).
const MODEL_RATES = {
  "koinos-fast": { inMicroPerM: 100000, outMicroPerM: 400000 }, // $0.10 / $0.40 per 1M
};
const DEFAULT_MODEL_CLASS = "koinos-fast";
const SAT_PER_MICRO = BigInt(Math.round(1e8 / (KAI_REF_USD * 1e6))); // KAI satoshis per µ$
const MICRO_PER_KAI = BigInt(Math.round(KAI_REF_USD * 1e6)); // µ$ per 1 KAI at reference

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
  constructor({ dataDir, operatorSecret, chain, settlement, epoch, leaseMs, onEvent } = {}) {
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
    this.server = null;
  }

  enqueue(job) {
    const id = "job_" + crypto.randomBytes(8).toString("hex");
    const full = {
      id,
      type: job.type || "inference-eval",
      model: job.model || "dev-tiny",
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
    const w = this.waiters.shift();
    if (w) w.fire();
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
      entry.balanceMicro = ((BigInt(entry.creditSat) * MICRO_PER_KAI) / 100000000n).toString();
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
        const newMicro = ((total - hwm) * MICRO_PER_KAI) / 100000000n;
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
  _consumeCapacity(address) {
    const freeTokensLeft = Math.max(0, FREE_TOKENS_PER_EPOCH - (this.freeUsed[address] || 0));
    const balanceMicro = this._balanceMicroOf(address);
    const servedSat = BigInt(this.receipts.filter((r) => r.honest && r.worker === address).length) * RECEIPT_KAI_SAT;
    const earningsLeftSat = servedSat - BigInt(this.spentSat[address] || "0");
    return { freeTokensLeft, balanceMicro, earningsLeftSat };
  }

  /** Bill ACTUAL usage after completion: free tokens first, then the prepaid
   *  USD balance, then current-epoch earnings valued at the reference price. */
  _chargeUsage(address, usage) {
    const inTok = Math.max(0, Number(usage?.prompt_tokens ?? 0));
    const outTok = Math.max(0, Number(usage?.completion_tokens ?? 0));
    const totalTok = inTok + outTok;
    this.consumed[address] = (this.consumed[address] || 0) + 1;
    const u = (this.usage[address] ||= { inTok: 0, outTok: 0, costMicro: 0 });
    u.inTok += inTok;
    u.outTok += outTok;

    const freeLeft = Math.max(0, FREE_TOKENS_PER_EPOCH - (this.freeUsed[address] || 0));
    const freeTaken = Math.min(freeLeft, totalTok);
    this.freeUsed[address] = (this.freeUsed[address] || 0) + freeTaken;
    const billableFraction = totalTok > 0 ? (totalTok - freeTaken) / totalTok : 0;
    const costMicro = BigInt(Math.ceil(usageCostMicro(usage) * billableFraction));
    u.costMicro += Number(costMicro);
    if (costMicro <= 0n) return { paidWith: "free", costMicro: 0n };

    const balance = this._balanceMicroOf(address);
    const fromBalance = balance < costMicro ? balance : costMicro;
    if (fromBalance > 0n) {
      this.balances[address].balanceMicro = (balance - fromBalance).toString();
      this._saveBalances();
    }
    const remainderMicro = costMicro - fromBalance;
    if (remainderMicro > 0n) {
      this.spentSat[address] = (BigInt(this.spentSat[address] || "0") + remainderMicro * SAT_PER_MICRO).toString();
    }
    return { paidWith: fromBalance > 0n ? (remainderMicro > 0n ? "balance+earnings" : "balance") : "earnings", costMicro };
  }

  /** Requeue dispatched jobs whose worker went silent past the lease. */
  _reapPending() {
    const now = Date.now();
    for (const [id, job] of this.pending) {
      if (now - (job.dispatchedAt ?? now) < this.leaseMs) continue;
      this.pending.delete(id);
      const { worker, dispatchedAt, ...fresh } = job;
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
    const token = new URL(req.url, "http://x").searchParams.get("token");
    return token && this.workers.has(token) ? { token, ...this.workers.get(token) } : null;
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    this._reapPending();

    if (url.pathname === "/worker/register" && req.method === "POST") {
      const b = await this._body(req);
      if (!b.address) return this._json(res, 400, { ok: false, error: "address required" });
      const token = "wt_" + crypto.randomBytes(16).toString("hex");
      this.workers.set(token, { address: b.address, capabilities: b.capabilities || {}, lastSeen: Date.now() });
      this.onEvent({ type: "scheduler:worker-registered", address: b.address });
      return this._json(res, 200, { ok: true, token, epoch: this.epoch });
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
        const job = this.queue.shift();
        const dispatchId = ++this._dispatchSeq;
        this.pending.set(job.id, { ...job, worker: w.address, dispatchedAt: Date.now(), dispatchId });
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
      if (this.queue.length > 0) return give();
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
      if (this.queue.length > 0) return give();
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
      const receipt = {
        jobId: b.jobId,
        worker: w.address,
        outputHash: hash.toString("hex"),
        signature: b.signature,
        usage, // provider-reported token counts (audited by challenges later)
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
      const cap = this._consumeCapacity(b.address);
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
      const job = this.enqueue({ type: "chat", cu: 1, messages: b.messages });
      const result = await new Promise((resolve) => {
        this._consumers.set(job.id, resolve);
        const t = setTimeout(() => {
          this._consumers.delete(job.id);
          resolve(null);
        }, 90000);
        t.unref?.();
      });
      if (result === null) {
        return this._json(res, 504, { error: { message: "no provider answered in time", type: "server_error" } });
      }
      // Bill ACTUAL token usage after completion — a timeout costs nothing.
      const { paidWith, costMicro } = this._chargeUsage(b.address, result.usage);
      this.onEvent({ type: "scheduler:consumed", address: b.address, paidWith, costMicro: Number(costMicro) });
      return this._json(res, 200, {
        object: "chat.completion",
        model: "koinos-network",
        // OpenAI-compatible usage block: developers keep their mental model.
        usage: {
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
          total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
        },
        choices: [{ index: 0, message: { role: "assistant", content: result.output }, finish_reason: "stop" }],
      });
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
        models[name] = {
          usdPerMInputTokens: r.inMicroPerM / 1e6,
          usdPerMOutputTokens: r.outMicroPerM / 1e6,
          cuClass: "LLM-CU",
        };
      }
      return this._json(res, 200, {
        ok: true,
        // Four layers: tokens meter usage, CU normalizes provider work,
        // USD makes it legible, KAI settles it (spec amendment A1).
        models,
        kaiRefUsd: KAI_REF_USD,
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
      const pendingReceipts = this.receipts.filter((r) => r.honest && r.worker === address).length;
      const u = this.usage[address] || { inTok: 0, outTok: 0, costMicro: 0 };
      const meter = {
        pendingReceipts,
        requestsThisEpoch: this.consumed[address] || 0,
        usage: { inputTokens: u.inTok, outputTokens: u.outTok, costUsd: (u.costMicro / 1e6).toFixed(6) },
        freeTokensRemaining: Math.max(0, FREE_TOKENS_PER_EPOCH - (this.freeUsed[address] || 0)),
        balanceUsd: (Number(this._balanceMicroOf(address)) / 1e6).toFixed(6),
        kaiRefUsd: KAI_REF_USD,
        spentThisEpochKai: (Number(this.spentSat[address] ?? 0) / 1e8).toString(),
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

  /** Epoch close (§15/§20/§23): claims are built on NET counts — receipts
   *  served minus the receipts consumed against epoch earnings, valued at the
   *  published KAI price (spentSat, rounded up to whole receipts) — as a
   *  Merkle root in the exact shape the KAI contract verifies. Deposits were
   *  already debited at request time and never touch claims. Authorization
   *  precedes execution, so debts only record anomalies. */
  closeEpoch() {
    const served = {};
    for (const r of this.receipts) if (r.honest) served[r.worker] = (served[r.worker] || 0) + 1;

    const net = { ...served };
    const debts = {};
    for (const [address, sat] of Object.entries(this.spentSat)) {
      const billable = Number((BigInt(sat) + RECEIPT_KAI_SAT - 1n) / RECEIPT_KAI_SAT); // ceil
      if (!billable) continue;
      const have = net[address] || 0;
      if (billable >= have) {
        if (billable > have) debts[address] = billable - have;
        delete net[address];
      } else {
        net[address] = have - billable;
      }
    }

    const entries = Object.entries(net).sort(([a], [b]) => a.localeCompare(b));
    const mkLeaves = entries.map(([worker, count]) =>
      crypto.createHash("sha256").update(`${this.epoch}|${worker}|${count}`).digest()
    );
    const claims = {};
    entries.forEach(([worker, count], index) => {
      claims[worker] = { count, index, proof: merkleProof(mkLeaves, index).map((b) => b.toString("hex")) };
    });
    const root = merkleRoot(mkLeaves).toString("hex");
    const summary = {
      epoch: this.epoch,
      root,
      totals: net, // what settles on-chain
      served,
      requests: { ...this.consumed },
      usage: JSON.parse(JSON.stringify(this.usage)),
      spentKai: Object.fromEntries(Object.entries(this.spentSat).map(([a, s]) => [a, (Number(s) / 1e8).toString()])),
      pricing: { models: MODEL_RATES, kaiRefUsd: KAI_REF_USD, freeTokensPerEpoch: FREE_TOKENS_PER_EPOCH },
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
    this.spentSat = {};
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
    sched.enqueue(SEED_PROMPTS[Math.floor(Math.random() * SEED_PROMPTS.length)]);
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

module.exports = { Scheduler, merkleRoot, merkleProof, startAutoOps };

if (require.main === module) {
  const s = new Scheduler({
    operatorSecret: process.env.KAI_OPERATOR_SECRET,
    onEvent: (e) => console.log(`[scheduler] ${e.type}`, e.worker ?? e.root ?? ""),
  });
  s.listen(Number(process.env.PORT || 41200), process.env.HOST || "127.0.0.1").then((p) =>
    console.log(`[scheduler] listening on ${p}`)
  );
}
