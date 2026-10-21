"use strict";
// Structural configuration validation only. Runtime still loads and verifies
// every tokenizer artifact before a real Meter can serve a request.
const { Meter, digest, integer } = require("./metering");
function entries(config) {
  const multi = config?.models !== undefined;
  if (!config || (multi && (config.tariff !== undefined || config.tokenizer !== undefined))) throw Error("Choose one explicit model configuration format");
  const values = multi ? config.models : [{ tariff: config.tariff, tokenizer: config.tokenizer }];
  if (!Array.isArray(values) || !values.length || values.length > 64) throw Error("A bounded nonempty model catalog is required");
  const seen = new Set(), validated = values.map(value => {
    if (!value || Object.keys(value).sort().join() !== "tariff,tokenizer") throw Error("Each model requires its exact tariff and tokenizer manifest");
    const { tariff, tokenizer } = value;
    if (!tariff || !tokenizer || [".", ".."].includes(tariff.model) || seen.has(tariff.model)) throw Error("Unique model aliases are required");
    seen.add(tariff.model);
    require("./tokenizer").manifestIdentity(tokenizer);
    if (tokenizer.schema !== 1 || tokenizer.mode !== "shadow" || tokenizer.model !== tariff.model || !/^[a-f0-9]{40}$/.test(tokenizer.revision)) throw Error("Pinned model tokenizer manifest required");
    for (const field of ["modelHash", "tokenizerHash", "templateHash"]) if (digest(tokenizer[field]) !== tariff[field]) throw Error("Model tokenizer and tariff pins differ");
    digest(tokenizer.configHash);
    if (config.version !== undefined && tariff.version !== integer(config.version, 1)) throw Error("Model tariff version differs from runtime policy version");
    // This adapter is never exported or used to meter text. Reuse Meter's exact
    // tariff schema, integer limits, pins and canonical field ordering.
    const unavailable = () => { throw Error("Configuration validation cannot meter text"); };
    const meter = new Meter([{ tariff, adapter: { ...tokenizer, input: unavailable, output: unavailable } }]);
    return { tariff: meter.tariffs()[0], tokenizer: structuredClone(tokenizer) };
  });
  return validated.sort((a, b) => {
    const left = `${a.tariff.model}:${a.tariff.version}`, right = `${b.tariff.model}:${b.tariff.version}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
function tariffs(config) { return entries(config).map(entry => entry.tariff); }
function policyHash(config) {
  return require("./metering").hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", ...tariffs(config)]));
}
module.exports = { entries, tariffs, policyHash };
