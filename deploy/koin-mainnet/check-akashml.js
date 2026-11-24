"use strict";
// Operator-only supplier check. No KAI accounts, purchases, provider presence or
// KOIN rewards are created. --inference spends a small amount of Akash credits.
const { Signer } = require("koilib"), crypto = require("node:crypto");
const M = require("../../lib/koin-network/managed-protocol"), { ManagedProvider, secret } = require("../../lib/koin-network/managed-provider");
async function check({ inference = false, env = process.env, fetchImpl = fetch } = {}) {
  const key = secret(env); if (!key) throw Error("Configure KAI_AKASHML_API_KEY_FILE before checking the supplier");
  const signer = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  const provider = new ManagedProvider({ key, signer, verifier: signer.getAddress(), domain: "shadow:akashml-operator-check", fetchImpl });
  const results = [];
  try {
    await provider.refresh();
    for (const m of M.models) {
      const ready = provider.ready(m.model), row = { model: m.model, label: m.label, available: ready };
      if (ready && inference) {
        try {
          const response = await fetchImpl("https://api.akashml.com/v1/chat/completions", { method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
            headers: { authorization: "Bearer " + key, "content-type": "application/json" },
            body: JSON.stringify({ model: m.upstream, messages: [{ role: "user", content: "Reply with the word OK." }], max_completion_tokens: 512, stream: false }) });
          if (!response.ok) throw Error();
          const text = await response.text(); if (Buffer.byteLength(text) > 1048576) throw Error(); const value = JSON.parse(text), u = value.usage;
          if (!value.choices?.[0]?.message?.content?.trim() || !Number.isSafeInteger(u?.prompt_tokens) || !Number.isSafeInteger(u?.completion_tokens) || u.total_tokens !== u.prompt_tokens + u.completion_tokens) throw Error();
          row.inference = "passed"; row.inputTokens = u.prompt_tokens; row.outputTokens = u.completion_tokens;
        } catch { row.inference = "failed"; }
      }
      results.push(row);
    }
    return { supplier: "akashml", configured: true, inferenceTested: inference, ok: results.every(r => r.available && (!inference || r.inference === "passed")), models: results };
  } finally { provider.close(); }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== "--inference") throw Error("Usage: node check-akashml.js [--inference]");
  check({ inference: args[0] === "--inference" }).then(report => { console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; })
    .catch(() => { console.error("AkashML configuration or supplier check failed. No credentials were printed."); process.exitCode = 1; });
}
module.exports = { check };
