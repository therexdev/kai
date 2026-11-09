"use strict";
const { WorkerShadow } = require("./shadow-worker");
const { PresenceCoordinator } = require("./presence-coordinator");

// The coordinator owns every acceptance and write. The HTTP/request thread
// retains only bounded committed projections; it never opens the history DB.
function createWorkerLedger({ storage, identity, audience, providerDevices, clock = Date.now, workerOptions = {} }) {
  if (storage?.mode !== "sqlite-shadow" || identity?.schedulerUrl !== audience)
    throw Error("Verified shadow storage selection and matching audience required");
  const client = new WorkerShadow(storage.directory, {
    ...workerOptions, identity, markerFile: storage.markerFile, clock,
  });
  const coordinator = new PresenceCoordinator({ source: providerDevices, client, audience, clock });
  const storageStatus = () => ({ mode: "sqlite-shadow", ...coordinator.storageStatus() });
  const ledger = {
    get ready() { return client.ready; },
    initialize: options => coordinator.initialize(options),
    storageStatus,
    health: storageStatus,
    close: () => coordinator.close(),
    acceptDelegated: body => coordinator.acceptDelegated(body),
    acceptLegacy: body => coordinator.acceptLegacy(body),
  };
  for (const method of ["getBudget", "getDayProgress", "getAvailability", "getPresence", "getQualification", "listQualifications", "hasQualifiedCapacity", "status"])
    ledger[method] = (...args) => client[method](...args);
  for (const method of ["readBudget", "readDayProgress", "readAvailability", "readQualification", "readQualifications", "readUnsealedEpochs", "readManifest", "getManifestEvidence", "refreshProjection"])
    ledger[method] = (...args) => coordinator.read(method, args);
  ledger.getUnsealedEpochs = ledger.readUnsealedEpochs;
  ledger.manifest = ledger.readManifest;
  for (const method of ["open", "importBudget", "qualify", "expireQualifications", "retireUnmatchedQualifications", "applyQualificationRefresh", "commitWork", "markSealed", "markSealedMany", "tick"])
    ledger[method] = (...args) => coordinator.mutate(method, args);
  return ledger;
}
module.exports = { createWorkerLedger };
