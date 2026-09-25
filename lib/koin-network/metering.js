"use strict";

// Trusted, in-process adapters only. There is deliberately no worker-supplied
// token count, default tokenizer, fallback tariff or HTTP configuration loader.
const crypto = require("crypto");
const { Signer, utils } = require("koilib");
const { uint } = require("./policy");
const hash = (v) => crypto.createHash("sha256").update(v).digest("hex");
const digest = (v) => {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw Error("Invalid digest");
  return v;
};
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw Error("Invalid integer");
  return v;
};
const address = (v) => {
  if (typeof v !== "string" || !utils.isChecksumAddress(v)) throw Error("Invalid address");
  return v;
};
// Array encodings have a fixed field order; domains cannot sign spending txs.
function authorizeHash(domain, session, job, quoteHash) {
  return Buffer.from(hash(JSON.stringify(["KAI-KOIN-SHADOW-REQUEST-V1", domain,
    digest(session), digest(job), digest(quoteHash)])), "hex");
}
function resultHash(domain, job, attempt, quoteHash, output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 1048576) throw Error("Output too large");
  return Buffer.from(hash(JSON.stringify(["KAI-KOIN-SHADOW-RESULT-V1", domain,
    digest(job), digest(attempt), digest(quoteHash), hash(output)])), "hex");
}
function signatureMatches(bytes, signature, expected) {
  if (typeof signature !== "string" || Buffer.from(signature, "base64").length !== 65 ||
      Buffer.from(signature, "base64").toString("base64") !== signature) throw Error("Invalid signature");
  if (Signer.recoverAddress(bytes, Buffer.from(signature, "base64")) !== expected) throw Error("Signature mismatch");
}
function messages(value) {
  if (!Array.isArray(value) || !value.length || value.length > 256) throw Error("Invalid messages");
  const clean = value.map((m) => {
    if (!m || Object.keys(m).sort().join() !== "content,role" ||
        !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") {
      throw Error("Only literal chat messages are supported");
    }
    return { role: m.role, content: m.content };
  });
  if (Buffer.byteLength(JSON.stringify(clean)) > 1048576) throw Error("Prompt too large");
  return clean;
}
function price(t, input, output) {
  // One ceiling after summing both components, not floating-point arithmetic.
  return uint((BigInt(integer(input)) * uint(t.inputAtomsPerMillion) +
    BigInt(integer(output)) * uint(t.outputAtomsPerMillion) + 999999n) / 1000000n).toString();
}
class Meter {
  #entries = new Map();
  constructor(entries = []) {
    for (const { tariff, adapter } of entries) {
      const t = Object.fromEntries(Object.entries(tariff || {}).sort(([a], [b]) => a.localeCompare(b)));
      if (!t || Object.keys(t).sort().join() !==
          "contextTokens,inputAtomsPerMillion,maxLatencyMs,maxOutputTokens,model,modelHash,outputAtomsPerMillion,templateHash,tokenizerHash,version" ||
          typeof t.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(t.model)) throw Error("Invalid tariff");
      integer(t.version, 1); integer(t.contextTokens, 1, 2000000);
      integer(t.maxOutputTokens, 1, t.contextTokens); integer(t.maxLatencyMs, 1, 3600000);
      for (const k of ["modelHash", "tokenizerHash", "templateHash"]) {
        digest(t[k]);
        if (adapter?.[k] !== t[k]) throw Error("Tokenizer/model/template pin mismatch");
      }
      if (!uint(t.inputAtomsPerMillion) || !uint(t.outputAtomsPerMillion) ||
          typeof adapter.input !== "function" || typeof adapter.output !== "function") throw Error("Unconfigured metering");
      const key = `${t.model}:${t.version}`;
      if (this.#entries.has(key)) throw Error("Duplicate tariff version");
      // Copy method references so replacing an adapter property cannot change a quote.
      this.#entries.set(key, Object.freeze({ tariff: Object.freeze(t), input: adapter.input.bind(adapter), output: adapter.output.bind(adapter) }));
    }
    Object.defineProperty(this, "policyHash", { value: hash(JSON.stringify([
      "KAI-KOIN-SHADOW-TARIFFS-V1", ...[...this.#entries.keys()].sort().map((k) => this.#entries.get(k).tariff),
    ])), enumerable: true });
  }
  entry(model, version) {
    const e = this.#entries.get(`${model}:${version}`);
    if (!e) throw Error("No calibrated tokenizer and tariff for model/version");
    return e;
  }
  quote(domain, model, version, input, maxOutput, at) {
    integer(at);
    const e = this.entry(model, version), t = e.tariff, m = messages(input);
    const inputTokens = integer(e.input(m), 1, t.contextTokens);
    integer(maxOutput, 1, t.maxOutputTokens);
    if (inputTokens + maxOutput > t.contextTokens) throw Error("Context limit exceeded");
    const q = { schema: 1, mode: "shadow", domain, policyHash: this.policyHash, tariff: t,
      requestHash: hash(JSON.stringify(m)), inputTokens, maxOutput,
      maxCharge: price(t, inputTokens, maxOutput), at, expires: integer(at + 300000) };
    return { ...q, hash: hash(JSON.stringify(q)) };
  }
  measure(q, output) {
    const e = this.entry(q.tariff.model, q.tariff.version);
    if (JSON.stringify(e.tariff) !== JSON.stringify(q.tariff)) throw Error("Tariff changed");
    if (typeof output !== "string" || !output.length || Buffer.byteLength(output) > 1048576) throw Error("Invalid output");
    const outputTokens = integer(e.output(output), 1, q.maxOutput);
    return { inputTokens: q.inputTokens, outputTokens, amount: price(q.tariff, q.inputTokens, outputTokens) };
  }
}
module.exports = { Meter, authorizeHash, resultHash, signatureMatches, hash, digest, integer, address, messages, price };
