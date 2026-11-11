"use strict";
const { RewardCycle } = require("./reward-cycle"), { RewardClaims } = require("./reward-claims"), { integer } = require("./job-protocol");

// Only an explicit isolated driver supplies fixture signing and submission.
// prepare must never broadcast. No production timer or wallet integration.
class RewardCycleRunner {
  #cycle; #claims; #prepare; #submit; #timeout; #busy = false; #lastHistorical = null;
  constructor({ mode, cycle, claims = null, prepare, submit, timeoutMs = 5000 }) {
    if (!["isolated-rehearsal", "test-deployment", "mainnet-pilot"].includes(mode) || !(cycle instanceof RewardCycle) || cycle.mode !== mode || typeof prepare !== "function" || typeof submit !== "function")
      throw Error("Explicit isolated cycle dependencies required");
    if (claims && (!(claims instanceof RewardClaims) || claims.sponsor === cycle.sponsor)) throw Error("Separate claim sponsor required");
    this.#cycle = cycle; this.#claims = claims; this.#prepare = prepare; this.#submit = submit; this.#timeout = integer(timeoutMs, 50, 30000);
  }
  async #invoke(callback, value) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => callback(structuredClone(value), { signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("Lifecycle response lost; recover the saved envelope")); }, this.#timeout); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async tick({ openCurrentDay = true, limit = 4 } = {}) {
    if (typeof openCurrentDay !== "boolean") throw Error("Explicit daily opening flag required"); integer(limit, 1, 16);
    if (this.#busy) return { paymentsEnabled: this.#cycle.mode === "mainnet-pilot", busy: true, results: [], handedOff: [] };
    this.#busy = true; const results = [], handedOff = [];
    try {
      if (openCurrentDay) {
        const active = this.#cycle.days(), current = this.#cycle.currentDay();
        if (active.includes(current) || active.length < 32) this.#cycle.queueDay();
        else results.push({ epoch: current, method: "open_epoch", action: "wait", reason: "reward_queue_full" });
      }
      const days = this.#cycle.days(), today = this.#cycle.currentDay();
      // Recover saved nonce ownership first. Prioritize an unsigned opening
      // after that; advance() still enforces its durable cross-process fence.
      const pending = days.filter(epoch => this.#cycle.status(epoch).steps.some(step =>
        step.state === "signing" || (step.txId && !["complete", "observed_external"].includes(step.state))));
      const opening = days.includes(today) && !pending.includes(today) &&
        this.#cycle.status(today).steps[0].state === "queued" ? [today] : [];
      const remaining = days.filter(epoch => !pending.includes(epoch) && !opening.includes(epoch));
      const after = remaining.indexOf(this.#lastHistorical);
      const historical = after < 0 ? remaining : [...remaining.slice(after + 1), ...remaining.slice(0, after + 1)];
      for (const epoch of [...pending, ...opening, ...historical].slice(0, limit)) {
        // Advance the read-work cursor even if an old epoch needs review or
        // throws. Its durable signing/nonce fence is never cleared here.
        if (historical.includes(epoch)) this.#lastHistorical = epoch;
        let d = await this.#cycle.advance(epoch);
        if (d.action === "prepare_cycle") {
          // advance has already committed the cross-process signing fence.
          const transaction = await this.#invoke(this.#prepare, d);
          await this.#cycle.stage(epoch, d.method, transaction);
          d = await this.#cycle.advance(epoch);
        }
        if (d.action === "submit_exact_transaction") {
          const { transaction, ...status } = d;
          try {
            const r = await this.#invoke(this.#submit, transaction);
            const submission = r?.txId === transaction.id ? "acknowledged" : "unknown";
            this.#cycle.recordSubmission(epoch, status.method, transaction.id, { outcome: submission });
            d = { ...status, action: "await_finality", submission };
          } catch (error) {
            this.#cycle.recordSubmission(epoch, status.method, transaction.id, { outcome: "unknown", error });
            d = { ...status, action: "await_finality", submission: "unknown" };
          }
        }
        results.push(d);
      }
      if (this.#claims) for (const epoch of this.#cycle.readyDays()) {
        // Import is idempotent. A crash between these DB commits safely repeats
        // the same manifest instead of losing or duplicating the claim handoff.
        const ids = this.#claims.importManifest(this.#cycle.readyManifest(epoch));
        this.#cycle.markHandedOff(epoch); handedOff.push({ epoch, claims: ids.length });
      }
      return { mode: this.#cycle.mode === "mainnet-pilot" ? "mainnet-pilot" : "isolated-rehearsal", paymentsEnabled: this.#cycle.mode === "mainnet-pilot", results, handedOff };
    } finally { this.#busy = false; }
  }
}
module.exports = { RewardCycleRunner };
