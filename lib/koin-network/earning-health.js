"use strict";
const { DAY } = require("./policy");
const stamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function rewardStorageStatus(runtime) {
  const ledger = runtime.scheduler?.koinShadow?.ledger;
  const workerMode = typeof ledger?.storageStatus === "function" || typeof ledger?.initialize === "function" || typeof ledger?.health === "function";
  if (!workerMode) return { schema: 1, mode: "legacy-json", ready: runtime.rewardStorageInitialized !== false,
    initialized: runtime.rewardStorageInitialized !== false, worker: null };
  let status = null;
  try { status = ledger.storageStatus ? ledger.storageStatus() : ledger.health?.(); } catch { /* Fail closed without exposing storage internals. */ }
  const worker = status?.worker || (typeof ledger.health === "function" ? status : null);
  const initialized = runtime.rewardStorageInitialized !== false && status?.initialized !== false && status !== null;
  return { schema: 1, mode: "sqlite-shadow", ready: initialized && status?.ready === true && status?.closing !== true, initialized,
    worker: worker ? { state: ["new", "starting", "ready", "closing", "failed", "closed"].includes(worker.state) ? worker.state : null,
      ready: worker.ready === true, projectionAgeMs: stamp(worker.projectionAgeMs), queueDepth: stamp(worker.queueDepth) } : null };
}
function storageReady(runtime) { return rewardStorageStatus(runtime).ready; }
function inspectCurrentEpoch(runtime, now) {
  const epoch = String(Math.floor(now / DAY)), ledger = runtime.scheduler?.koinShadow?.ledger;
  const unavailable = () => ({ available: false, current: { epoch, budgetPresent: null, dayPresent: null,
    openedAt: null, intervalCount: null, lastIntervalEnd: null } });
  if (!storageReady(runtime)) return unavailable();
  try {
    const budget = ledger?.getBudget ? ledger.getBudget(epoch) : ledger?.state?.budgets?.[epoch];
    const day = ledger?.getDayProgress ? ledger.getDayProgress(epoch) : (() => {
      const value = ledger?.state?.days?.[epoch];
      return { present: !!value, intervalCount: value?.intervals?.length || 0, lastIntervalEnd: value?.intervals?.at(-1)?.end };
    })();
    return { available: true, current: { epoch, budgetPresent: !!budget, dayPresent: day.present === true, openedAt: stamp(budget?.openedAt),
      intervalCount: day.intervalCount || 0, lastIntervalEnd: stamp(day.lastIntervalEnd) } };
  } catch { return unavailable(); }
}
function currentEpoch(runtime, now = runtime.clock()) { return inspectCurrentEpoch(runtime, now).current; }
// Bounded local progress only. This is not payout confirmation, an RPC probe,
// or permission to restart a signer while it waits for chain finality.
function earningHealth(runtime) {
  const now = runtime.clock(), { current, available } = inspectCurrentEpoch(runtime, now), last = stamp(runtime.lastAvailabilitySuccess);
  const reasons = [];
  if (runtime.stopped) reasons.push("stopping");
  if (!available) reasons.push("reward_storage_unavailable");
  else if (!current.budgetPresent || !current.dayPresent) reasons.push("awaiting_funded_epoch");
  if (last === null || last > now || now - last > 30000) reasons.push("availability_processing_stale");
  if (runtime.availabilityError && (last === null || runtime.availabilityError.at >= last)) reasons.push("availability_processing_error");
  // The first full minute closes only after its 45-second evidence grace.
  const firstDue = current.openedAt === null ? null : Math.ceil(current.openedAt / 60000) * 60000 + 105001;
  if (current.dayPresent && firstDue !== null && now >= firstDue + 30000 &&
      (current.lastIntervalEnd === null || now - current.lastIntervalEnd > 180000)) reasons.push("earning_intervals_stale");
  return { schema: 1, ready: reasons.length === 0, observedAt: now, lastAvailabilitySuccess: last, currentEpoch: current, reasons };
}
module.exports = { currentEpoch, earningHealth, storageReady, rewardStorageStatus };
