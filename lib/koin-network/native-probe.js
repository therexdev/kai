"use strict";
const crypto = require("node:crypto"), N = require("./native-chat"), R = require("./native-replay"), Q = require("./native-qualification"), M = require("./managed-protocol");
// Exactly two synthetic inference POSTs. No connector, shell or real tool runs.
async function probe({ model, key, maxOutput, fetchImpl = fetch, clock = Date.now }) {
  const route = M.find(model);
  if (!route || !key || !Number.isSafeInteger(maxOutput) || maxOutput < 512 || maxOutput > Math.min(8192, route.maxOutputTokens)) throw Error("Invalid qualification limits");
  const nonce = crypto.randomBytes(16).toString("hex"), scope = { domain: "shadow:native-qualification", owner: "operator-synthetic-probe", model: route.upstream };
  const definitions = [{ type: "function", function: { name: "native_probe", description: "Read a synthetic test nonce. Call once; after the result, answer with that nonce only.",
    parameters: { type: "object", properties: { value: { type: "string", enum: ["kai_probe"] } }, required: ["value"], additionalProperties: false } } }];
  const history = [{ role: "user", content: "Call native_probe once with value kai_probe. After receiving the result, return its nonce exactly, without calling again." }];
  const usage = [];
  async function request() {
    const messages = N.encode(history, definitions), quote = M.quote(scope.domain, model, messages, maxOutput, clock());
    const upstream = N.upstream(messages, (token, message) => R.open(token, message, scope, key, clock()));
    const response = await fetchImpl(Q.ORIGIN + "/chat/completions", { method: "POST", redirect: "error", signal: AbortSignal.timeout(180000),
      headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ model: route.upstream, ...upstream, max_completion_tokens: maxOutput, stream: false }) });
    if (!response.ok) throw Error("Qualification HTTP failure");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 2000000) throw Error("Qualification response too large"); chunks.push(chunk); }
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")), u = raw.usage, c = raw.choices?.[0];
    if (!u || !Number.isSafeInteger(u.prompt_tokens) || u.prompt_tokens < 1 || u.prompt_tokens > quote.inputTokens ||
        !Number.isSafeInteger(u.completion_tokens) || u.completion_tokens < 1 || u.completion_tokens > maxOutput ||
        u.total_tokens !== u.prompt_tokens + u.completion_tokens || !Array.isArray(raw.choices) || raw.choices.length !== 1) throw Error("Qualification usage invalid");
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    if (!Number.isSafeInteger(cached) || cached < 0 || cached > u.prompt_tokens) throw Error("Qualification cache usage invalid");
    usage.push({ input: u.prompt_tokens, output: u.completion_tokens });
    const replay = R.seal(c.message, scope, key, clock());
    return N.unpackAnswer(N.packAnswer({ ...c.message, ...(replay ? { kai_replay: replay } : {}) }, c.finish_reason));
  }
  const first = await request(), call = first.message.tool_calls?.[0];
  if (first.finishReason !== "tool_calls" || first.message.tool_calls?.length !== 1 || call.function.name !== "native_probe") throw Error("Qualification tool call invalid");
  const args = JSON.parse(call.function.arguments);
  if (!args || Object.keys(args).length !== 1 || args.value !== "kai_probe") throw Error("Qualification arguments invalid");
  history.push(first.message, { role: "tool", tool_call_id: call.id, content: JSON.stringify({ nonce }) });
  const last = await request();
  if (last.finishReason !== "stop" || last.message.tool_calls?.length || last.message.content.trim() !== nonce) throw Error("Qualification follow-up invalid");
  return Q.evidence(model, usage, key, clock());
}
module.exports = { probe };
