"use strict";
const { providerReadiness } = require("./provider-readiness"), { DAY } = require("./policy"), P = require("./job-protocol");
function networkOverview(runtime) {
  const at = runtime.clock(), tariff = runtime.config.tariff, ledger = runtime.scheduler.koinPrepaid.ledger;
  const current = new Map();
  for (const w of runtime.scheduler.workers.values()) if (typeof w.address === "string" && Number.isSafeInteger(w.lastSeen) && w.lastSeen <= at && w.lastSeen >= at - 90000 && (!current.has(w.address) || current.get(w.address).lastSeen < w.lastSeen)) current.set(w.address, w);
  const providers = [...current.values()].slice(0, 256).map(w => {
    const readiness = providerReadiness(runtime, w.address), ready = readiness.state === "online";
    return { id: P.hash("public-provider:" + w.address).slice(0, 12), model: tariff.model, state: ready ? (ledger.busy(w.address) ? "serving" : "ready") : readiness.state,
      ready, observedAt: w.lastSeen, validUntil: readiness.validUntil };
  });
  const jobs = ledger.jobs(), day = Math.floor(at / DAY), completed = jobs.filter(j => j.state === "charged" && Math.floor(j.chargedAt / DAY) === day);
  const serving = runtime.lastServing && runtime.lastServing >= at - 60000;
  const ready = providers.filter(p => p.ready).length;
  return { observedAt: at, validUntil: Math.min(at + 15000, ...providers.filter(p => p.ready).map(p => p.validUntil)), state: serving && ready > 0 ? "available" : "paused",
    providers, readyProviders: ready, waitingRequests: ledger.activeJobs().filter(j => j.state === "queued").length, completedToday: completed.length,
    models: [{ id: tariff.model, providers: ready, available: !!serving && ready > 0, freeEligible: runtime.config.freePolicy?.eligibleModels.includes(tariff.model) === true }],
    activity: completed.slice(-8).reverse().map(j => ({ id: j.id, at: j.chargedAt, kind: "reply-delivered", model: j.quote.tariff.model })) };
}
module.exports = { networkOverview };
