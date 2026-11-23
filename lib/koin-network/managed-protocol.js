"use strict";
// These pins describe a hosted service and its maximum commercial rates, not
// independently verified model weights or a community provider qualification.
const P = require("./job-protocol"), source = require("./managed-models.json");
const models = source.models.map(Object.freeze);
const find = model => models.find(m => m.model === model);
const policyHash = P.hash(JSON.stringify(source));
const canonical = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const marked = (amount, m) => String((BigInt(amount) * BigInt(10000 + m.markupBps) + 9999n) / 10000n);
function tariff(model) {
  const m = find(model); if (!m) throw Error("Unknown managed network model");
  return canonical({ model, version: 1, contextTokens: m.contextTokens, maxOutputTokens: m.maxOutputTokens, maxLatencyMs: 180000,
    modelHash: P.hash("managed-service:" + m.upstream), tokenizerHash: P.hash("upstream-reported-usage-v1:" + m.upstream),
    templateHash: P.hash("openai-chat-messages-v1"), inputAtomsPerMillion: marked(m.input, m), outputAtomsPerMillion: marked(m.output, m) });
}
function rates(model, value) {
  const m = find(model);
  if (!m || !value || Object.keys(value).sort().join() !== "cache,discountBps,input,output") throw Error("Invalid managed rate snapshot");
  for (const k of ["input", "output", "cache"]) {
    if (typeof value[k] !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value[k]) || BigInt(value[k]) > BigInt(k === "cache" ? m.input : m[k])) throw Error("Supplier price exceeds approved maximum");
  }
  if (BigInt(value.cache) > BigInt(value.input)) throw Error("Invalid cached-input price");
  P.integer(value.discountBps, 0, 10000);
  return { input: value.input, output: value.output, cache: value.cache, discountBps: value.discountBps };
}
function amount(model, input, output, cached, snapshot) {
  const m = find(model), r = rates(model, snapshot);
  P.integer(input, 1); P.integer(output, 1); P.integer(cached, 0, input);
  const cost = BigInt(input - cached) * BigInt(r.input) + BigInt(cached) * BigInt(r.cache) + BigInt(output) * BigInt(r.output);
  const divisor = 1000000n * 10000n * 10000n;
  return String((cost * BigInt(10000 + m.markupBps) * BigInt(10000 - r.discountBps) + divisor - 1n) / divisor);
}
function ceiling(model, input, output) { const m = find(model); return amount(model, input, output, 0, { input: m.input, output: m.output, cache: m.cache, discountBps: 0 }); }
function quote(domain, model, messages, maxOutput, at) {
  const m = find(model), t = tariff(model), clean = P.messages(messages), prompt = JSON.stringify(clean);
  P.integer(maxOutput, 1, m.maxOutputTokens); P.integer(at);
  // A deliberately conservative reservation estimate, NOT a billed token count.
  // The upstream authoritative count must fit it; an overrun is never charged.
  const inputTokens = Buffer.byteLength(prompt) + clean.length * 256 + 1024;
  if (inputTokens + maxOutput > m.contextTokens) throw Error("Context limit exceeded");
  const q = { schema: 2, mode: "shadow", domain, policyHash, tariff: t, requestHash: P.hash(prompt), promptHash: P.hash(prompt),
    inputIdsHash: P.hash("upstream-usage-reservation:" + prompt), inputTokens, maxOutput,
    maxCharge: ceiling(model, inputTokens, maxOutput), at, expires: at + 300000 };
  return { ...q, hash: P.hash(JSON.stringify(q)) };
}
function verifyQuote(q) {
  const m = find(q?.tariff?.model); if (!m) throw Error("Unknown managed model quote");
  P.validateQuote(q);
  if (q.policyHash !== policyHash || JSON.stringify(q.tariff) !== JSON.stringify(tariff(m.model)) || q.maxCharge !== ceiling(m.model, q.inputTokens, q.maxOutput)) throw Error("Managed price commitment changed");
  return q;
}
function usage(q, value) {
  verifyQuote(q);
  if (!value || Object.keys(value).sort().join() !== "amount,cachedInputTokens,inputTokens,outputTokens,rates") throw Error("Invalid managed usage");
  P.integer(value.inputTokens, 1, q.inputTokens); P.integer(value.outputTokens, 1, q.maxOutput); P.integer(value.cachedInputTokens, 0, value.inputTokens);
  if (value.amount !== amount(q.tariff.model, value.inputTokens, value.outputTokens, value.cachedInputTokens, value.rates) || BigInt(value.amount) > BigInt(q.maxCharge)) throw Error("Managed usage exceeds approved price");
  return value;
}
function receiptHash(domain, receipt) {
  const { signature, ...signed } = receipt;
  return Buffer.from(P.hash(JSON.stringify(["KAI-MANAGED-INFERENCE-RECEIPT-V1", domain, signed])), "hex");
}
function verifyAnswer(result, input, id, config, target, now) {
  const M = module.exports;
  const k = result?.koin, r = k?.receipt, q = k?.quote, output = result?.choices?.[0]?.message?.content;
  const expectedTarget = { ...target, policyHash: M.policyHash }, model = M.find(input.model);
  if (config.deployment.product !== "prepaid-usd-v1" || !model || result?.id !== id || k?.product !== "prepaid-usd-v1" || k.state !== "charged" ||
      (Object.keys(k.target || {}).sort().join() !== Object.keys(expectedTarget).sort().join() || Object.keys(expectedTarget).some(key => k.target[key] !== expectedTarget[key])) || typeof output !== "string" || !output.trim() ||
      r?.product !== k.product || r.job !== id || r.owner !== config.owner || r.provider !== config.deployment.verifier ||
      k.session !== P.hash("prepaid-account:" + config.owner) || r.quoteHash !== q?.hash || r.outputHash !== P.hash(output) || k.receiptHash !== P.hash(JSON.stringify(r)) ||
      r.managed?.schema !== 1 || r.managed.provider !== "akashml" || r.managed.rewardsEligible !== false || r.managed.model !== model.upstream || !["stop", "length"].includes(r.managed.finishReason)) throw Error("The network answer could not be verified");
  M.verifyQuote(q);
  if (q.domain !== target.domain || q.tariff.model !== input.model || q.maxOutput !== input.maxOutput || q.requestHash !== P.hash(JSON.stringify(input.messages)) ||
      JSON.stringify(q) !== JSON.stringify(M.quote(target.domain, input.model, input.messages, input.maxOutput, q.at))) throw Error("The answer differs from the approved credit price");
  P.digest(r.attempt); P.integer(r.dispatchedAt, q.at); P.integer(r.completedAt, r.dispatchedAt, now + 5000);
  if (r.completedAt > r.dispatchedAt + q.tariff.maxLatencyMs) throw Error("Network answer exceeded its approved deadline");
  M.usage(q, r.usage);
  P.signatureMatches(M.receiptHash(target.domain, r), r.signature, config.deployment.verifier);
  const u = r.usage;
  if (result.usage?.prompt_tokens !== u.inputTokens || result.usage.completion_tokens !== u.outputTokens || result.usage.total_tokens !== u.inputTokens + u.outputTokens || result.costUsd !== Number(u.amount) / 1e8) throw Error("Network usage differs from its signed receipt");
  return { id, object: "chat.completion", model: "koinos-network", servedModel: input.model,
    choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: r.managed.finishReason }], usage: result.usage, costUsd: result.costUsd,
    koin: { product: k.product, state: k.state, target: expectedTarget, session: k.session, quote: q, receipt: r, receiptHash: k.receiptHash } };
}

module.exports = { models, find, policyHash, tariff, marked, rates, amount, ceiling, quote, verifyQuote, usage, receiptHash, verifyAnswer };
