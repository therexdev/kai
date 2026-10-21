"use strict";
const P = require("./job-protocol");
const approved = require("../../deploy/koin-mainnet/model-rates.proposal.json");
// Prices are authenticated by the pinned full tariff commitment. Availability
// is a short-lived observation, never a promise that a later request can run.
function modelCatalog({ meter, target, networkOverview, clock = Date.now }) {
  const asOf = P.integer(clock()), tariffs = meter.tariffs();
  if (!tariffs.length || tariffs.length > 64 || new Set(tariffs.map(t => t.model)).size !== tariffs.length || meter.policyHash !== target.policyHash) throw Error("Model catalog differs from the authorized tariff policy");
  const network = networkOverview?.();
  const fresh = network && Number.isSafeInteger(network.observedAt) && Number.isSafeInteger(network.validUntil) &&
    network.observedAt <= asOf && network.observedAt >= asOf - 15000 && network.validUntil > asOf && network.validUntil <= asOf + 15000;
  const validUntil = fresh ? Math.min(asOf + 15000, network.validUntil) : asOf + 15000;
  return { schema: 1, policyHash: meter.policyHash, asOf, validUntil, tariffs,
    models: tariffs.map(tariff => {
      const observation = fresh && network.models?.find(m => m.id === tariff.model);
      const available = observation?.available === true && Number.isSafeInteger(observation.providers) && observation.providers > 0;
      const known = approved.models.find(m => m.model === tariff.model && m.modelHash === tariff.modelHash);
      return { model: tariff.model, label: known?.label || tariff.model, available,
        providers: available ? observation.providers : 0, version: tariff.version, maxOutput: tariff.maxOutputTokens,
        inputCreditsPerMillion: creditRate(tariff.inputAtomsPerMillion), outputCreditsPerMillion: creditRate(tariff.outputAtomsPerMillion),
        freeEligible: observation?.freeEligible === true };
    }) };
}
function creditRate(value) {
  const atoms = BigInt(value), whole = atoms / 100000n, fraction = (atoms % 100000n).toString().padStart(5, "0").replace(/0+$/, "");
  return whole.toString() + (fraction ? "." + fraction : "");
}
module.exports = { modelCatalog };
