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
const FREE_CONSUME_PER_EPOCH = 5; // free LLM-CU per address per epoch
const CONSUME_SIG_WINDOW_MS = 120000;
const USD_PER_LLMCU = Number(process.env.KAI_USD_PER_CU || 0.003);
const KAI_REF_USD = Number(process.env.KAI_REF_USD || 0.01);
const KAI_PER_CU_SAT = BigInt(Math.round((USD_PER_LLMCU / KAI_REF_USD) * 1e8));
const RECEIPT_KAI_SAT = 100000000n; // provider reward rate (contract: 1 KAI/receipt)
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
    this.consumed = {}; // address -> CU consumed this epoch (§14/§23)
    this.spentSat = {}; // address -> KAI satoshis charged to epoch earnings (§23)
    // KAI credit ledger (§23): funded by on-chain deposits, persisted across
    // restarts. depositHwm is the cumulative deposits_of high-water mark.
    this._creditsPath = path.join(this.dataDir, "credits.json");
    this.credits = {};
    try {
      this.credits = JSON.parse(fs.readFileSync(this._creditsPath, "utf8"));
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

  _saveCredits() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this._creditsPath, JSON.stringify(this.credits, null, 2));
    } catch {
      /* best-effort */
    }
  }

  /** Pull new on-chain deposits into the credit ledger (throttled). */
  async _syncDeposits(address, force = false) {
    if (!this.settlement?.depositsOf) return;
    const last = this._depositSync.get(address) || 0;
    if (!force && Date.now() - last < 30000) return;
    this._depositSync.set(address, Date.now());
    try {
      const total = BigInt(await this.settlement.depositsOf(address));
      const entry = this.credits[address] || { creditSat: "0", depositHwmSat: "0" };
      const hwm = BigInt(entry.depositHwmSat);
      if (total > hwm) {
        entry.creditSat = (BigInt(entry.creditSat) + (total - hwm)).toString();
        entry.depositHwmSat = total.toString();
        this.credits[address] = entry;
        this._saveCredits();
        this.onEvent({ type: "scheduler:credits-funded", address, creditSat: entry.creditSat });
      }
    } catch {
      /* chain read down — credits stay as persisted */
    }
  }

  /** §23 spendable resources for one more CU, in charge order. */
  _consumeCapacity(address) {
    const cost = KAI_PER_CU_SAT;
    const used = this.consumed[address] || 0;
    const freeLeft = Math.max(0, FREE_CONSUME_PER_EPOCH - used);
    const creditSat = BigInt(this.credits[address]?.creditSat ?? "0");
    const servedSat = BigInt(this.receipts.filter((r) => r.honest && r.worker === address).length) * RECEIPT_KAI_SAT;
    const earningsLeft = servedSat - BigInt(this.spentSat[address] || "0");
    return { cost, freeLeft, creditSat, earningsLeft };
  }

  /** Debit one served CU in charge order: free -> credits -> epoch earnings. */
  _chargeConsume(address) {
    const { cost, freeLeft, creditSat } = this._consumeCapacity(address);
    this.consumed[address] = (this.consumed[address] || 0) + 1;
    if (freeLeft > 0) return "free";
    if (creditSat >= cost) {
      this.credits[address].creditSat = (creditSat - cost).toString();
      this._saveCredits();
      return "credits";
    }
    this.spentSat[address] = (BigInt(this.spentSat[address] || "0") + cost).toString();
    return "earnings";
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
      const receipt = {
        jobId: b.jobId,
        worker: w.address,
        outputHash: hash.toString("hex"),
        signature: b.signature,
        challenged: !!job.challenge,
        honest,
        at: new Date().toISOString(),
      };
      this.receipts.push(receipt);
      this._persist();
      const waiter = this._consumers.get(b.jobId);
      if (waiter) {
        this._consumers.delete(b.jobId);
        waiter(String(b.output ?? ""));
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
      if (cap.freeLeft <= 0 && cap.creditSat < cap.cost && cap.earningsLeft < cap.cost) {
        return this._json(res, 402, {
          error: {
            message:
              `Out of network credits: each request costs ${Number(cap.cost) / 1e8} KAI after the ` +
              `${FREE_CONSUME_PER_EPOCH} free per epoch. Deposit KAI in the Earn tab, or Start Earning to cover it with work.`,
            type: "insufficient_quota",
          },
        });
      }
      const job = this.enqueue({ type: "chat", cu: 1, messages: b.messages });
      const output = await new Promise((resolve) => {
        this._consumers.set(job.id, resolve);
        const t = setTimeout(() => {
          this._consumers.delete(job.id);
          resolve(null);
        }, 90000);
        t.unref?.();
      });
      if (output === null) {
        return this._json(res, 504, { error: { message: "no provider answered in time", type: "server_error" } });
      }
      // Debit only what was actually served (§23) — a timeout costs nothing.
      const paidWith = this._chargeConsume(b.address);
      this.onEvent({ type: "scheduler:consumed", address: b.address, count: this.consumed[b.address], paidWith });
      return this._json(res, 200, {
        object: "chat.completion",
        model: "koinos-network",
        choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }],
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
      return this._json(res, 200, {
        ok: true,
        cuClass: "LLM-CU",
        cuPerRequest: 1,
        usdPerCu: USD_PER_LLMCU,
        kaiRefUsd: KAI_REF_USD,
        kaiPerCu: Number(KAI_PER_CU_SAT) / 1e8,
        freeCuPerEpoch: FREE_CONSUME_PER_EPOCH,
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
      const consumedThisEpoch = this.consumed[address] || 0;
      const meter = {
        pendingReceipts,
        consumedThisEpoch,
        freeRemaining: Math.max(0, FREE_CONSUME_PER_EPOCH - consumedThisEpoch),
        creditsKai: (Number(this.credits[address]?.creditSat ?? 0) / 1e8).toString(),
        priceKaiPerRequest: (Number(KAI_PER_CU_SAT) / 1e8).toString(),
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
      consumed: { ...this.consumed },
      spentKai: Object.fromEntries(Object.entries(this.spentSat).map(([a, s]) => [a, (Number(s) / 1e8).toString()])),
      pricing: { usdPerCu: USD_PER_LLMCU, kaiRefUsd: KAI_REF_USD, kaiPerCu: Number(KAI_PER_CU_SAT) / 1e8 },
      freeAllowance: FREE_CONSUME_PER_EPOCH,
      debts,
      claims,
      receipts: this.receipts.length,
    };
    this._persist(summary);
    this.epoch = Math.max(this.epoch + 1, Math.floor(Date.now() / 60000));
    this.receipts = [];
    this.consumed = {};
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
