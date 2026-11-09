"use strict";
const { DAY } = require("./policy");
const stamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function currentEpoch(runtime, now = runtime.clock()) {
  const epoch = String(Math.floor(now / DAY)), ledger = runtime.scheduler?.koinShadow?.ledger;
  const budget = ledger?.getBudget ? ledger.getBudget(epoch) : ledger?.state?.budgets?.[epoch];
  const day = ledger?.getDayProgress ? ledger.getDayProgress(epoch) : (() => {
    const value = ledger?.state?.days?.[epoch];
    return { present: !!value, intervalCount: value?.intervals?.length || 0, lastIntervalEnd: value?.intervals?.at(-1)?.end };
  })();
  return { epoch, budgetPresent: !!budget, dayPresent: day.present === true, openedAt: stamp(budget?.openedAt),
    intervalCount: day.intervalCount || 0, lastIntervalEnd: stamp(day.lastIntervalEnd) };
}
// Bounded local progress only. This is not payout confirmation, an RPC probe,
// or permission to restart a signer while it waits for chain finality.
function earningHealth(runtime) {
  const now = runtime.clock(), current = currentEpoch(runtime, now), last = stamp(runtime.lastAvailabilitySuccess);
  const reasons = [];
  if (runtime.stopped) reasons.push("stopping");
  if (!current.budgetPresent || !current.dayPresent) reasons.push("awaiting_funded_epoch");
  if (last === null || last > now || now - last > 30000) reasons.push("availability_processing_stale");
  if (runtime.availabilityError && (last === null || runtime.availabilityError.at >= last)) reasons.push("availability_processing_error");
  // The first full minute closes only after its 45-second evidence grace.
  const firstDue = current.openedAt === null ? null : Math.ceil(current.openedAt / 60000) * 60000 + 105001;
  if (current.dayPresent && firstDue !== null && now >= firstDue + 30000 &&
      (current.lastIntervalEnd === null || now - current.lastIntervalEnd > 180000)) reasons.push("earning_intervals_stale");
  return { schema: 1, ready: reasons.length === 0, observedAt: now, lastAvailabilitySuccess: last, currentEpoch: current, reasons };
}
module.exports = { currentEpoch, earningHealth };
