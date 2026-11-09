"use strict";
const { DAY } = require("./policy");
const { rpcDiagnostics } = require("./rpc-provider");
const { safeError } = require("./rpc-transport");
const version = 1;
const stamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
// Operational reads must remain independent of financial-history scans. Only
// bounded in-memory errors and direct lookups of today's shadow state belong here.
function operatorProgress(runtime) {
  const observedAt = runtime.clock(), epoch = String(Math.floor(observedAt / DAY));
  const shadow = runtime.scheduler?.koinShadow?.ledger?.state;
  const budget = shadow?.budgets?.[epoch], day = shadow?.days?.[epoch];
  const intervals = Array.isArray(day?.intervals) ? day.intervals : null;
  return {
    rewardRuntimeVersion: version, observedAt, busy: runtime.busy === true, stopped: runtime.stopped === true,
    processingStage: typeof runtime.processingStage === "string" ? runtime.processingStage.slice(0, 64) : null,
    processingStartedAt: stamp(runtime.processingStartedAt),
    lastServing: stamp(runtime.lastServing), lastRewardSuccess: stamp(runtime.lastRewardSuccess),
    lastSettlementSuccess: stamp(runtime.lastSuccess),
    currentEpoch: { epoch, budgetPresent: !!budget, dayPresent: !!day, openedAt: stamp(budget?.openedAt),
      intervalCount: intervals?.length || 0, lastIntervalEnd: stamp(intervals?.at(-1)?.end) },
    errors: (Array.isArray(runtime.errors) ? runtime.errors : []).slice(-20).map(error => ({
      at: stamp(error?.at), stage: typeof error?.stage === "string" ? error.stage.slice(0, 64) : null,
      message: safeError(error?.message || "Unknown processing error").replace(/[A-Za-z0-9_+/=-]{40,}/g, "[redacted]"),
      rpc: rpcDiagnostics({ rpcDiagnostics: error?.rpc }),
    })),
  };
}
module.exports = { operatorProgress, version };
