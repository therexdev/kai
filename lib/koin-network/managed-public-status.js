"use strict";
// Presentation only. Never insert a managed endpoint into the worker registry,
// signed presence, qualification, payout roster or KOIN reward accounting.
function withManagedStatus(status, provider) {
  const p = provider?.snapshot(); if (!p?.ready) return status;
  const models = status.models.map(m => ({ ...m }));
  for (const m of p.models.filter(m => m.ready)) {
    const row = models.find(row => row.model === m.model);
    if (row) row.providers += 1; else models.push({ model: m.model, providers: 1 });
  }
  return { ...status, workersOnline: status.workersOnline + 1, models,
    ...(status.workers ? { workers: [...status.workers, { address: "network-" + p.id, models: p.models.filter(m => m.ready).map(m => m.model), lastSeenSecs: 0, busy: p.state === "serving" }] } : {}) };
}
module.exports = { withManagedStatus };
