"use strict";
const { rpcDiagnostics } = require("./rpc-provider");
const { safeError } = require("./rpc-transport");
const { runtimeMetrics, sanitizeEventLoopSnapshot, sanitizeProcessTelemetry, rewardCycleObservation } = require("./runtime-metrics");
const version = 4;
const stamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
// Operational reads must remain independent of financial-history scans. Only
// bounded in-memory errors and direct lookups of today's shadow state belong here.
function operatorProgress(runtime) {
  const observedAt = runtime.clock();
  return {
    rewardRuntimeVersion: version, observedAt, busy: runtime.busy === true, stopped: runtime.stopped === true,
    processingStage: typeof runtime.processingStage === "string" ? runtime.processingStage.slice(0, 64) : null,
    processingStartedAt: stamp(runtime.processingStartedAt),
    lastServing: stamp(runtime.lastServing), lastRewardSuccess: stamp(runtime.lastRewardSuccess),
    lastSettlementSuccess: stamp(runtime.lastSuccess),
    lastAvailabilitySuccess: stamp(runtime.lastAvailabilitySuccess), availabilityBusy: runtime.availabilityBusy === true,
    earningHealth: require("./earning-health").earningHealth(runtime),
    rewardStorage: require("./earning-health").rewardStorageStatus(runtime),
    processTelemetry: sanitizeProcessTelemetry({ ...(runtime.processMetrics || runtimeMetrics).snapshot(),
      qualificationModelCount: runtime.qualifier?.engines instanceof Map ? runtime.qualifier.engines.size : runtime.qualifier?.policy ? 1 : null }),
    lastRewardCycle: rewardCycleObservation(runtime.rewardCycleObservation,
      runtime.rewardCycleObservation?.observedAt, runtime.rewardCycleObservation?.openCurrentDay),
    currentEpoch: require("./earning-health").currentEpoch(runtime, observedAt),
    errors: (Array.isArray(runtime.errors) ? runtime.errors : []).slice(-20).map(error => ({
      at: stamp(error?.at), stage: typeof error?.stage === "string" ? error.stage.slice(0, 64) : null,
      message: safeError(error?.message || "Unknown processing error").replace(/[A-Za-z0-9_+/=-]{40,}/g, "[redacted]"),
      rpc: rpcDiagnostics({ rpcDiagnostics: error?.rpc }),
      eventLoop: sanitizeEventLoopSnapshot(error?.eventLoop),
    })),
  };
}
module.exports = { operatorProgress, version };
