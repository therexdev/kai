"use strict";
const Policy = require("./policy");

// Read-only projection of the same funded budgets, closed intervals and signed
// allocations used by the payout cycle. A status read never advances that cycle.
function rewardSummary(runtime, account) {
  const now = runtime.clock(), epoch = String(Math.floor(now / Policy.DAY));
  const { availability, asOf } = runtime.scheduler.koinShadow.ledger.getAvailability(epoch, account);
  const paidOrSending = new Set(runtime.claims.accountStatus(account).map(r => r.epoch));
  const pending = [];
  for (const e of new Set([...runtime.cycle.days(), ...runtime.cycle.readyDays()])) {
    if (e === epoch || paidOrSending.has(e)) continue;
    const row = runtime.cycle.accountAllocation(e, account);
    if (!row) continue;
    const status = runtime.cycle.status(e), steps = status.steps;
    const observation = runtime.rewardEpochObservations?.get(e);
    const fresh = observation && now >= observation.observedAt && now - observation.observedAt <= 60000;
    const matching = fresh && observation.rootHash === row.rootHash;
    const state = steps.some(s => s.state === "needs_review") || matching && observation.expired ? "needs_review"
      : status.complete ? "finalizing"
      : steps.some(s => s.method === "propose_root" && ["complete", "observed_external"].includes(s.state)) ? "reviewing" : "awaiting_review";
    pending.push({ epoch: e, availability: row.availability, work: row.work, state,
      reviewUntil: matching && observation.reviewUntil > 0 ? observation.reviewUntil : null });
  }
  if (pending.length > 32) throw Error("Reward summary exceeds its bounded window");
  return { schema: 1, account, current: { epoch, closesAt: (Number(epoch) + 1) * Policy.DAY, availability, asOf },
    pending: pending.sort((a, b) => Number(a.epoch) - Number(b.epoch)) };
}
module.exports = { rewardSummary };
