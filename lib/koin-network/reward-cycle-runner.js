"use strict";
const { RewardCycle } = require("./reward-cycle"), { RewardClaims } = require("./reward-claims"), { integer } = require("./job-protocol");

// Only an explicit isolated driver supplies fixture signing and submission.
// prepare must never broadcast. No production timer or wallet integration.
class RewardCycleRunner {
  #cycle; #claims; #prepare; #submit; #timeout; #busy = false;
  constructor({ mode, cycle, claims = null, prepare, submit, timeoutMs = 5000 }) {
    if (mode !== "isolated-rehearsal" || !(cycle instanceof RewardCycle) || typeof prepare !== "function" || typeof submit !== "function")
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
    if (this.#busy) return { paymentsEnabled: false, busy: true, results: [], handedOff: [] };
    this.#busy = true; const results = [], handedOff = [];
    try {
      if (openCurrentDay) this.#cycle.queueDay();
      for (const epoch of this.#cycle.days().slice(0, limit)) {
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
            d = { ...status, action: "await_finality", submission: r?.txId === transaction.id ? "acknowledged" : "unknown" };
          } catch { d = { ...status, action: "await_finality", submission: "unknown" }; }
        }
        results.push(d);
      }
      if (this.#claims) for (const epoch of this.#cycle.readyDays()) {
        // Import is idempotent. A crash between these DB commits safely repeats
        // the same manifest instead of losing or duplicating the claim handoff.
        const ids = this.#claims.importManifest(this.#cycle.readyManifest(epoch));
        this.#cycle.markHandedOff(epoch); handedOff.push({ epoch, claims: ids.length });
      }
      return { mode: "isolated-rehearsal", paymentsEnabled: false, results, handedOff };
    } finally { this.#busy = false; }
  }
}
module.exports = { RewardCycleRunner };
