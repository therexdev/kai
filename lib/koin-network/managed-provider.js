"use strict";
const fs = require("node:fs"), P = require("./job-protocol"), M = require("./managed-protocol");
const ORIGIN = "https://api.akashml.com/v1";
function secret(env = process.env) {
  if (env.KAI_AKASHML_API_KEY && env.KAI_AKASHML_API_KEY_FILE) throw Error("Choose one AkashML secret source");
  let key = env.KAI_AKASHML_API_KEY;
  if (env.KAI_AKASHML_API_KEY_FILE) {
    const file = env.KAI_AKASHML_API_KEY_FILE, st = fs.lstatSync(file);
    if (!require("node:path").isAbsolute(file) || !st.isFile() || st.isSymbolicLink() || st.size > 4096 || (process.platform !== "win32" && (st.mode & 0o077))) throw Error("AkashML key requires a protected regular file");
    key = fs.readFileSync(file, "utf8").trim();
  }
  if (key !== undefined && (typeof key !== "string" || key.length < 16 || key.length > 4096 || /\s/.test(key))) throw Error("Invalid AkashML secret configuration");
  return key;
}
function price(value) {
  const s = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toFixed(14) : value;
  if (typeof s !== "string" || !/^[0-9]+(?:\.[0-9]{1,14})?$/.test(s)) throw Error("Supplier rate unavailable");
  const [whole, fraction = ""] = s.split(".");
  return String(BigInt(whole) * 100000000000000n + BigInt(fraction.padEnd(14, "0")));
}
async function json(response, maximum) {
  if (!response.ok) throw Object.assign(Error("Network model service is temporarily unavailable"), { status: response.status });
  let size = 0; const parts = [];
  for await (const part of response.body) { size += part.length; if (size > maximum) throw Error("Supplier response exceeds limit"); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
class ManagedProvider {
  #key;
  constructor({ key, verifier, signer, domain, clock = Date.now, fetchImpl = fetch }) {
    this.#key = key; this.verifier = verifier; this.signer = signer; this.domain = domain; this.clock = clock; this.fetch = fetchImpl;
    this.observedAt = 0; this.available = new Map(); this.inflight = new Map(); this.closed = false;
    if (key && (!signer || signer.getAddress() !== verifier)) throw Error("Managed usage signer does not match the deployment verifier");
  }
  get configured() { return !!this.#key; }
  ready(model) { return !this.closed && !this.suspended && this.configured && this.observedAt <= this.clock() && this.clock() - this.observedAt < 60000 && this.available.has(model); }
  snapshot() {
    const models = M.models.map(m => ({ model: m.model, ready: this.ready(m.model), state: this.ready(m.model) ? "online" : "connecting", validUntil: Math.min(this.clock() + 15000, this.observedAt + 60000) }));
    const ready = models.some(m => m.ready);
    return { id: P.hash("public-managed-provider:akashml").slice(0, 12), model: models.filter(m => m.ready).map(m => m.model).join(", "), models,
      ready, state: ready ? (this.inflight.size ? "serving" : "ready") : "connecting", observedAt: this.observedAt,
      validUntil: ready ? Math.min(this.clock() + 15000, this.observedAt + 60000) : this.clock() + 15000 };
  }
  async refresh() {
    if (!this.configured || this.closed || this.suspended) return;
    try {
      const value = await json(await this.fetch(ORIGIN + "/models", { method: "GET", redirect: "error", headers: { authorization: "Bearer " + this.#key }, signal: AbortSignal.timeout(10000) }), 2000000);
      if (!Array.isArray(value.data)) throw Error("Supplier model catalog unavailable");
      const next = new Map();
      for (const model of M.models) {
        const rows = value.data.filter(row => row.id === model.upstream);
        if (rows.length !== 1) continue;
        try {
          const row = rows[0], p = row.pricing;
          if (!p || (p.request !== undefined && price(p.request) !== "0")) continue;
          const discount = row.discount_to_user ?? 0;
          if (!Number.isFinite(discount) || discount < 0 || discount > 1 || Math.abs(discount * 10000 - Math.round(discount * 10000)) > 1e-6) continue;
          next.set(model.model, M.rates(model.model, { input: price(p.input), output: price(p.output),
            cache: price(p.input_cache_read ?? p.input), discountBps: Math.round(discount * 10000) }));
        } catch { /* Missing or increased pricing disables only this model. */ }
      }
      this.available = next; this.observedAt = this.clock();
    } catch { this.available.clear(); this.observedAt = 0; }
  }
  start() { if (!this.configured || this.timer) return; this.refresh(); this.timer = setInterval(() => { if (!this.refreshing) { this.refreshing = this.refresh().finally(() => { this.refreshing = null; }); } }, 30000); this.timer.unref(); }
  cancel(id) { this.inflight.get(id)?.abort(); }
  async execute(ledger, id, messages) {
    if (this.inflight.has(id)) return;
    const pending = ledger.job(id), model = M.find(pending?.quote?.tariff?.model);
    if (!model || pending.state !== "queued" || !this.ready(model.model)) throw Error("This network model is currently unavailable");
    const controller = new AbortController(); this.inflight.set(id, controller);
    const rate = structuredClone(this.available.get(model.model));
    try {
      const job = ledger.dispatchManaged(id, this.verifier);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, job.deadline - this.clock()))]);
      // A generation POST is never automatically retried. One durable KAI
      // request ID starts at most one upstream attempt, including after restart.
      const response = await this.fetch(ORIGIN + "/chat/completions", { method: "POST", redirect: "error", signal,
        headers: { authorization: "Bearer " + this.#key, "content-type": "application/json" },
        body: JSON.stringify({ model: model.upstream, messages, max_completion_tokens: job.quote.maxOutput, stream: false }) });
      const value = await json(response, 2000000); signal.throwIfAborted();
      const output = value.choices?.[0]?.message?.content, finishReason = value.choices?.[0]?.finish_reason;
      if (typeof output !== "string" || !output.trim() || !["stop", "length"].includes(finishReason) || value.choices[0].message.tool_calls?.length) throw Error("Supplier did not return a complete text response");
      const u = value.usage, inputTokens = P.integer(u?.prompt_tokens, 1, job.quote.inputTokens), outputTokens = P.integer(u?.completion_tokens, 1, job.quote.maxOutput);
      if (u.total_tokens !== inputTokens + outputTokens) throw Error("Supplier usage is missing or inconsistent");
      const cachedInputTokens = P.integer(u.prompt_tokens_details?.cached_tokens ?? 0, 0, inputTokens);
      const usage = M.usage(job.quote, { inputTokens, outputTokens, cachedInputTokens, rates: rate,
        amount: M.amount(model.model, inputTokens, outputTokens, cachedInputTokens, rate) });
      const receipt = { product: ledger.product, job: id, owner: job.owner, provider: this.verifier, attempt: job.attempt, quoteHash: job.quote.hash,
        outputHash: P.hash(output), dispatchedAt: job.dispatchedAt, completedAt: this.clock(), usage,
        managed: { schema: 1, provider: "akashml", rewardsEligible: false, model: model.upstream, finishReason,
          inferenceId: String(response.headers.get("Inference-Id") || value.id || "").slice(0, 200) } };
      receipt.signature = Buffer.from(await this.signer.signHash(M.receiptHash(this.domain, receipt))).toString("base64");
      signal.throwIfAborted(); ledger.completeManaged(id, output, receipt);
    } catch (error) {
      if ([401, 402, 403].includes(error.status)) { this.suspended = true; this.available.clear(); this.observedAt = 0; }
      else if ([429, 500, 502, 503, 504, 529].includes(error.status)) this.available.delete(model.model);
      ledger.cancel(id, pending.owner, "managed_request_failed");
      // Never expose upstream response bodies, API credentials or prompts.
      throw Error("This network model could not complete the request. No credits were charged; please try again later.");
    } finally { this.inflight.delete(id); }
  }
  close() { this.closed = true; clearInterval(this.timer); for (const controller of this.inflight.values()) controller.abort(); this.available.clear(); this.#key = undefined; }
}
class ManagedMeter {
  constructor(base) { this.base = base; this.policyHash = base.policyHash; this.catalogPolicyHash = base.catalogPolicyHash; this.managedCatalog = true; }
  forModel(model) { return M.find(model) ? { policyHash: M.policyHash } : this.base.forModel ? this.base.forModel(model) : this.base; }
  catalogMeter(hash) { return require("./additive-catalog").catalogMeter(this.base, hash); }
  tariffs() { return [...this.base.tariffs(), ...M.models.map(m => M.tariff(m.model))]; }
  entry(model, version) { return M.find(model) ? { tariff: M.tariff(model), render: messages => JSON.stringify(P.messages(messages)) } : this.base.entry(model, version); }
  quote(domain, model, version, messages, maxOutput, at) { if (M.find(model)) { if (version !== 1) throw Error("Unknown managed version"); return M.quote(domain, model, messages, maxOutput, at); } return this.base.quote(domain, model, version, messages, maxOutput, at); }
  measure(q, output) { if (M.find(q.tariff.model)) throw Error("Managed models require authoritative upstream usage"); return this.base.measure(q, output); }
}
module.exports = { ManagedProvider, ManagedMeter, secret, price };
