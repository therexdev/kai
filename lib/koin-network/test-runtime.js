"use strict";
const { isPrepaid, isUsd } = require("./product");
const fs = require("fs"), path = require("path"), { utils } = require("koilib");
const { KoinChain } = require("./chain"), { assertPaymentMode, testDomain } = require("./payment-mode");
const { TestSigning } = require("./test-signing"), { TestAccounts } = require("./test-accounts");
const { FundedSessionObserver } = require("./funded-session"), { RewardObserver } = require("./reward-observer");
const { RewardClaims } = require("./reward-claims"), { RewardCycle } = require("./reward-cycle");
const { RewardCycleRunner } = require("./reward-cycle-runner"), { RehearsalSubmitter } = require("./rehearsal-submitter");
const { Meter } = require("./metering"), { loadTokenizer } = require("./tokenizer"), { Scheduler } = require("../scheduler");
const P = require("./job-protocol"), Policy = require("./policy"), M = require("./reward-manifest");
const Transport = require("./rpc-transport");
const encoded = a => utils.encodeBase64url(utils.decodeBase58(a));
class TestRuntime {
  constructor({ config, stateDir, signers, accountsFile, tokenizerDir, qualificationsFile, operatorSecret, client = new KoinChain(config.deployment), clock = Date.now, purchasePrice, accountService }) {
    assertPaymentMode(config.mode, client); this.clock = clock; this.client = client; this.config = config; this.stateDir = stateDir;
    this.qualificationsFile = qualificationsFile; this.signers = signers; this.busy = false; this.stopped = false; this.errors = [];
    this.observations = new Map();
    const prices = require("./purchase-price").purchasePrice({ mode: config.mode, fixture: purchasePrice });
    this.prepaid = isPrepaid(client.d);
    this.hosts = new (require("./test-hosts").TestHosts)(path.join(stateDir, "hosts"), client.d.chainId);
    const target = { chainId: client.d.chainId, credits: client.d.credits, creditsHash: client.d.creditsHash, domain: testDomain(client.d, config.schedulerUrl), policyHash: config.policyHash };
    const adapter = loadTokenizer(tokenizerDir, config.tokenizer), meter = new Meter([{ tariff: config.tariff, adapter }]);
    if (meter.policyHash !== config.policyHash) throw Error("Test tariff commitment mismatch");
    this.target = target; this.observer = new FundedSessionObserver(client.provider, { ...target, token: client.d.token, verifier: client.d.verifier, version: String(config.version), clock });
    const basePolicy = { maxRcPerTransaction: config.maxRcPerTransaction, maxRcPerDay: config.maxRcPerDay, maxAttempts: 3, minRetryMs: 10000 };
    this.settlementPolicy = { ...basePolicy, verifier: client.d.verifier, payer: config.roles.settlement };
    if (config.accountMode === "public" && !accountService) throw Error("Public account service is unavailable");
    const accounts = this.accounts = config.accountMode === "public" ? accountService : new TestAccounts(accountsFile, clock);
    this.scheduler = new Scheduler({ dataDir: path.join(stateDir, "scheduler"), operatorSecret, accounts,
      settlement: null, bootstrapPoolSat: "0", priceSources: [],
      koinShadow: { audience: config.schedulerUrl, clock },
      koinPrepaid: this.prepaid ? { clock, client, target, meter, freePolicy: config.freePolicy, publicAccounts: config.accountMode === "public",
        purchaseQuote: isUsd(client.d) ? async (account, amount) => {
          if (typeof amount !== "string" || amount.length > 20 || !Policy.uint(amount)) throw Error("Positive KOIN amount required");
          const price = await prices.read();
          return require("./purchase-quote").issue({ deployment: client.d, signer: signers[client.d.verifier], account, amount, usdPerKoin: price.usdPerKoin, version: config.version, now: clock() });
        } : null, encryptionKey: require("crypto").createHash("sha256").update("prepaid-answers:" + operatorSecret).digest(),
        qualify: (a, model, modelHash, now) => this.qualified(a, model, modelHash, now), accept: ({ output }) => typeof output === "string" && output.trim().length > 0 } : null,
      koinFundedSessions: this.prepaid ? null : { clock, observer: this.observer, target, meter, settlementPolicy: this.settlementPolicy,
        work: { clock, qualify: (a, model, modelHash, now) => this.qualified(a, model, modelHash, now) },
        accept: ({ output }) => typeof output === "string" && output.trim().length > 0 } });
    this.ledger = (this.scheduler.koinPrepaid || this.scheduler.koinFundedSessions).ledger;
    this.signing = new TestSigning(path.join(stateDir, "signing"), { client, signers, mode: config.mode });
    if (this.prepaid) this.prepaidSettlement = new (require("./prepaid-settlement").PrepaidSettlement)({ client, ledger: this.ledger, signing: this.signing, config, clock });
    this.rewardTarget = { chainId: client.d.chainId, credits: client.d.credits, creditsHash: client.d.creditsHash,
      rewards: client.d.rewards, rewardsHash: client.d.rewardsHash, token: client.d.token, tokenHash: client.d.tokenHash,
      verifier: client.d.verifier, version: String(config.version), workCapBps: 8000, ...(isUsd(client.d) ? { rewardBasis: "usd-pool" } : {}) };
    const rewardObserver = new RewardObserver(client.provider, { target: this.rewardTarget, clock });
    this.claims = new RewardClaims(path.join(stateDir, "claims"), { target: this.rewardTarget, clock,
      preflight: tx => Transport.resourceReadiness(client, tx, "claim"),
      policy: { ...basePolicy, verifier: config.roles.claims, payer: config.roles.claims }, observer: rewardObserver });
    this.cycle = new RewardCycle(path.join(stateDir, "cycle"), { mode: config.mode, target: this.rewardTarget, clock,
      preflight: tx => Transport.resourceReadiness(client, tx),
      policy: { ...basePolicy, verifier: client.d.verifier, payer: config.roles.lifecycle }, budgetPolicy: { dailyBps: 500, availabilityBps: 7000 }, observer: rewardObserver });
    const submit = Transport.submitter(client);
    this.cycleRunner = new RewardCycleRunner({ mode: config.mode, cycle: this.cycle, claims: this.claims, timeoutMs: 30000,
      prepare: (d, { signal }) => Transport.withSignal(signal, () => this.signing.prepare(P.hash(`cycle:${d.epoch}:${d.method}`), { operation: d.operation, owner: d.payer, maxRc: d.maxRc, signers: d.signers })), submit });
    this.submitter = new RehearsalSubmitter({ mode: config.mode, client, settlements: this.prepaid ? null : this.ledger, claims: this.claims,
      timeoutMs: 30000,
      observeSettlement: id => this.observeJob(id),
      prepareClaim: (d, { signal }) => Transport.withSignal(signal, () => this.signing.prepare(P.hash("claim:" + d.id), { operation: d.operation, owner: d.payer, maxRc: d.maxRc })), submit });
  }
  qualifications() {
    if (fs.statSync(this.qualificationsFile).size > 65536) throw Error("Qualification file too large");
    const list = JSON.parse(fs.readFileSync(this.qualificationsFile, "utf8"));
    if (!Array.isArray(list) || list.length > 64) throw Error("Bounded reviewed Test qualifications required");
    return list;
  }
  qualified(address, model, modelHash, now = this.clock()) {
    return this.qualifications().some(q => q.address === address && q.model === model && q.modelHash === modelHash && q.expires > now && q.expires <= now + Policy.DAY);
  }
  async observeJob(id) {
    const h = this.ledger.job(id), key = h.session;
    const prior = this.observations.get(key);
    if (prior) {
      try { const e = await this.observer.verify(prior); if (["verified", "reversible"].includes(e.state)) return prior; } catch {}
      this.observations.delete(key);
    }
    const observed = await this.observer.observe({ id: h.session, owner: h.owner, purpose: "reconciliation" });
    this.observations.set(key, observed.observationId); return observed.observationId;
  }
  async prepareSettlements() {
    for (const h of this.ledger.pendingJobs()) {
      if (h.state === "verified") { this.ledger.prepareNextSettlement(h.session); continue; }
      if (h.state !== "prepared") continue;
      const signingId = P.hash("settlement:" + h.id);
      if (this.signing.status().some(r => r.owner === this.settlementPolicy.verifier && ["signing", "signed"].includes(r.state) && r.id !== signingId)) return;
      const observationId = await this.observeJob(h.id), evidence = await this.observer.verify(observationId);
      if (evidence.state !== "verified") continue;
      const p = this.settlementPolicy, operation = await this.ledger.settlementOperation(h.id);
      const tx = await this.signing.prepare(P.hash("settlement:" + h.id), { operation, owner: p.verifier, payer: p.payer,
        maxRc: p.maxRcPerTransaction, signers: [...new Set([p.verifier, p.payer])] });
      await this.ledger.stageSettlement({ id: h.id, observationId, transaction: tx });
      break;
    }
  }
  async recoverPreparedRewards() {
    // Replay callbacks through the separate durable signing journal. A prior
    // signing fence with missing bytes still blocks; a saved envelope is reused.
    for (const epoch of this.cycle.days()) for (const step of this.cycle.status(epoch).steps) {
      if (step.state !== "signing") continue;
      const owner = this.config.roles.lifecycle, tx = await this.signing.prepare(P.hash(`cycle:${epoch}:${step.method}`), {
        operation: await this.cycle.operation(epoch, step.method), owner, maxRc: this.config.maxRcPerTransaction,
        signers: step.method === "propose_root" ? [owner, this.client.d.verifier] : [owner] });
      await this.cycle.stage(epoch, step.method, tx);
    }
    const id = this.claims.next();
    if (id && this.claims.status(id).state === "signing") {
      const tx = await this.signing.prepare(P.hash("claim:" + id), { operation: await this.claims.operation(id), owner: this.config.roles.claims, maxRc: this.config.maxRcPerTransaction });
      await this.claims.stage(id, tx);
    }
  }
  async collectRewards() {
    const shadow = this.scheduler.koinShadow.ledger, today = Math.floor(this.clock() / Policy.DAY);
    for (const q of this.qualifications()) {
      if (q.expires <= this.clock()) continue;
      const old = shadow.state.qualifications[q.capacityId];
      if (!old || old.benchmarkHash !== q.benchmarkHash || old.expires !== q.expires) shadow.qualify(q);
    }
    for (const epoch of this.cycle.days()) {
      const n = Number(epoch), chain = (await this.client.read("rewards", "get_epoch", { epoch })).epoch;
      if (!chain) continue;
      if (!shadow.state.budgets[epoch]) {
        shadow.state.budgets[epoch] = { epoch: n, openedAt: Number(chain.opened_at), version: Number(chain.version),
          total: chain.budget, availability: chain.availability_budget, work: chain.work_budget };
        shadow.state.days[epoch] = { intervals: [], work: [] }; shadow.save();
      }
      if (n >= today) { shadow.tick(); continue; }
      const file = path.join(this.stateDir, "manifest-" + epoch + ".json");
      if (fs.existsSync(file)) { this.cycle.importManifest(JSON.parse(fs.readFileSync(file, "utf8"))); continue; }
      // Wait for every accepted charge to resolve before sealing a reward day.
      if (this.ledger.pendingJobs().length) continue;
      const work = [], sums = new Map();
      for (const h of this.ledger.settledJobs()) {
        const f = h.finality, blocks = await this.client.provider.getBlocksById([f.blockId], { returnBlock: true, returnReceipt: true });
        const block = blocks.block_items?.find(b => b.block_id === f.blockId);
        if (!block || block.block?.id !== f.blockId || block.block_height !== f.height) throw Error("Missing settled work block");
        if (Math.floor(Number(block.block.header.timestamp) / Policy.DAY) !== n) continue;
        const amount = h.funding?.paidUsed ?? h.receipt.usage.amount;
        work.push({ epoch: n, jobId: h.id, address: h.provider, points: amount, charged: amount, verified: true, finalized: true, free: false, refunded: false });
        sums.set(h.provider, (sums.get(h.provider) || 0n) + BigInt(amount));
      }
      for (const [address, amount] of sums) {
        const actual = await this.client.read("credits", "get_spend", { epoch, account: encoded(address) });
        if (BigInt(actual.amount || "0") !== amount) throw Error("Reward work differs from on-chain paid usage");
      }
      const total = await this.client.read("credits", "get_spend", { epoch });
      if ([...sums.values()].reduce((a, b) => a + b, 0n) !== BigInt(total.amount || "0")) throw Error("Unexplained Test paid work; reward review required");
      const day = shadow.state.days[epoch]; day.work = work; shadow.save();
      const allocation = Policy.allocate({ budget: shadow.state.budgets[epoch], intervals: day.intervals, work, workBasis: this.rewardTarget.rewardBasis });
      const rows = allocation.allocations.filter(a => BigInt(a.availability) + BigInt(a.work) > 0n);
      const tree = M.build(this.rewardTarget, epoch, rows);
      const manifest = { schema: 1, mode: require("./payment-network").rewardMode(this.rewardTarget), target: this.rewardTarget, epoch,
        evidenceHash: P.hash(JSON.stringify({ budget: shadow.state.budgets[epoch], intervals: day.intervals, work })),
        root: tree.root, allocations: tree.claims.map(({ address, availability, work }) => ({ address, availability, work })) };
      const signature = Buffer.from(await this.signers[this.rewardTarget.verifier].signHash(M.signingHash(manifest))).toString("base64");
      const envelope = { manifest, signature }, fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(envelope)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.cycle.importManifest(envelope);
    }
  }
  async tick() {
    if (this.busy || this.stopped) return; this.busy = true;
    try {
      if (this.prepaid) {
        await this.scheduler.koinPrepaid.purchases.tick();
        await this.prepaidSettlement.tick();
      }
      await this.client.verify(); await this.signing.reconcile(); await this.recoverPreparedRewards();
      const ids = this.ledger.pendingJobs().filter(h => h.state === "submitted").slice(0, 16).map(h => h.id);
      await this.submitter.tick({ settlementIds: ids, claimLimit: 4 });
      if (!this.prepaid) await this.prepareSettlements();
      const pool = await this.client.read("rewards", "balances");
      await this.cycleRunner.tick({ openCurrentDay: BigInt(pool.liquid || "0") > BigInt(pool.liabilities || "0") });
      await this.collectRewards(); this.lastSuccess = this.clock();
    } catch (e) { this.errors.push({ at: this.clock(), message: String(e.message).slice(0, 220) }); this.errors = this.errors.slice(-20); }
    finally { this.busy = false; }
  }
  start() {
    if (this.prepaid) { this.lastServing = this.clock(); this.servingTimer = setInterval(() => { try { this.ledger.ping(); this.lastServing = this.clock(); } catch {} }, 5000); this.servingTimer.unref(); }
    this.timer = setInterval(() => this.tick(), 10000); this.timer.unref(); return this.tick(); }
  status() {
    const settled = this.ledger.settledJobs(), charged = settled.reduce((n, h) => n + BigInt(h.receipt.usage.amount), 0n);
    const split = { rewards: 0n, mining: 0n, operations: 0n };
    for (const h of isUsd(this.client.d) ? [] : settled) { const row = Policy.revenueSplit(h.receipt.usage.amount); for (const key of Object.keys(split)) split[key] += BigInt(row[key]); }
    return { product: this.client.d.product || "legacy-reservations", mode: this.config.mode, mainnetPaymentsEnabled: this.config.mode === "mainnet-pilot", automaticPayouts: true,
    chainId: this.client.d.chainId, lastSuccess: this.lastSuccess || null, errors: this.errors,
    pendingJobs: this.ledger.pendingJobs().map(h => ({ id: h.id, state: h.state })),
    cycles: this.cycle.days().map(e => this.cycle.status(e)), signing: this.signing.status(), resources: this.signing.resourceUsage(),
    accounting: { settledRequests: settled.length, chargedAtoms: String(charged), ...(isUsd(this.client.d) ? { unit: "USD-1e-8", purchaseDestination: this.client.d.masterNode } : { unit: "KOIN-1e-8", revenueSplit: Object.fromEntries(Object.entries(split).map(([k, v]) => [k, String(v)])) }),
      inputTokens: settled.reduce((n, h) => n + h.receipt.usage.inputTokens, 0), outputTokens: settled.reduce((n, h) => n + h.receipt.usage.outputTokens, 0),
      tariff: this.config.tariff, hardwareCostMeasured: false },
    qualityPolicy: "Invited providers with reviewed model and benchmark pins; token counts verified. Semantic answer quality is collected during owner testing." }; }
  async close() {
    this.stopped = true; clearInterval(this.timer); clearInterval(this.servingTimer);
    if (this.busy) throw Error("Wait for the active Test settlement pass before closing journals");
    await this.scheduler.close(); this.claims.close(); this.cycle.close(); this.signing.close(); this.hosts.close();
  }
}
module.exports = { TestRuntime };
