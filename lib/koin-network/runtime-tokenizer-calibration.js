"use strict";
const P = require("./job-protocol"), { manifestIdentity } = require("./tokenizer");

function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error("Explicit loopback llama.cpp endpoint required");
  return url.origin;
}

async function compareRuntime(adapter, manifest, { endpoint, fetchImpl = fetch, clock = Date.now } = {}) {
  manifestIdentity(manifest);
  const origin = localEndpoint(endpoint);
  const observations = [];
  for (const vector of manifest.vectors) {
    const content = vector.messages ? adapter.render(vector.messages, vector.at) : vector.text;
    const expected = adapter.encode(content), expectedHash = P.hash(JSON.stringify(expected));
    // Uses exactly the same llama.cpp tokenizer settings as shadow-worker.
    const response = await fetchImpl(origin + "/tokenize", { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, add_special: false, parse_special: true }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`Runtime tokenizer HTTP ${response.status}`);
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 16000000) throw Error("Runtime tokenizer response too large"); chunks.push(chunk); }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks)); } catch { throw Error("Invalid runtime tokenizer response"); }
    if (!Array.isArray(result.tokens) || result.tokens.length !== expected.length || result.tokens.some(id => !Number.isSafeInteger(id) || id < 0) ||
        P.hash(JSON.stringify(result.tokens)) !== expectedHash || expectedHash !== vector.idsHash) throw Error("Loaded runtime tokenizer does not match the pinned candidate");
    observations.push({ count: expected.length, idsHash: expectedHash, promptHash: P.hash(content), kind: vector.messages ? "messages" : "text" });
  }
  return { schema: 1, model: manifest.model, modelHash: manifest.modelHash, tokenizerHash: manifest.tokenizerHash, templateHash: manifest.templateHash,
    manifestHash: P.hash(JSON.stringify(manifest)), checkedAt: new Date(clock()).toISOString(), vectorsPassed: observations.length,
    observations, runtimeTokenizerVerified: true, serverModelIdentityVerified: false, productionApproved: false,
    caveat: "Exact runtime token IDs match these vectors. This does not prove which model weights the server loaded, model quality, latency, or paid provider admission." };
}
module.exports = { compareRuntime, localEndpoint };
