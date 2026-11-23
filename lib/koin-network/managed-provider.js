"use strict";
const fs = require("node:fs"), P = require("./job-protocol"), M = require("./managed-protocol");
const Diagnostics = require("./inference-diagnostics");
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
async function json(response, maximum, diagnostics) {
  if (!response.ok) {
    if (diagnostics) {
      diagnostics.upstreamCategory = await Diagnostics.httpCategory(response);
      throw Object.assign(Diagnostics.error("upstream_http"), { status: response.status });
    }
    throw Object.assign(Error("Network model service is temporarily unavailable"), { status: response.status });
  }
  let size = 0; const parts = [];
  for await (const part of response.body) {
    size += part.length; if (diagnostics) diagnostics.responseBytes = size;
    if (size > maximum) throw diagnostics ? Diagnostics.error("response_too_large") : Error("Supplier response exceeds limit"); parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { throw diagnostics ? Diagnostics.error("invalid_json") : Error("Invalid supplier JSON"); }
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
    if (!model || pending.state !== "queued" || !this.ready(model.model)) throw Diagnostics.error("unavailable", { stage: "availability", requestId: id });
    const controller = new AbortController(); this.inflight.set(id, controller);
    const rate = structuredClone(this.available.get(model.model));
    const started = this.clock(), diagnostics = { requestId: id, messageCount: messages.length, reservedInputTokens: pending.quote.inputTokens,
      requestedOutputTokens: pending.quote.maxOutput, allowedContextTokens: model.contextTokens };
    let stage = "dispatch", signal;
    try {
      const job = ledger.dispatchManaged(id, this.verifier);
      signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, job.deadline - this.clock()))]);
      // A generation POST is never automatically retried. One durable KAI
      // request ID starts at most one upstream attempt, including after restart.
      const body = JSON.stringify({ model: model.upstream, messages, max_completion_tokens: job.quote.maxOutput, stream: false });
      diagnostics.requestBytes = Buffer.byteLength(body); stage = "request";
      const response = await this.fetch(ORIGIN + "/chat/completions", { method: "POST", redirect: "error", signal,
        headers: { authorization: "Bearer " + this.#key, "content-type": "application/json" },
        body });
      diagnostics.upstreamStatus = response.status;
      diagnostics.upstreamIdHash = Diagnostics.upstreamId(response.headers.get("Inference-Id") || response.headers.get("x-request-id"));
      stage = "response_body";
      const value = await json(response, 2000000, diagnostics); signal.throwIfAborted();
      diagnostics.upstreamIdHash ||= Diagnostics.upstreamId(value?.id);
      Object.assign(diagnostics, Diagnostics.responseShape(value)); stage = "response_validation";
      if (!value || typeof value !== "object") throw Diagnostics.error("invalid_response");
      const output = value.choices?.[0]?.message?.content, finishReason = value.choices?.[0]?.finish_reason;
      if (typeof output !== "string") throw Diagnostics.error("invalid_response");
      if (!output.trim()) throw Diagnostics.error("empty_output");
      if (!["stop", "length"].includes(finishReason)) throw Diagnostics.error("unsupported_finish");
      if (value.choices[0].message.tool_calls?.length) throw Diagnostics.error("unexpected_tool_calls");
      stage = "usage_validation";
      const u = value.usage;
      if (!u || typeof u !== "object") throw Diagnostics.error("missing_usage");
      const count = (value, min, max, code) => { try { return P.integer(value, min, max); } catch { throw Diagnostics.error(code); } };
      const inputTokens = count(u.prompt_tokens, 1, job.quote.inputTokens, "input_usage_out_of_range"), outputTokens = count(u.completion_tokens, 1, job.quote.maxOutput, "output_usage_out_of_range");
      if (u.total_tokens !== inputTokens + outputTokens) throw Diagnostics.error("inconsistent_usage");
      const cachedInputTokens = count(u.prompt_tokens_details?.cached_tokens ?? 0, 0, inputTokens, "cached_usage_out_of_range");
      const usage = M.usage(job.quote, { inputTokens, outputTokens, cachedInputTokens, rates: rate,
        amount: M.amount(model.model, inputTokens, outputTokens, cachedInputTokens, rate) });
      const receipt = { product: ledger.product, job: id, owner: job.owner, provider: this.verifier, attempt: job.attempt, quoteHash: job.quote.hash,
        outputHash: P.hash(output), dispatchedAt: job.dispatchedAt, completedAt: this.clock(), usage,
        managed: { schema: 1, provider: "akashml", rewardsEligible: false, model: model.upstream, finishReason,
          inferenceId: String(response.headers.get("Inference-Id") || value.id || "").slice(0, 200) } };
      stage = "receipt_signing";
      receipt.signature = Buffer.from(await this.signer.signHash(M.receiptHash(this.domain, receipt))).toString("base64");
      signal.throwIfAborted(); stage = "receipt_validation"; ledger.completeManaged(id, output, receipt);
    } catch (error) {
      const upstreamStatus = error.inferenceFailure ? (error.inferenceFailure.code === "upstream_http" ? diagnostics.upstreamStatus : undefined) : error.status;
      if ([401, 402, 403].includes(upstreamStatus)) { this.suspended = true; this.available.clear(); this.observedAt = 0; }
      else if ([429, 500, 502, 503, 504, 529].includes(upstreamStatus)) this.available.delete(model.model);
      const fallback = { dispatch: "dispatch_failed", request: "transport_error", response_body: "transport_error", response_validation: "invalid_response",
        usage_validation: "usage_validation_failed", receipt_signing: "receipt_signing_failed", receipt_validation: "receipt_validation_failed" };
      const code = error.inferenceFailure?.code || (signal?.aborted ? (signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled") : fallback[stage] || "internal_error");
      const detail = Diagnostics.clean({ ...diagnostics, code, stage, at: this.clock(), elapsedMs: Math.max(0, this.clock() - started), transportCode: error.cause?.code || error.code });
      ledger.cancel(id, pending.owner, "managed_request_failed", detail);
      // Neither raw errors nor upstream body text cross this boundary.
      throw Diagnostics.fromJob(ledger.job(id, pending.owner)) || Diagnostics.error(code, detail);
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
