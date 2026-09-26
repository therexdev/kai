"use strict";
const { FundedReservations } = require("./funded-reservations");
// Explicitly driven, read-only recovery decisions. The caller supplies a fresh
// observation from the pinned observer. No timer, signing or transport is wired
// to production; a rehearsal driver may simulate the returned action.
class SettlementRecovery {
  #ledger;
  constructor(ledger) {
    if (!(ledger instanceof FundedReservations)) throw Error("Funded settlement ledger required");
    this.#ledger = ledger;
  }
  async step({ id, observationId }) {
    const state = await this.#ledger.recoverSettlement({ id, observationId });
    if (state.action === "done") {
      const next = this.#ledger.prepareNextSettlement(this.#ledger.job(id).session);
      return { ...state, next };
    }
    if (state.action !== "retry_same_transaction") return state;
    return this.#ledger.nextSettlementAttempt({ id, observationId });
  }
}
module.exports = { SettlementRecovery };
